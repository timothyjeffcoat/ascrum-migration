#!/usr/bin/env bash
# AC-CTR-02: the images run as a non-root user and contain no dev dependencies, test files or .env files.
# Checks the built images themselves (their config and every file in them), not the Dockerfiles.
#
#   docker/check-images.sh <api image> <web image>        (from the repo root; needs docker and jq)
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

fail() {
  echo "AC-CTR-02 FAIL: $*" >&2
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
trap 'rm -rf "$work"' EXIT

# --- API ---------------------------------------------------------------------------------------
check_user "$api_image"
files_of "$api_image" > "$work/api.txt"
check_common "$api_image" "$work/api.txt"

# Outside node_modules, /app holds exactly what the API runs: an allowlist, so a new kind of file
# (a test helper, a script, a fixture) fails here until someone decides it belongs.
hits=$(grep -E '^app/.' "$work/api.txt" | grep -v '^app/api/node_modules/' | grep -vE \
  '^app/(api|api/src|api/migrations|web|web/stub)/$|^app/api/package\.json$|^app/api/src/[a-zA-Z]+\.ts$|^app/api/migrations/[0-9]{3}_[a-z0-9_]+\.sql$|^app/web/package\.json$|^app/web/stub/(handlers|server|store|session|query|seed)\.ts$' ||
  true)
[[ -z $hits ]] || fail "$api_image: unexpected files in /app: $hits"
for helper in app/api/src/testDb.ts app/web/stub/contractTests.ts; do
  ! grep -qx "$helper" "$work/api.txt" || fail "$api_image: test helper $helper"
done

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
files_of "$web_image" > "$work/web.txt"
check_common "$web_image" "$work/web.txt"
# A static build behind nginx: no node_modules at all, so no dependency of any kind.
hits=$(grep -E '(^|/)node_modules/' "$work/web.txt" | head -5 || true)
[[ -z $hits ]] || fail "$web_image: node_modules in the image: $hits"
# The site root holds only build output: no sources, source maps, or the MSW worker (dev only).
hits=$(grep -E '^srv/ascrum/.*(\.tsx?|\.map|\.less|mockServiceWorker\.js)$' "$work/web.txt" || true)
[[ -z $hits ]] || fail "$web_image: sources or dev files in the site root: $hits"

if [[ $findings -gt 0 ]]; then
  echo "AC-CTR-02: $findings finding(s)" >&2
  exit 1
fi
echo "AC-CTR-02: both images run as non-root and contain no dev dependencies, test files or .env files"
