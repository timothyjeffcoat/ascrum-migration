#!/usr/bin/env bash
# AC-CTR-02 and the image checks around it. Checks the built images themselves (their config, history and
# every file in them), plus the static pins they are built from:
#   - non-root; no dev dependencies, test files or .env files (AC-CTR-02);
#   - every FROM in docker/*.Dockerfile and every pulled compose image pinned by version and digest
#     (DEV-p5-containers-09);
#   - no secret in any layer's command, build argument, ENV or label: the image history and config are
#     scanned with Gitleaks, and no ENV name looks like a credential (DEV-p5-containers-09);
#   - the API image holds exactly the source files the API loads, they all load (an import smoke test),
#     its CMD is `node api/src/main.ts`, and it actually starts against PostgreSQL and answers /healthz
#     (DEV-p5-containers-05: an image that crashed at start used to pass here).
#
#   docker/check-images.sh <api image> <web image>        (from the repo root)
#
# Needs docker, jq and Gitleaks: $GITLEAKS, or `gitleaks` on the PATH, at the version pinned in
# .github/workflows/secrets.yml (the e2e-compose job installs it the same way). A missing tool fails the
# check; it is never skipped. The start-up check runs its own throwaway PostgreSQL on a private network,
# publishes no port, and removes everything it started.
#
# Exits non-zero and names every finding when a check fails.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <api image> <web image>" >&2
  exit 2
fi
api_image=$1
web_image=$2
findings=0
gitleaks=${GITLEAKS:-gitleaks}
command -v "$gitleaks" > /dev/null || {
  echo "check-images: Gitleaks not found (set GITLEAKS or put gitleaks on the PATH)" >&2
  exit 2
}

fail() {
  echo "check-images FAIL: $*" >&2
  findings=$((findings + 1))
}

# Every path in the image's filesystem, as the container would see it.
files_of() {
  local id
  id=$(docker create "$1")
  docker export "$id" | tar -t
  docker rm "$id" > /dev/null
}

# Non-root: the configured USER, and the uid a container actually gets.
check_user() {
  local image=$1 user uid
  user=$(docker image inspect --format '{{.Config.User}}' "$image")
  case "$user" in
    '' | root | 0 | root:* | 0:*) fail "$image: USER is '${user:-<unset>}', which runs as root" ;;
  esac
  uid=$(docker run --rm --entrypoint id "$image" -u)
  [[ $uid != 0 ]] || fail "$image: a container runs as uid 0"
  echo "$image: USER=$user, runs as uid $uid"
}

# No .env file, and no test file or test folder, anywhere in the image.
check_common() {
  local image=$1 list=$2 hits
  hits=$(grep -E '(^|/)\.env($|[./])' "$list" || true)
  [[ -z $hits ]] || fail "$image: .env files: $hits"
  hits=$(grep -E '\.(test|spec)\.[a-z.]+$|(^|/)(__tests__|tests?)/' "$list" || true)
  [[ -z $hits ]] || fail "$image: test files: $(head -5 <<< "$hits")"
}

