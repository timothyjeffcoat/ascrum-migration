#!/usr/bin/env bash
# AC-CTR-02 and the image checks around it. Checks the built images themselves (their config, history and
# every file in them), plus the static pins they are built from:
#   - non-root; no dev dependencies, test files or .env files (AC-CTR-02); the API's installed packages are
#     exactly api/pnpm-lock.yaml's production tree, as pnpm lists it from the lockfile (DEV-p5-image-host-10);
#   - every image docker/*.Dockerfile uses (FROM, COPY --from, RUN --mount from; any keyword case) and
#     every pulled compose image pinned by version and digest (DEV-p5-containers-09, -12); no `# syntax=`
#     frontend; compose builds exactly these two Dockerfiles from the repo root, with no build options
#     (DEV-p5-image-scan-13);
#   - no setuid or setgid file, no file capability and no other extended attribute in either image
#     (DEV-p5-image-scan-12, -14);
#   - what each runtime stage adds to its pinned base, read from the image itself (DEV-p5-image-scan-10):
#     the image sits on the base's layers, its own history is exactly the runtime stage's RUN/COPY/WORKDIR
#     lines, its COPY layers write only under the image's own roots, nothing outside those roots is added or
#     changed except files of the packages the apk line names (checked against apk's own checksums), no
#     package is added, and the base's ENV, PATH and ENTRYPOINT are unchanged;
#   - no secret in any layer's command, build argument, ENV or label: the image history and config are
#     scanned with Gitleaks, no ENV name looks like a credential (DEV-p5-containers-09), and no value
#     holds a URL with a password (DEV-p5-containers-13);
#   - the API image holds exactly the source files the API loads, they all load (an import smoke test),
#     its CMD is `node api/src/main.ts`, and it actually starts against PostgreSQL and answers /healthz
#     (DEV-p5-containers-05: an image that crashed at start used to pass here);
#   - the web image's Alpine packages are at or above their floors, the API image no longer holds apk-tools
#     or Alpine's OpenSSL and zlib, and in both the package sources (apk options in the Dockerfile; /etc/apk
#     and world in the image) are the base image's (p5-image-cves, p5-image-scan: DEV-p5-image-cves-04,
#     -05, -07; Q-p5-image-scan-1 (a)).
#
#   docker/check-images.sh <api image> <web image>        (from the repo root)
#
# Facts about an image's files are read on the host, never from a binary inside the image
# (p5-image-host; DEV-p5-image-scan-15: the image's own `find` could be a wrapper that lies). `docker save`
# hands over the image's config and layer tarballs as data, docker/image-fs.ts (Node, on the host) checks
# their digests against the engine's, parses every tar header (PAX extended attributes and whiteouts
# included) and rebuilds the final filesystem; the file list, modes, attributes, USER's uid, apk's
# database, /etc/apk and the package versions all come from that. Two checks still run the image, because
# running it is what they test: the import smoke test (main.ts must load in the image) and the start-up
# check (it must start and answer /healthz). Neither is trusted for a fact the host can read.
#
# Needs docker, jq, GNU tar, Node 24 and pnpm (the same `node` and `pnpm` the job's setup-web installs) and
# Gitleaks: $GITLEAKS, or `gitleaks` on the PATH, at the version pinned in .github/actions/setup-gitleaks
# (which the e2e-compose and secrets jobs both use). A missing tool fails the check; it is never skipped. The start-up check runs
# its own throwaway PostgreSQL on a private network, publishes no port, and removes everything it started.
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

# Image-derived text (a path, a package name, a USER, the API's log line) reaches these lines; it is
# printed only through log_safe or log_safe_lines (DEV-p5-image-host-05, -13 / sec-09; the rules are in the file).
# shellcheck source=docker/log-safe.sh
source "$(dirname "$0")/log-safe.sh"
fail() {
  echo "check-images FAIL: $(log_safe "$*")" >&2
  findings=$((findings + 1))
}

for tool in docker jq tar node pnpm; do
  command -v "$tool" > /dev/null || {
    echo "check-images: $tool not found" >&2
    exit 2
  }
done
# docker/image-fs.ts runs under Node's type stripping and uses its zstd decompressor: Node 24 (web/.nvmrc).
node_major=$(node -p 'process.versions.node.split(".")[0]')
if ((node_major < 24)); then
  echo "check-images: docker/image-fs.ts needs Node 24 or later; node is $(node --version)" >&2
  exit 2
fi
image_fs() { node docker/image-fs.ts "$@"; }

# The image as data (DEV-p5-image-scan-14, -15): its config and layer tarballs from `docker save`, read by
# docker/image-fs.ts into a model of its final filesystem. The diff_ids the engine reports for the image
# are passed in, and the reader requires the saved config to carry exactly those and every layer to hash
# to its diff_id, so the model is the image the rest of this script inspects and runs. A model that cannot
# be built stops the script: nothing below can be checked without it.
model_of() {
  local image=$1 out=$2 dir ids
  dir=$(mktemp -d "$work/save.XXXXXX")
  ids=$(docker image inspect --format '{{range $i, $l := .RootFS.Layers}}{{if $i}},{{end}}{{$l}}{{end}}' "$image")
  if ! docker save "$image" | tar -x --no-same-owner --no-same-permissions -C "$dir" -f - ||
    ! image_fs read "$dir" "$ids" "$out"; then
    echo "check-images FAIL: $image: could not read the image's layers on the host (above); nothing else can be checked" >&2
    exit 1
  fi
  echo "$image: read on the host from docker save ($(jq '.diffIds | length' "$out") layers, digests checked)"
  rm -rf "$dir"
}

# Non-root: the configured USER, and the uid a container gets for it, which the engine looks up in the
# image's own /etc/passwd. That file is read here from the model, not through the image's `id`.
check_user() {
  local image=$1 model=$2 user uid
  user=$(docker image inspect --format '{{.Config.User}}' "$image")
  case "$user" in
    '' | root | 0 | root:* | 0:*) fail "$image: USER is '${user:-<unset>}', which runs as root" ;;
  esac
  if ! uid=$(image_fs uid "$model" "$user"); then
    fail "$image: could not resolve USER '$user' in its /etc/passwd"
    return
  fi
  [[ $uid != 0 ]] || fail "$image: USER '$user' is uid 0 in the image's /etc/passwd"
  echo "$image: USER=$(log_safe "$user"), which is uid $uid in its /etc/passwd"
}

# No setuid or setgid file anywhere in the image's final filesystem (DEV-p5-image-scan-12: a
# `COPY --chmod=4755` of node ran with euid 0 for the non-root user), no file capability (-14: a setcap'd
# copy from an earlier stage keeps its `security.capability` xattr through COPY and can setuid(0) with no
# setuid bit), and no other extended attribute: neither clean image has any, so the rule is exactly none.
# Read from the tar headers' modes and PAX `SCHILY.xattr.*` records on the host, with whiteouts applied
# (-15: the image's own `find` used to answer this, and a wrapper `find` said "none").
check_special() {
  local image=$1 model=$2
  if findings_of "$image" special "$model"; then
    echo "$image: no setuid or setgid file, no file capability, no extended attribute (tar headers, on the host)"
  fi
}