work=$(mktemp -d)
# The start-up check's containers and network, removed on every exit, also after a failure.
startup_run="ascrum-check-$$-$RANDOM"
cleanup() {
  docker rm -f "$startup_run-api" "$startup_run-db" > /dev/null 2>&1 || true
  docker network rm "$startup_run-net" > /dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# A pinned reference: name:version@sha256:<64 hex>, the tag holding at least one digit (a version, not
# `latest` or `alpine`). Dependabot moves the tag and the digest together (.github/dependabot.yml).
PINNED='^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9._-]*[0-9][A-Za-z0-9._-]*@sha256:[0-9a-f]{64}$'

# --- Static: every base image and every pulled compose image is pinned ------------------------------
for dockerfile in docker/*.Dockerfile; do
  stages=()
  while read -r image alias; do
    if [[ " ${stages[*]} " == *" $image "* ]]; then
      : # FROM an earlier stage of this file
    elif [[ ! $image =~ $PINNED ]]; then
      fail "$dockerfile: FROM $image is not pinned by version and digest (written out, not through an ARG)"
    fi
    [[ -z $alias ]] || stages+=("$alias")
  done < <(sed -nE 's/^[[:space:]]*FROM[[:space:]]+(--[^[:space:]]+[[:space:]]+)*([^[:space:]]+)([[:space:]]+[Aa][Ss][[:space:]]+([^[:space:]]+))?.*/\2 \4/p' "$dockerfile")
  ((${#stages[@]} > 0)) || fail "$dockerfile: no FROM line found"
done
compose_json=$(docker compose --profile prod-check config --format json)
# Built here (a `build` section), or the image of a service that is built here and never pulled.
built=$(jq -r '[.services[] | select(.build != null) | .image] | unique | .[]' <<< "$compose_json")
while IFS=$'\t' read -r service image pull; do
  if [[ $pull == never ]] && grep -qxF "$image" <<< "$built"; then continue; fi
  [[ $image =~ $PINNED ]] || fail "compose.yaml: service $service uses $image, not pinned by version and digest"
done < <(jq -r '.services | to_entries[] | select(.value.build == null) | [.key, .value.image, (.value.pull_policy // "")] | @tsv' <<< "$compose_json")
echo "pins: every FROM and every pulled compose image is pinned by version and digest"

# The API runs through main.ts, which reads its settings with loadConfig() (and so refuses ALLOW_RESET in
# production mode, DEV-p5-security-16): in the image, and in every compose service that uses the image.
cmd=$(docker image inspect --format '{{json .Config.Cmd}}' "$api_image")
[[ $cmd == '["node","api/src/main.ts"]' ]] || fail "$api_image: CMD is $cmd, not node api/src/main.ts"
overrides=$(jq -r --arg img "$api_image" '.services | to_entries[]
  | select(.value.image == $img and (.value.command != null or .value.entrypoint != null)) | .key' <<< "$compose_json")
[[ -z $overrides ]] || fail "compose.yaml: services that override the API image's command or entrypoint: $(tr '\n' ' ' <<< "$overrides")"

# --- Secrets in layers, build arguments, ENV and labels (both images) ------------------------------
check_secrets() {
  local image=$1 dockerfile=$2 dir base ours names
  dir="$work/secrets-$(tr -c 'a-zA-Z0-9\n' '_' <<< "$image")"
  mkdir -p "$dir"
  # The layers this repo's Dockerfile adds: the image's history minus its base image's (the runtime
  # stage's FROM, pinned above). The base layers are the upstream's: nginx's own history, for one,
  # holds the SHA-512 of its signing key, which Gitleaks' generic rule takes for an API key. Those are
  # for the image scan (wave C); this check is about what we add.
  base=$(sed -nE 's/^[[:space:]]*FROM[[:space:]]+(--[^[:space:]]+[[:space:]]+)*([^[:space:]]+).*/\2/p' "$dockerfile" | tail -1)
  docker image inspect "$base" > /dev/null 2>&1 || docker pull -q "$base" > /dev/null
  docker history --no-trunc --format '{{.CreatedBy}}' "$image" > "$dir/all.txt"
  docker history --no-trunc --format '{{.CreatedBy}}' "$base" > "$work/base.txt"
  ours=$(($(wc -l < "$dir/all.txt") - $(wc -l < "$work/base.txt")))
  if ((ours <= 0)) || ! diff -q <(tail -n +$((ours + 1)) "$dir/all.txt") "$work/base.txt" > /dev/null; then
    fail "$image: its history does not end with the history of $base, so its own layers cannot be told apart"
    return
  fi
  # Every layer's command, as built (RUN lines show the build arguments they saw), and the whole image
  # config: Env, Labels, Cmd, Entrypoint, Healthcheck.
  head -n "$ours" "$dir/all.txt" > "$dir/history.txt"
  rm "$dir/all.txt"
  docker image inspect "$image" > "$dir/inspect.json"
  # Gitleaks' default rules only: no config or ignore file from the environment or the scanned folder.
  if ! (cd "$dir" && env -u GITLEAKS_CONFIG -u GITLEAKS_CONFIG_TOML "$gitleaks" dir --no-banner --redact \
    --verbose --log-level warn --ignore-gitleaks-allow "$dir"); then
    fail "$image: Gitleaks found a secret in the image's own layers or its config (findings above, redacted)"
  fi
  # A credential with too little entropy for Gitleaks still has a telltale name.
  names=$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" | cut -d= -f1 |
    grep -iE 'pass(word|wd)?|secret|token|credential|private|api_?key|access_?key' || true)
  [[ -z $names ]] || fail "$image: ENV names that look like credentials: $(tr '\n' ' ' <<< "$names")"
  echo "$image: no secret in its $ours own history entries or the image config"
}

# --- API ---------------------------------------------------------------------------------------
check_user "$api_image"
check_secrets "$api_image" docker/api.Dockerfile
files_of "$api_image" > "$work/api.txt"
check_common "$api_image" "$work/api.txt"

# Outside node_modules, /app holds exactly what the API runs: an allowlist, so a new kind of file
# (a script, a fixture, a SQL dump) fails here until someone decides it belongs. Which .ts files is
# decided by the import graph below, not by a list of names here.
hits=$(grep -E '^app/.' "$work/api.txt" | grep -v '^app/api/node_modules/' | grep -vE \
  '^app/(api|api/src|api/migrations|web|web/stub)/$|^app/api/package\.json$|^app/api/src/[a-zA-Z]+\.ts$|^app/api/migrations/[0-9]{3}_[a-z0-9_]+\.sql$|^app/web/package\.json$|^app/web/stub/[a-zA-Z]+\.ts$' ||
  true)
[[ -z $hits ]] || fail "$api_image: unexpected files in /app: $hits"

# Import smoke test, in the image as built: Node's loader loads main.ts and everything it imports (a
# missing module fails here exactly as it would at start), and the files it loads are exactly the .ts
# files in /app: none missing, none extra (a test helper or the MSW adapter would be extra).
# A module loaded with import() inside a function is never resolved here; the lint gate forbids import()
# in api/src and web/stub for that reason (DEV-p5-containers-11, web/eslint.config.js SERVER_SOURCE_RULES).
if graph=$(docker run --rm --network none --entrypoint node \
  --mount "type=bind,source=$PWD/docker/api/import-graph.ts,target=/tmp/import-graph.ts,readonly" \
  "$api_image" /tmp/import-graph.ts /app /app/api/src/main.ts 2> "$work/graph.err"); then
  present=$(grep -E '^app/(api/src|web/stub)/[^/]+\.ts$' "$work/api.txt" | sed 's|^app/||' | sort)
  if [[ $graph != "$present" ]]; then
    fail "$api_image: the .ts files in /app differ from what main.ts loads: $(diff <(echo "$graph") <(echo "$present") | grep '^[<>]' | tr '\n' ' ')(< loaded but missing, > present but never loaded)"
  fi
  echo "$api_image: main.ts loads exactly the $(wc -l <<< "$graph") .ts files in /app"
else
  fail "$api_image: loading api/src/main.ts in the image fails: $(tail -5 "$work/graph.err")"
fi

# Start-up: the image with its own defaults (production mode) and only DATABASE_URL set, against a
# throwaway PostgreSQL (the compose db image) on a private network, must become healthy: its HEALTHCHECK
# asks /healthz, which answers 200 only with the database reachable (AC-CTR-03).
check_startup() {
  local image=$1 db_image net="$startup_run-net" db="$startup_run-db" api="$startup_run-api" status deadline
  db_image=$(jq -r '.services.db.image' <<< "$compose_json")
  docker network create --internal "$net" > /dev/null
  # Throwaway values for a database that lives for this check only, on a network with no way out.
  docker run -d --name "$db" --network "$net" -e POSTGRES_USER=check -e POSTGRES_PASSWORD=check \
    -e POSTGRES_DB=check "$db_image" > /dev/null
  # Like compose's service_healthy: wait for the real server on TCP (the image's first-start server
  # listens on its socket only).
  deadline=$((SECONDS + 60))
  until docker exec "$db" pg_isready -q -h 127.0.0.1 -U check -d check; do
    ((SECONDS < deadline)) || { fail "$db_image: PostgreSQL did not start for the start-up check"; return; }
    sleep 1
  done
  docker run -d --name "$api" --network "$net" -e "DATABASE_URL=postgres://check:check@$db:5432/check" \
    "$image" > /dev/null
  deadline=$((SECONDS + 90))
  status=starting
  while ((SECONDS < deadline)); do
    status=$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$api")
    [[ $status == 'running healthy' || $status == exited* || $status == dead* ]] && break
    sleep 1
  done
  if [[ $status == 'running healthy' ]] &&
    docker exec "$api" node -e "fetch('http://127.0.0.1:3000/healthz').then(async (r) => { const b = await r.text(); console.log(r.status, b); process.exit(r.status === 200 && b === '{\"status\":\"ok\"}' ? 0 : 1) }, () => process.exit(1))" > "$work/healthz.txt"; then
    echo "$image: starts with only DATABASE_URL and answers /healthz: $(cat "$work/healthz.txt"); $(docker logs "$api" 2>&1 | grep -m1 'listening' || echo 'no start-up line')"
  else
    fail "$image: does not start and answer /healthz (state: $status). Last log lines: $(docker logs --tail 15 "$api" 2>&1)"
  fi
  docker rm -f "$api" "$db" > /dev/null
  docker network rm "$net" > /dev/null
}
check_startup "$api_image"

# Dev dependencies: none of api/package.json's devDependencies is installed (pnpm keeps every installed
# package as node_modules/.pnpm/<name>@<version>, scoped names with + for /).
while read -r dev; do
  [[ -n $dev ]] || continue
  pattern="^app/api/node_modules/(\.pnpm/${dev//\//\\+}@|${dev}/)"
  ! grep -qE "$pattern" "$work/api.txt" || fail "$api_image: dev dependency $dev is installed"
done < <(jq -r '.devDependencies // {} | keys[]' api/package.json)
# And what is installed is exactly the production tree: pg and the packages pg depends on.
echo "$api_image: installed packages: $(grep -oE '^app/api/node_modules/\.pnpm/[^/]+/$' "$work/api.txt" | sed -E 's|.*/\.pnpm/||; s|/$||' | grep -v '^node_modules$' | sort | tr '\n' ' ')"

# --- web ---------------------------------------------------------------------------------------
check_user "$web_image"
check_secrets "$web_image" docker/web.Dockerfile
files_of "$web_image" > "$work/web.txt"
check_common "$web_image" "$work/web.txt"
# A static build behind nginx: no node_modules at all, so no dependency of any kind.
hits=$(grep -E '(^|/)node_modules/' "$work/web.txt" | head -5 || true)
[[ -z $hits ]] || fail "$web_image: node_modules in the image: $hits"
# The site root holds only build output: no sources, source maps, or the MSW worker (dev only).
hits=$(grep -E '^srv/ascrum/.*(\.tsx?|\.map|\.less|mockServiceWorker\.js)$' "$work/web.txt" || true)
[[ -z $hits ]] || fail "$web_image: sources or dev files in the site root: $hits"

if [[ $findings -gt 0 ]]; then
  echo "check-images: $findings finding(s)" >&2
  exit 1
fi
echo "check-images: AC-CTR-02 (non-root, no dev dependencies, test files or .env), pins, no secrets in layers or config, the API loads and starts"