# Runs an image-fs check: exit 0 is clean, exit 1 prints one finding per line (each one fails here), and
# anything else (the reader's own error, on stderr) fails as "could not check". Returns 0 only when clean.
findings_of() {
  local image=$1 out rc line
  shift
  out=$(image_fs "$@") && rc=0 || rc=$?
  if ((rc == 0)); then
    [[ -z $out ]] || echo "$image: $(log_safe "$out")"
    return 0
  elif ((rc == 1)); then
    while IFS= read -r line; do fail "$image: $line"; done <<< "$out"
  else
    fail "$image: image-fs $1 could not run (exit $rc; its error is above)"
  fi
  return 1
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

# --- Static: every image a Dockerfile uses and every pulled compose image is pinned ---------------
# DEV-p5-containers-12: Dockerfile keywords are case-insensitive (`from node:24` builds), an instruction
# can be split over lines with `\`, and images also come in through `COPY --from=<image>` and
# `RUN --mount=...,from=<image>`, not only through FROM. So each file is read as Docker reads it, one
# logical instruction at a time, and every image reference in it is checked: FROM, COPY/ADD --from= and
# RUN --mount from=. A reference to an earlier stage (by name in any case, or by index) is fine; anything
# else must be pinned. The `# syntax=` parser directive names the frontend image that runs the build; it
# is refused outright (DEV-p5-image-scan-13), and the files use the engine's built-in frontend
# (spec/worklogs/p5-hardening.md). An `# escape=` directive would change the continuation character this
# reader relies on, so it is refused.

# One logical instruction per line, joined exactly as BuildKit's parser joins them
# (frontend/dockerfile/parser/parser.go, checked against this engine in spec/worklogs/p5-image-scan.md,
# session 5): trailing CR/LF trimmed; comment lines (`#` after leading whitespace) and blank lines
# dropped, also inside a continuation; a line ending in a backslash that is not itself escaped
# (`(^|[^\\])\\[ \t]*$`, spaces and tabs allowed after it) continues, and the backslash and those blanks
# are removed with NOTHING put in their place, while the next line keeps its leading whitespace. The
# reader used to insert a space there (DEV-p5-image-scan-11: `COPY <\` + `<USER …` is a heredoc to
# BuildKit and was `COPY < <USER` here). check_dockerfile_shape also tests the raw file, so a mismatch
# left in this reader still fails closed.
instructions() {
  LC_ALL=C awk '
    { sub(/[\r\n]+$/, "") }
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*$/ { next }
    {
      line = $0
      if (match(line, /(^|[^\\])\\[ \t]*$/)) {
        sub(/\\[ \t]*$/, "", line)
        buf = buf line
        cont = 1
        next
      }
      print buf line
      buf = ""
      cont = 0
    }
    END { if (cont) print buf }' "$1"
}

pin_findings=$findings
declare -A runtime_base # Dockerfile -> the image its last FROM names (check_secrets compares histories)
for dockerfile in docker/*.Dockerfile; do
  stages=() # stage names so far, lower-cased (Docker matches them case-insensitively)
  # A reference is fine when it names an earlier stage (by name or by index) or is pinned.
  check_ref() {
    local what=$1 ref=$2 stage
    for stage in "${stages[@]}"; do [[ ${ref,,} != "$stage" ]] || return 0; done
    if [[ $ref =~ ^[0-9]+$ ]] && ((ref < ${#stages[@]})); then return 0; fi
    [[ $ref =~ $PINNED ]] ||
      fail "$dockerfile: $what $ref is not pinned by version and digest (written out, not through an ARG)"
  }
  # Parser directives, looked for on every line (BuildKit reads them only at the top, after any leading
  # whitespace, as `#` or `//` comments; any line is stricter). No `syntax` at all (DEV-p5-image-scan-13):
  # even a pinned one swaps the frontend that parses the file, and with it everything this check reads.
  while IFS='=' read -r name value; do
    case ${name,,} in
      syntax) fail "$dockerfile: a syntax parser directive ($value) is not allowed; the engine's built-in frontend builds these files" ;;
      escape) fail "$dockerfile: an # escape= parser directive is not supported by this check" ;;
    esac
  done < <(sed -nE 's,^[[:space:]]*(#|//)[[:space:]]*([A-Za-z][A-Za-z0-9]*)[[:space:]]*=[[:space:]]*([^[:space:]]*).*,\2=\3,p' "$dockerfile")
  froms=0
  while read -r keyword rest; do
    keyword=${keyword^^}
    if [[ $keyword == ONBUILD ]]; then
      read -r keyword rest <<< "$rest"
      keyword=${keyword^^}
    fi
    read -ra words <<< "$rest"
    case $keyword in
      FROM)
        froms=$((froms + 1))
        i=0
        while [[ ${words[i]:-} == --* ]]; do i=$((i + 1)); done
        check_ref FROM "${words[i]:-<none>}"
        runtime_base[$dockerfile]=${words[i]:-}
        as=${words[i + 1]:-}
        # An unnamed stage still takes an index (COPY --from=0).
        if [[ ${as^^} == AS && -n ${words[i + 2]:-} ]]; then stages+=("${words[i + 2],,}"); else stages+=("#$froms"); fi
        ;;
      COPY | ADD)
        for word in "${words[@]}"; do
          [[ $word == --* ]] || break
          if [[ ${word,,} == --from=* ]]; then check_ref "$keyword --from=" "${word#*=}"; fi
        done
        ;;
      RUN)
        for word in "${words[@]}"; do
          [[ $word == --* ]] || break
          [[ ${word,,} == --mount=* ]] || continue
          IFS=, read -ra options <<< "${word#*=}"
          for option in "${options[@]}"; do
            if [[ ${option,,} == from=* ]]; then check_ref "RUN --mount from=" "${option#*=}"; fi
          done
        done
        ;;
    esac
  done < <(instructions "$dockerfile")
  ((froms > 0)) || fail "$dockerfile: no FROM line found"
done
compose_json=$(docker compose --profile prod-check config --format json)
# Built here (a `build` section), or the image of a service that is built here and never pulled.
built=$(jq -r '[.services[] | select(.build != null) | .image] | unique | .[]' <<< "$compose_json")
while IFS=$'\t' read -r service image pull; do
  if [[ $pull == never ]] && grep -qxF "$image" <<< "$built"; then continue; fi
  [[ $image =~ $PINNED ]] || fail "compose.yaml: service $service uses $image, not pinned by version and digest"
done < <(jq -r '.services | to_entries[] | select(.value.build == null) | [.key, .value.image, (.value.pull_policy // "")] | @tsv' <<< "$compose_json")
if ((findings == pin_findings)); then
  echo "pins: every image the Dockerfiles use (FROM, COPY --from, RUN --mount from) and every pulled compose image is pinned by version and digest"
fi

# What compose builds (DEV-p5-image-scan-13): CI builds through `docker compose --profile prod-check build`,
# the deploy with `docker build -f docker/<name>.Dockerfile .`, and this script reads those two files. So
# the services that compose builds must be exactly api and web, each with a build section of exactly
# {context: the repo root, dockerfile: docker/<name>.Dockerfile} as compose resolves it: no args (so no
# BUILDKIT_SYNTAX), additional_contexts, target, dockerfile_inline, ssh, secrets or any other key.
build_findings=$findings
repo_root=$(pwd -P)
declare -A compose_dockerfile=([api]=docker/api.Dockerfile [web]=docker/web.Dockerfile)
compose_builds=$(jq -r '.services | to_entries[] | select(.value.build != null) | .key' <<< "$compose_json" | LC_ALL=C sort | tr '\n' ' ')
[[ $compose_builds == 'api web ' ]] ||
  fail "compose.yaml: the services with a build section are '${compose_builds% }', not exactly api and web"
for service in api web; do
  build=$(jq -c --arg s "$service" '.services[$s].build // null' <<< "$compose_json")
  keys=$(jq -r 'if type == "object" then keys | join(",") else "none" end' <<< "$build")
  context=$(jq -r 'if type == "object" then .context // "" else "" end' <<< "$build")
  file=$(jq -r 'if type == "object" then .dockerfile // "" else "" end' <<< "$build")
  if [[ $keys != context,dockerfile ]]; then
    fail "compose.yaml: service $service's build has keys '$keys', not exactly context and dockerfile: $build"
  elif [[ $(realpath -m -- "$context") != "$repo_root" ]]; then
    fail "compose.yaml: service $service builds from context $context, not the repo root"
  elif [[ $file != "${compose_dockerfile[$service]}" ]]; then
    fail "compose.yaml: service $service builds $file, not ${compose_dockerfile[$service]}"
  fi
done
if ((findings == build_findings)); then
  echo "compose: api and web build exactly docker/api.Dockerfile and docker/web.Dockerfile from the repo root, with no build options"
fi

# The API runs through main.ts, which reads its settings with loadConfig() (and so refuses ALLOW_RESET in
# production mode, DEV-p5-security-16): in the image, and in every compose service that uses the image.
cmd=$(docker image inspect --format '{{json .Config.Cmd}}' "$api_image")
[[ $cmd == '["node","api/src/main.ts"]' ]] || fail "$api_image: CMD is $cmd, not node api/src/main.ts"
overrides=$(jq -r --arg img "$api_image" '.services | to_entries[]
  | select(.value.image == $img and (.value.command != null or .value.entrypoint != null)) | .key' <<< "$compose_json")
[[ -z $overrides ]] || fail "compose.yaml: services that override the API image's command or entrypoint: $(tr '\n' ' ' <<< "$overrides")"

# --- Secrets in layers, build arguments, ENV and labels (both images) ------------------------------
# scheme://, a user (may be empty), `:`, a password of at least one character, `@`.
URL_WITH_PASSWORD='[A-Za-z][A-Za-z0-9+.-]*://[^/?#@[:space:]":]*:[^/?#@[:space:]"]+@'
check_secrets() {
  local image=$1 dockerfile=$2 dir base ours names urls before=$findings
  dir="$work/secrets-$(tr -c 'a-zA-Z0-9\n' '_' <<< "$image")"
  mkdir -p "$dir"
  # The layers this repo's Dockerfile adds: the image's history minus its base image's (the runtime
  # stage's FROM, pinned above). The base layers are the upstream's: nginx's own history, for one,
  # holds the SHA-512 of its signing key, which Gitleaks' generic rule takes for an API key. Those are
  # for the image scan (wave C); this check is about what we add.
  base=${runtime_base[$dockerfile]}
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
  # Its report quotes the image's own history and config, so it is printed through log_safe_lines. With
  # pipefail the pipeline fails when Gitleaks does (or the filter does), so the result is still Gitleaks'.
  if ! (cd "$dir" && env -u GITLEAKS_CONFIG -u GITLEAKS_CONFIG_TOML "$gitleaks" dir --no-banner --redact \
    --verbose --log-level warn --ignore-gitleaks-allow "$dir") 2>&1 | log_safe_lines; then
    fail "$image: Gitleaks found a secret in the image's own layers or its config (findings above, redacted)"
  fi
  # A credential with too little entropy for Gitleaks still has a telltale name.
  names=$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" | cut -d= -f1 |
    grep -iE 'pass(word|wd)?|secret|token|credential|private|api_?key|access_?key' || true)
  [[ -z $names ]] || fail "$image: ENV names that look like credentials: $(tr '\n' ' ' <<< "$names")"
  # DEV-p5-containers-13: a URL that carries a password (scheme://user:password@host) is a credential
  # whatever its variable is called and whatever its entropy: DATABASE_URL=postgres://app:<pw>@db/app has
  # no telltale name and a shape Gitleaks' default rules do not flag. Any ENV value, label or other config
  # field, and any of our own history lines (RUN lines show their build arguments). Printed without the
  # password. A value with no name and no shape to go by (a bare random ENV or ARG) is beyond any pattern
  # check; that is for the image scan and review (wave C).
  urls=$(grep -ohE "$URL_WITH_PASSWORD" "$dir/history.txt" "$dir/inspect.json" |
    sed -E 's#^([^:]+://[^:@]*):[^@]*@#\1:<redacted>@#' | sort -u || true)
  [[ -z $urls ]] || fail "$image: URLs with a password in the image's own layers or its config: $(tr '\n' ' ' <<< "$urls")"
  # The summary only when this image passed every check above.
  if ((findings == before)); then
    echo "$image: no secret in its $ours own history entries or the image config"
  fi
}

# --- OS packages and package sources (both images) -------------------------------------------------
# Each runtime stage has exactly one apk instruction, and what it may do depends on the image:
#   - web (`floors`): `RUN apk add --no-cache '<package>>=<fixed version>' …` raises the Alpine packages the
#     pinned nginx base ships below a security fix (p5-image-cves, live deploy run 3; Q-p5-image-cves-3 (a),
#     Q-p5-image-scan-2 (a)). That line is the one list of floors. Everything here fails closed (sec-01): the
#     list must exist and every entry must be a valid apk version floor; the built image must hold each
#     package, and apk's own comparison, run in the image, must print exactly `>` or `=`. Empty output (an
#     invalid version), an error (no apk in the image), a missing package or a missing list all fail.
#   - API (`removed`): `RUN apk del --no-cache <package> …` removes apk-tools and Alpine's OpenSSL and zlib,
#     whose only users in that image were apk and busybox's ssl_client (Q-p5-image-scan-1 (a)). The built
#     image must not list any of API_REMOVED in apk's installed database, nor hold their main files; a
#     database that cannot be read, or that does not list busybox and musl (so is not the real one), fails.
#
# Package sources (sec-02, DEV-p5-image-cves-05 and -07): no apk step may trust unsigned packages or use
# another repository or key set. Read from the Dockerfile, with every word's quotes stripped first:
#   - apk options are matched by prefix, because apk accepts abbreviated long options (`--allow-unt`):
#     --allow-u*, --keys-d*, --repositor* (also --repositories-file) and -X*;
#   - an exec-form RUN (`RUN ["apk", …]`) that mentions apk fails: it is not read as words here;
#   - the one apk line is the only instruction that may mention apk or an APK_ variable at all, which also
#     refuses a second `apk add`/`apk upgrade` line (reviewer N12), `echo … >> /etc/apk/repositories`
#     (N08) and `wget … -O /etc/apk/keys/…` (N16), and a RUN heredoc, which this reader cannot parse.
# And from the images, whatever the Dockerfile's spelling: everything under /etc/apk except `world`
# (repositories, keys, any config) must be identical, byte for byte, to the runtime base image's (API: may
# only lose paths, never gain or change one, since `apk del apk-tools` removes its own config); `world`
# must be the base's plus exactly the floors (web), or the base's minus exactly the removed packages (API:
# with apk gone, nothing in the image can install from it, but a package added before the `apk del` would
# still show there); no ENV name starts with APK_.
APK_FLOOR='^[a-z0-9][a-z0-9+._-]*>=[0-9]+(\.[0-9]+)*[a-z]?(_(alpha|beta|pre|rc|cvs|svn|git|hg|p)[0-9]*)*(-r[0-9]+)?$'
APK_NAME='^[a-z0-9][a-z0-9+._-]*$'
# What the API image must not hold (owner's answer to Q-p5-image-scan-1 (a)), and a main file of each.
API_REMOVED=(apk-tools libapk ssl_client libssl3 libcrypto3 zlib)
API_REMOVED_FILES=(/sbin/apk /usr/bin/ssl_client /usr/lib/libssl.so.3 /usr/lib/libcrypto.so.3 /usr/lib/libz.so.1)
# The runtime stage's RUN instructions, by allowlist (DEV-p5-image-scan-05, the security review's C1:
# `RUN ap''k --allow-untrusted -X … add …` built and passed, because the shell joins `ap''k` into `apk`
# after the text check had already looked for the word `apk`). A text check cannot list every way a shell
# can spell a command, so the runtime stage (everything after the last FROM, which is what ships) may hold
# only these RUN instructions, compared after joining continuation lines and collapsing whitespace:
#   - web: the one floor line, `RUN apk add --no-cache` followed only by single-quoted '<package>>=<version>'
#     floors (APK_FLOOR);
#   - API: the one `RUN apk del --no-cache` line followed only by bare package names (APK_NAME), and the
#     two fixed lines in API_RUNTIME_RUN_LITERALS, which must match byte for byte.
# Any other RUN in the runtime stage fails. Before the form is compared, a RUN that is not one of those
# exact literals fails if it holds `$(`, a backtick, `${`, any backslash (continuations are already
# joined) or a quote that splits a word (only a whole word may be quoted, as in 'zlib>=1.4-r0'). The printf
# literal holds `\n` and quoted words with spaces; it is exempt only because its whole text is fixed.
# A Dependabot bump changes only the FROM line, which this does not compare, so it needs no edit here.
API_RUNTIME_RUN_LITERALS=(
  'RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*'
  "RUN printf '{ \"type\": \"module\" }\\n' > web/package.json"
)
# The Dockerfile's shape, before its runtime RUNs are read (DEV-p5-image-scan-sec-03 and -sec-04, the
# security re-check of round 2, which built and ran an untrusted apk past the RUN allowlist twice):
#   - no heredoc anywhere (`<<` in any instruction, any stage). instructions() does not parse heredoc
#     bodies, so a body line reading `FROM <pinned image>` started a "stage" and hid the real runtime
#     stage's RUN. Neither Dockerfile uses one, so refusing them means the reader never has to parse them;
#   - every logical instruction starts with a Dockerfile instruction keyword, so FROM is counted only as
#     the keyword of an instruction (with heredocs refused, nothing else can put a line there);
#   - no SHELL or ONBUILD in any stage: SHELL changes what every later RUN means (the repro put the apk
#     call in SHELL's own `-c` string), ONBUILD runs instructions in a later build;
#   - in the runtime stage, only the keywords that file uses today (RUNTIME_KEYWORDS). Anything else
#     (ADD, VOLUME, ENTRYPOINT, ARG, LABEL, ...) fails; adding one is a reviewed edit here.
# A Dependabot FROM bump changes none of these.
declare -A RUNTIME_KEYWORDS=(
  [docker/api.Dockerfile]='FROM ENV RUN WORKDIR COPY USER EXPOSE HEALTHCHECK CMD'
  [docker/web.Dockerfile]='FROM ENV USER RUN COPY EXPOSE HEALTHCHECK'
)
DOCKERFILE_KEYWORDS=' FROM RUN CMD LABEL MAINTAINER EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL '
check_dockerfile_shape() {
  local dockerfile=$1 line keyword stage=0 last=0 n=0 raw odd
  local -a kw=()
  # The heredoc test again on the raw file, independent of instructions() (DEV-p5-image-scan-11): comment
  # lines dropped, then every backslash, space, tab, CR, LF, VT and FF deleted. Any `<<` left fails. This
  # finds every `<<` BuildKit could see after its own joining (it only ever removes backslash-newlines,
  # blanks after them, comment lines and blank lines), and more, so a reader mismatch fails closed.
  raw=$(LC_ALL=C awk '!/^[[:space:]]*#/' "$dockerfile" | LC_ALL=C tr -d '\\ \t\r\n\v\f')
  if [[ $raw == *'<<'* ]]; then
    fail "$dockerfile: '<<' (a heredoc, possibly split over continuation lines) in the raw file"
  fi
  # BuildKit trims Unicode whitespace (U+00A0, U+2000…) before `#`, and a byte-order mark before line 1;
  # the reader above trims ASCII only. A line that starts with a non-ASCII byte is refused, so a comment
  # BuildKit drops can never be read here as text.
  odd=$(LC_ALL=C grep -n $'^[ \t\v\f\r]*[\x80-\xff]' "$dockerfile" || true)
  if [[ -n $odd ]]; then
    fail "$dockerfile: a line starts with a non-ASCII byte (Unicode whitespace or a byte-order mark): ${odd%%$'\n'*}"
  fi
  while IFS= read -r line; do
    read -r keyword _ <<< "$line"
    [[ -n $keyword ]] || continue # a blank line between instructions, which Docker ignores
    keyword=${keyword^^}
    n=$((n + 1))
    kw[n]=$keyword
    [[ $keyword != FROM ]] || last=$n
    if [[ $line == *'<<'* ]]; then
      fail "$dockerfile: a heredoc (<<) in an instruction; the reader does not parse heredoc bodies: $line"
    fi
    if [[ $DOCKERFILE_KEYWORDS != *" $keyword "* ]]; then
      fail "$dockerfile: a line that does not start with a Dockerfile instruction keyword: $line"
    elif [[ $keyword == SHELL || $keyword == ONBUILD ]]; then
      fail "$dockerfile: $keyword is not allowed in any stage: $line"
    fi
  done < <(instructions "$dockerfile")
  if [[ -z ${RUNTIME_KEYWORDS[$dockerfile]:-} ]]; then
    fail "$dockerfile: no runtime keyword list in RUNTIME_KEYWORDS"
    return
  fi
  for ((stage = last; stage >= 1 && stage <= n; stage++)); do
    if [[ " ${RUNTIME_KEYWORDS[$dockerfile]} " != *" ${kw[stage]} "* ]]; then
      fail "$dockerfile: ${kw[stage]} is not one of the runtime stage's permitted instructions (${RUNTIME_KEYWORDS[$dockerfile]})"
    fi
  done
}
check_runtime_runs() {
  local dockerfile=$1 verb=$2 line norm runs=0 lit literal w inner ok bad before=$findings
  local -a words literals=()
  check_dockerfile_shape "$dockerfile"
  [[ $dockerfile != docker/api.Dockerfile ]] || literals=("${API_RUNTIME_RUN_LITERALS[@]}")
  while IFS= read -r line; do
    read -ra words <<< "$line"
    [[ ${words[0]^^} == RUN ]] || continue
    runs=$((runs + 1))
    norm="${words[*]}"
    literal=no
    for lit in "${literals[@]}"; do
      if [[ $norm == "$lit" ]]; then literal=yes; fi
    done
    [[ $literal == no ]] || continue
    if [[ $norm == *'$('* || $norm == *'`'* || $norm == *'${'* || $norm == *\\* ]]; then
      fail "$dockerfile: a runtime-stage RUN uses \$(, a backtick, \${ or a backslash: $norm"
      continue
    fi
    bad=''
    for w in "${words[@]}"; do
      if [[ $w == *[\'\"]* ]] && ! [[ $w =~ ^\'[^\'\"]*\'$ || $w =~ ^\"[^\'\"]*\"$ ]]; then
        bad=$w
        break
      fi
    done
    if [[ -n $bad ]]; then
      fail "$dockerfile: a runtime-stage RUN has quotes that split the word $bad: $norm"
      continue
    fi
    ok=no
    if [[ ${words[0]^^} == RUN && ${words[1]:-} == apk && ${words[2]:-} == "$verb" && ${words[3]:-} == --no-cache && ${#words[@]} -gt 4 ]]; then
      ok=yes
      for w in "${words[@]:4}"; do
        inner=${w#\'}
        inner=${inner%\'}
        if [[ $verb == add ]]; then
          [[ $w == "'$inner'" && $inner =~ $APK_FLOOR ]] || ok=no
        else
          [[ $w =~ $APK_NAME ]] || ok=no
        fi
      done
    fi
    [[ $ok == yes ]] || fail "$dockerfile: a runtime-stage RUN that is not one of its permitted forms: $norm"
  done < <(instructions "$dockerfile" | awk 'toupper($1) == "FROM" { n = 0 } { l[++n] = $0 } END { for (i = 1; i <= n; i++) print l[i] }')
  if ((findings == before)); then
    echo "$dockerfile: the runtime stage's $runs RUN instruction(s) are all permitted forms"
  fi
}
check_apk() {
  local image=$1 dockerfile=$2 mode=$3 model=$4 base_model=$5 before=$findings line keyword rest word words apk_lines=0 versions='' base verb
  local -a floors=() removed=()
  case $mode in
    floors) verb=add ;;
    removed) verb=del ;;
    *)
      fail "check_apk: unknown mode $mode"
      return
      ;;
  esac
  check_runtime_runs "$dockerfile" "$verb"
  while read -r line; do
    read -r keyword rest <<< "$line"
    keyword=${keyword^^}
    if [[ $keyword == RUN && $rest =~ (^|[[:space:]])\[ ]]; then
      fail "$dockerfile: an exec-form RUN mentions apk: $line"
      continue
    fi
    if [[ $keyword == RUN && $rest == *'<<'* ]]; then
      fail "$dockerfile: a RUN heredoc mentions apk: $line"
      continue
    fi
    read -ra words <<< "$rest"
    for i in "${!words[@]}"; do
      word=${words[i]//\'/}
      words[i]=${word//\"/}
    done
    for word in "${words[@]}"; do
      case $word in
        --allow-u* | --keys-d* | --repositor* | -X*)
          fail "$dockerfile: an apk step uses $word (unsigned packages, or another repository or key set)" ;;
      esac
    done
    if ! [[ $keyword == RUN && ${words[0]:-} == apk && ${words[1]:-} == "$verb" ]]; then
      fail "$dockerfile: only the one 'RUN apk $verb --no-cache …' line may mention apk or APK_: $line"
      continue
    fi
    apk_lines=$((apk_lines + 1))
    for word in "${words[@]:2}"; do
      if [[ $word == --no-cache ]]; then continue; fi
      if [[ $word == -* ]]; then
        fail "$dockerfile: apk $verb option $word is not allowed (only --no-cache)"
      elif [[ $mode == floors && $word =~ $APK_FLOOR ]]; then
        floors+=("$word")
      elif [[ $mode == removed && $word =~ $APK_NAME ]]; then
        removed+=("$word")
      elif [[ $mode == floors ]]; then
        fail "$dockerfile: apk add argument $word is not a '<package>>=<apk version>' floor"
      else
        fail "$dockerfile: apk del argument $word is not a package name"
      fi
    done
  # Quotes and backslashes removed first, in every stage, so `ap''k`, `"ap"k` and `a\pk` read as apk here
  # too (DEV-p5-image-scan-05); spellings through `$(…)` or `${…}` are for the runtime allowlist above.
  done < <(instructions "$dockerfile" | tr -d "'\"\\\\" | grep -iE '(^|[^a-z0-9_])apk([^a-z0-9]|$)|APK_' || true)
  ((apk_lines <= 1)) || fail "$dockerfile: $apk_lines apk $verb lines; there must be one list on one line"
  local summary=''
  if [[ $mode == floors ]]; then
    ((${#floors[@]} > 0)) ||
      fail "$dockerfile: no apk add '<package>>=<version>' floors found; if the base image now has the fixes, remove this check with the step"
    if ((${#floors[@]} > 0)); then
      # The installed versions from apk's database in the model, compared on the host with apk's own
      # version order (image-fs vercmp), not by the image's `apk version -t` (DEV-p5-image-scan-15).
      local installed_versions floor fname fwant fhave fop
      versions=''
      if ! installed_versions=$(image_fs apk-installed "$model"); then
        fail "$image: could not read its OS package versions from apk's installed database"
      else
        for floor in "${floors[@]}"; do
          fname=${floor%%>=*}
          fwant=${floor#*>=}
          fhave=$(awk -F'\t' -v n="$fname" '$1 == n { print $2 }' <<< "$installed_versions")
          fop=''
          if [[ -n $fhave && $fhave != *$'\n'* ]]; then fop=$(image_fs vercmp "$fhave" "$fwant" 2>&1) || fop="error: $fop"; fi
          versions+="$fname"$'\t'"${fhave:-<not installed>}"$'\t'"$fop"$'\t'"$fwant"$'\n'
        done
        versions=${versions%$'\n'}
        local confirmed=0 name have op want
        while IFS=$'\t' read -r name have op want; do
          if [[ $op == '>' || $op == '=' ]]; then
            confirmed=$((confirmed + 1))
          else
            fail "$image: $name $have is not shown at or above $want (the version comparison gave '$op')"
          fi
        done <<< "$versions"
        ((confirmed == ${#floors[@]})) ||
          fail "$image: $confirmed of ${#floors[@]} OS package floors confirmed: $(tr '\t\n' ' ;' <<< "$versions")"
      fi
    fi
    summary="OS packages at or above their floors: $(tr '\t\n' ' ;' <<< "$versions")"
  else
    ((${#removed[@]} > 0)) || fail "$dockerfile: no 'apk del --no-cache <package> …' line found"
    # apk's database and the files' presence, from the model (DEV-p5-image-scan-15: through the image's
    # own `cat` and `sh` these could be faked by a wrapper).
    local installed pkg file present
    if ! installed=$(image_fs cat "$model" lib/apk/db/installed); then
      fail "$image: could not read apk's installed database from its layers"
    elif ! grep -qx 'P:busybox' <<< "$installed" || ! grep -qx 'P:musl' <<< "$installed"; then
      fail "$image: apk's installed database does not list busybox and musl, so it cannot show what is absent"
    else
      for pkg in "${API_REMOVED[@]}"; do
        ! grep -qxF "P:$pkg" <<< "$installed" || fail "$image: $pkg is installed; it must be removed (Q-p5-image-scan-1 (a))"
      done
    fi
    if ! present=$(image_fs exists "$model" "${API_REMOVED_FILES[@]}"); then
      fail "$image: could not look for the removed packages' files"
    else
      for file in $present; do fail "$image: $file is in the image; its package must be removed"; done
    fi
    summary="absent: ${API_REMOVED[*]} (installed database and files)"
  fi
  # The package sources in the image itself, against its runtime base (pinned and pulled above), both read
  # from their layers on the host.
  base=${runtime_base[$dockerfile]}
  local image_state base_state expected
  if ! image_state=$(image_fs apk-state "$model"); then
    fail "$image: could not read /etc/apk from its layers"
  elif ! base_state=$(image_fs apk-state "$base_model"); then
    fail "$base: could not read /etc/apk from its layers"
  elif ! grep -q '^file [0-9a-f]\{64\} \./repositories$' <<< "$base_state" ||
    ! grep -q '^file [0-9a-f]\{64\} \./keys/' <<< "$base_state"; then
    fail "$base: /etc/apk has no repositories file or no keys, so the comparison would prove nothing: $base_state"
  else
    diff <(sed '/^world:$/,$d' <<< "$base_state") <(sed '/^world:$/,$d' <<< "$image_state") > "$work/apk-diff.txt" || true
    # web: identical. API: nothing added or changed; a path may only be gone (`apk del apk-tools` takes
    # its /etc/apk/protected_paths.d with it, and with apk gone nothing reads /etc/apk any more).
    if [[ $mode == floors ]] && grep -q '^[<>]' "$work/apk-diff.txt"; then
      fail "$image: /etc/apk (repositories, keys, config) differs from its base $base: $(grep '^[<>]' "$work/apk-diff.txt" | tr '\n' ' ')(< base, > image)"
    elif [[ $mode == removed ]] && grep -q '^>' "$work/apk-diff.txt"; then
      fail "$image: /etc/apk (repositories, keys, config) has paths its base $base does not: $(grep '^[<>]' "$work/apk-diff.txt" | tr '\n' ' ')(< base, > image)"
    fi
    local gone
    gone=$(grep '^<' "$work/apk-diff.txt" | sed 's/^< //' | tr '\n' ' ' || true)
    # web: a floor replaces the base's entry for the same package (the nginx base names libcrypto3 in world).
    # API: the removed packages leave world, and nothing else changes.
    local skip_names actual
    if [[ $mode == floors ]]; then skip_names=$(printf '%s\n' "${floors[@]%%>=*}"); else skip_names=$(printf '%s\n' "${removed[@]}"); fi
    expected=$( (sed '1,/^world:$/d' <<< "$base_state" | awk -v names="$skip_names" 'BEGIN { n = split(names, a, "\n"); for (i = 1; i <= n; i++) skip[a[i]] = 1 }
        { name = $0; sub(/[<>=~].*/, "", name); if (!(name in skip)) print }' && if [[ $mode == floors ]]; then printf '%s\n' "${floors[@]}"; fi) | LC_ALL=C sort)
    actual=$(sed '1,/^world:$/d' <<< "$image_state" | LC_ALL=C sort)
    if [[ $actual != "$expected" ]]; then
      fail "$image: /etc/apk/world is not its base's $([[ $mode == floors ]] && echo 'plus exactly the floors' || echo 'minus exactly the removed packages'): $(diff <(echo "$expected") <(echo "$actual") | grep '^[<>]' | tr '\n' ' ')(< expected, > image)"
    fi
  fi
  local apk_env
  apk_env=$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" | cut -d= -f1 | grep -i '^APK_' || true)
  [[ -z $apk_env ]] || fail "$image: ENV sets apk's own variables: $(tr '\n' ' ' <<< "$apk_env")"
  # What the runtime stage added to its base, with the packages this apk line may change or remove.
  local -a apk_named=()
  if [[ $mode == floors ]]; then apk_named=("${floors[@]%%>=*}"); else apk_named=("${removed[@]}" "${API_ALSO_REMOVED[@]}"); fi
  check_runtime_changes "$image" "$dockerfile" "$model" "$base_model" "$(IFS=,; echo "${apk_named[*]}")"
  if ((findings == before)); then
    echo "$image: $(log_safe "$summary")"
    if [[ $mode == floors ]]; then
      echo "$image: /etc/apk repositories, keys and config identical to $base; world is the base's plus the ${#floors[@]} floors"
    else
      echo "$image: /etc/apk adds or changes nothing against $base (gone with apk: $(log_safe "${gone:-nothing}")); world is the base's minus the removed packages"
    fi
  fi
}

# --- What the runtime stage adds to its base (DEV-p5-image-scan-10) ----------------------------------
# The text checks above cover the runtime stage's lines only; an earlier stage can build anything and hand
# it over by COPY (-10: a wrapper `apk` put on the PATH, -15: a lying `find`, -14: a setcap'd binary). So
# the built image itself is compared with its pinned base, both read on the host:
#   - history: the base's layers (by diff_id) and history are a prefix of the image's, and the image's own
#     history entries that change the filesystem are exactly the runtime stage's RUN, COPY and WORKDIR
#     lines, in order, as BuildKit records them (`RUN /bin/sh -c <command> # buildkit`, `COPY <sources>
#     <destination> # buildkit` with --from= left out, `WORKDIR <path>`). The history is what was actually run,
#     so a SHELL hook, a heredoc or a continuation that the text reader got wrong shows up as a mismatch;
#   - files: every path the image adds or changes against the base (kind, mode, owner, content, link target,
#     xattrs) must be under one of the image's COPY roots (RUNTIME_COPY_ROOTS: what the image is for), one
#     of apk's own state files, or a file of a package the apk line names, with apk's own checksum. Under
#     the roots: no ELF binary or shared library, and no symlink out of the root. Each COPY or WORKDIR layer
#     writes only under the roots. So a file an earlier stage made reaches the image only inside the roots,
#     and only as data, never as a tool on the PATH or a replaced library;
#   - packages: none added (a floor must name a package the base has, which also settles
#     DEV-p5-image-scan-02), and only the packages the apk line names change version or leave. The API's
#     `apk del` also purges ca-certificates-bundle, which only apk-tools needed (its Dockerfile comment),
#     so that one is named in API_ALSO_REMOVED;
#   - config: the base's ENV values (PATH among them) and ENTRYPOINT are unchanged, and the only ENV names
#     the image adds are the ones in RUNTIME_ENV_NAMES (N13 put a wrapper's folder first on the PATH).
# Each list here is a reviewed edit when the Dockerfile's runtime stage changes; a Dependabot FROM bump
# changes none of them.
declare -A RUNTIME_COPY_ROOTS=(
  [docker/api.Dockerfile]='app'
  [docker/web.Dockerfile]='srv/ascrum etc/nginx/ascrum etc/nginx/templates'
)
declare -A RUNTIME_ENV_NAMES=(
  [docker/api.Dockerfile]='NODE_ENV PORT'
  [docker/web.Dockerfile]='API_UPSTREAM ROUTE_STUB_CONTROL NGINX_ENVSUBST_FILTER'
)
API_ALSO_REMOVED=(ca-certificates-bundle)

# The runtime stage's RUN, COPY and WORKDIR lines (everything after the last FROM), as BuildKit writes
# them into the image's history. Anything this does not reproduce exactly fails the comparison.
expected_history() {
  local line keyword rest word
  local -a words out
  while IFS= read -r line; do
    read -r keyword rest <<< "$line"
    case ${keyword^^} in
      RUN) printf 'RUN /bin/sh -c %s # buildkit\n' "$rest" ;;
      COPY | ADD)
        read -ra words <<< "$rest"
        out=()
        # BuildKit leaves out --from= (the stage is not recorded) and keeps the other flags (--chmod=4755 shows).
        for word in "${words[@]}"; do [[ ${word,,} == --from=* ]] || out+=("$word"); done
        printf '%s %s # buildkit\n' "${keyword^^}" "${out[*]}"
        ;;
      WORKDIR) printf 'WORKDIR %s\n' "$rest" ;;
    esac
  done < <(instructions "$1" | awk 'toupper($1) == "FROM" { n = 0 } { l[++n] = $0 } END { for (i = 2; i <= n; i++) print l[i] }')
}

check_runtime_changes() {
  local image=$1 dockerfile=$2 model=$3 base_model=$4 apk_named=$5 base before=$findings expected
  local -a roots
  base=${runtime_base[$dockerfile]}
  read -ra roots <<< "${RUNTIME_COPY_ROOTS[$dockerfile]:-}"
  if ((${#roots[@]} == 0)); then
    fail "$dockerfile: no COPY roots in RUNTIME_COPY_ROOTS"
    return
  fi
  expected="$work/expected-history-$(basename "$dockerfile").txt"
  expected_history "$dockerfile" > "$expected"
  findings_of "$image" layers "$base_model" "$model" "$expected" || true
  findings_of "$image" added "$base_model" "$model" "$apk_named" "${roots[@]}" || true
  # Config against the base: every base ENV entry unchanged, only the listed names added, same ENTRYPOINT.
  local image_env base_env extra
  image_env=$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" | sed '/^$/d' | LC_ALL=C sort)
  base_env=$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$base" | sed '/^$/d' | LC_ALL=C sort)
  # comm compares in the C locale, the order `LC_ALL=C sort` produced; in the caller's locale (en_US.UTF-8)
  # it misreads C-sorted input, e.g. `B=1` before `a=1` (DEV-p5-image-host-22).
  extra=$(LC_ALL=C comm -13 <(echo "$base_env") <(echo "$image_env") | cut -d= -f1 | LC_ALL=C sort)
  if [[ -n $(LC_ALL=C comm -23 <(echo "$base_env") <(echo "$image_env")) ]]; then
    fail "$image: ENV changes or drops the base's entries: $(LC_ALL=C comm -23 <(echo "$base_env") <(echo "$image_env") | cut -d= -f1 | tr '\n' ' ')"
  fi
  if [[ $extra != "$(tr ' ' '\n' <<< "${RUNTIME_ENV_NAMES[$dockerfile]:-}" | sed '/^$/d' | LC_ALL=C sort)" ]]; then
    fail "$image: ENV adds $(tr '\n' ' ' <<< "$extra")but the runtime stage may add only ${RUNTIME_ENV_NAMES[$dockerfile]:-nothing}"
  fi
  if [[ $(docker image inspect --format '{{json .Config.Entrypoint}}' "$image") != "$(docker image inspect --format '{{json .Config.Entrypoint}}' "$base")" ]]; then
    fail "$image: ENTRYPOINT differs from its base's"
  fi
  if ((findings == before)); then
    echo "$image: on its base's $(jq '.diffIds | length' "$base_model") layers; its own history is exactly the runtime stage's $(wc -l < "$expected") RUN/COPY/WORKDIR lines; adds or changes nothing outside ${roots[*]} except checksum-verified files of ${apk_named//,/ }; base ENV and ENTRYPOINT unchanged"
  fi
}

# --- Both images and their runtime bases, read on the host ------------------------------------------
# The bases are pulled by their pinned digest (checked above) so they can be read the same way.
for dockerfile in docker/api.Dockerfile docker/web.Dockerfile; do
  base=${runtime_base[$dockerfile]}
  docker image inspect "$base" > /dev/null 2>&1 || docker pull -q "$base" > /dev/null
done
model_of "$api_image" "$work/api.model.json"
model_of "${runtime_base[docker/api.Dockerfile]}" "$work/api-base.model.json"
model_of "$web_image" "$work/web.model.json"
model_of "${runtime_base[docker/web.Dockerfile]}" "$work/web-base.model.json"

# --- API ---------------------------------------------------------------------------------------
check_user "$api_image" "$work/api.model.json"
check_special "$api_image" "$work/api.model.json"
check_secrets "$api_image" docker/api.Dockerfile
image_fs list "$work/api.model.json" > "$work/api.txt"
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
if graph=$(docker run --pull never --rm --network none --entrypoint node \
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
  # Pulled here, by its pinned digest, because every `docker run` below uses --pull never.
  docker image inspect "$db_image" > /dev/null 2>&1 || docker pull -q "$db_image" > /dev/null
  docker network create --internal "$net" > /dev/null
  # Throwaway values for a database that lives for this check only, on a network with no way out.
  docker run --pull never -d --name "$db" --network "$net" -e POSTGRES_USER=check -e POSTGRES_PASSWORD=check \
    -e POSTGRES_DB=check "$db_image" > /dev/null
  # Like compose's service_healthy: wait for the real server on TCP (the image's first-start server
  # listens on its socket only).
  deadline=$((SECONDS + 60))
  until docker exec "$db" pg_isready -q -h 127.0.0.1 -U check -d check; do
    ((SECONDS < deadline)) || { fail "$db_image: PostgreSQL did not start for the start-up check"; return; }
    sleep 1
  done
  docker run --pull never -d --name "$api" --network "$net" -e "DATABASE_URL=postgres://check:check@$db:5432/check" \
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
    echo "$image: starts with only DATABASE_URL and answers /healthz: $(log_safe "$(cat "$work/healthz.txt"); $(docker logs "$api" 2>&1 | grep -a -m1 'listening' || echo 'no start-up line')")"
  else
    fail "$image: does not start and answer /healthz (state: $status). Last log lines: $(docker logs --tail 15 "$api" 2>&1)"
  fi
  docker rm -f "$api" "$db" > /dev/null
  docker network rm "$net" > /dev/null
}
check_startup "$api_image"

# Alpine's OpenSSL, zlib and apk are gone, and the package sources are the base's (the section above).
check_apk "$api_image" docker/api.Dockerfile removed "$work/api.model.json" "$work/api-base.model.json"

# Dev dependencies: none of api/package.json's devDependencies is installed (pnpm keeps every installed
# package as node_modules/.pnpm/<name>@<version>, scoped names with + for /).
while read -r dev; do
  [[ -n $dev ]] || continue
  pattern="^app/api/node_modules/(\.pnpm/${dev//\//\\+}@|${dev}/)"
  ! grep -qE "$pattern" "$work/api.txt" || fail "$api_image: dev dependency $dev is installed"
done < <(jq -r '.devDependencies // {} | keys[]' api/package.json)
# And what is installed is exactly the production tree: pg and the packages pg depends on
# (DEV-p5-image-host-10: this line had only printed the list, and extra `.pnpm` directories passed). The
# expected tree comes from api/pnpm-lock.yaml alone, through pnpm itself: `pnpm list --lockfile-only --prod`
# reads the lockfile without node_modules and gives each package's path in the virtual store, so its
# `.pnpm/<dir>` names (peer suffixes included, e.g. pg-pool@3.14.0_pg@8.23.1) are the ones the Dockerfile's
# `pnpm install --prod --frozen-lockfile` creates. It is the pnpm packageManager pins (setup-web in CI, the
# Dockerfile through corepack), and nothing from the image takes part. Both ways must match: every `.pnpm`
# directory in the image is in the lockfile's production tree and every one of those is in the image, and
# the top-level packages under node_modules are exactly the production dependencies api/package.json names.
# An empty or unreadable expected list fails; it never passes as "nothing expected".
installed=$(grep -oE '^app/api/node_modules/\.pnpm/[^/]+/$' "$work/api.txt" | sed -E 's|.*/\.pnpm/||; s|/$||' |
  grep -v '^node_modules$' | LC_ALL=C sort || true)
top_level=$(grep -oE '^app/api/node_modules/(@[^/]+/)?[^/.][^/]*/?$' "$work/api.txt" |
  sed -E 's|^app/api/node_modules/||; s|/$||' | grep -v '^@[^/]*$' | LC_ALL=C sort || true)
if ! pnpm --dir api list --lockfile-only --prod --depth Infinity --json > "$work/prod-tree.json" 2> "$work/prod-tree.err"; then
  fail "$api_image: pnpm could not list api/pnpm-lock.yaml's production tree: $(tail -5 "$work/prod-tree.err")"
else
  production=$(jq -r '[.. | objects | .path? // empty | strings | capture("/node_modules/\\.pnpm/(?<d>[^/]+)/") | .d] | unique[]' \
    "$work/prod-tree.json" | LC_ALL=C sort || true)
  direct=$(jq -r '[.[0] | (.dependencies // {}), (.optionalDependencies // {}) | keys[]] | unique[]' "$work/prod-tree.json" |
    LC_ALL=C sort || true)
  if [[ -z $production || -z $direct ]]; then
    fail "$api_image: pnpm listed no production packages for api/pnpm-lock.yaml, so the installed tree cannot be compared"
  elif [[ $installed != "$production" || $top_level != "$direct" ]]; then
    fail "$api_image: installed packages are not api/pnpm-lock.yaml's production tree. In the image only: $(LC_ALL=C comm -23 <(echo "$installed") <(echo "$production") | tr '\n' ' ')$(LC_ALL=C comm -23 <(echo "$top_level") <(echo "$direct") | sed 's|^|node_modules/|' | tr '\n' ' ')missing from the image: $(LC_ALL=C comm -13 <(echo "$installed") <(echo "$production") | tr '\n' ' ')$(LC_ALL=C comm -13 <(echo "$top_level") <(echo "$direct") | sed 's|^|node_modules/|' | tr '\n' ' ')"
  else
    echo "$api_image: installed packages are exactly api/pnpm-lock.yaml's production tree ($(wc -l <<< "$production") in .pnpm; top level: $(paste -sd ' ' <<< "$direct")): $(log_safe "$(paste -sd ' ' <<< "$installed")")"
  fi
fi

# --- web ---------------------------------------------------------------------------------------
check_user "$web_image" "$work/web.model.json"
check_special "$web_image" "$work/web.model.json"
check_secrets "$web_image" docker/web.Dockerfile
image_fs list "$work/web.model.json" > "$work/web.txt"
check_common "$web_image" "$work/web.txt"
# A static build behind nginx: no node_modules at all, so no dependency of any kind.
hits=$(grep -E '(^|/)node_modules/' "$work/web.txt" | head -5 || true)
[[ -z $hits ]] || fail "$web_image: node_modules in the image: $hits"
# The site root holds only build output: no sources, source maps, or the MSW worker (dev only).
hits=$(grep -E '^srv/ascrum/.*(\.tsx?|\.map|\.less|mockServiceWorker\.js)$' "$work/web.txt" || true)
[[ -z $hits ]] || fail "$web_image: sources or dev files in the site root: $hits"
check_apk "$web_image" docker/web.Dockerfile floors "$work/web.model.json" "$work/web-base.model.json"
# The header include (DEV-p5-image-host-03; owner's answer: header lines only). The build stage writes
# /etc/nginx/ascrum/security-headers.conf with docker/web/security-headers.ts, and nginx includes it inside
# `server {}`, so anything else in it is server config from the build stage: an appended
# `location /leak/ { alias /; autoindex on; }` listed the whole filesystem, and a `proxy_pass` could reach
# into the VPC. Read from the image's layers on the host (symlinks followed, as nginx opens it), every line
# must be blank, a comment, or one directive the generator writes: `add_header <name> "<value>" always;` or
# `proxy_hide_header <name>;` (it drops the API's copy of a header; it opens nothing). No `{`, `}`,
# `include`, variable or escape, and nothing after the `;`. Only line numbers are printed, never the text.
#
# The check itself is in docker/image-fs.ts (`header-include`), on the file's bytes (DEV-p5-image-host-12 / sec-08): it refuses
# any byte that is not printable ASCII, a tab or a newline before it matches a line. A grep here could not
# be trusted with the file: a NUL made GNU grep treat it as binary, print nothing and exit 0 (WB6), while
# nginx applied the `location` on the line before the NUL. Any exit but 0 fails.
check_header_include() {
  local image=$1 model=$2
  findings_of "$image" header-include "$model" etc/nginx/ascrum/security-headers.conf || true
}
check_header_include "$web_image" "$work/web.model.json"

if [[ $findings -gt 0 ]]; then
  echo "check-images: $findings finding(s)" >&2
  exit 1
fi
echo "check-images: AC-CTR-02 (non-root, no dev dependencies, test files or .env), pins, compose builds, no setuid, setgid or capability files, runtime-stage additions against the bases, no secrets in layers or config, the API loads and starts, web OS package floors, API without apk/OpenSSL/zlib, package sources in both images (file facts read on the host)"
