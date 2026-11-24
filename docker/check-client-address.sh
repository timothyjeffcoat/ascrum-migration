#!/usr/bin/env bash
# The per-address login throttle (p5-security, AC-SEC-04) behind nginx, on the running compose stack.
# The `api` service sits behind one proxy (web's nginx) and has TRUST_PROXY_HOPS=1, so it must key on
# the address nginx saw, which nginx appends to X-Forwarded-For ($proxy_add_x_forwarded_for):
#   1. a client cannot pick its key: 20 failed sign-ins from the host through nginx, each with a different
#      forged X-Forwarded-For, use up the host's 20 and the 21st gets 429;
#   2. two clients are two keys: a client at another address (a container on the compose network) still
#      signs in through the same nginx at once.
# Without TRUST_PROXY_HOPS the API sees nginx's address for every client and (2) gets 429; if nginx
# passed the client's header on instead of appending to it, the forged entries would count and (1)
# would get no 429.
#
#   docker/check-client-address.sh        (from the repo root, with the stack up and the same compose
#                                          environment as `docker compose up`, e.g. COMPOSE_PROJECT_NAME)
#
# It resets the stack before and after (POST /__stub/reset, the local/CI configuration), so run it after
# the e2e suite, not during it.
set -euo pipefail

web="http://localhost:${WEB_PORT:-55430}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fail() {
  echo "check-client-address FAIL: $*" >&2
  docker compose logs --tail 20 web api >&2 || true
  exit 1
}

reset() {
  local status
  status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$web/__stub/reset")
  [[ $status == 204 ]] || fail "POST /__stub/reset answered $status"
}

reset
# A session and its XSRF token, as the front end gets them.
curl -s -o /dev/null -c "$work/jar" "$web/current-user"
token=$(awk '$6 == "XSRF-TOKEN" { print $7 }' "$work/jar")
[[ -n $token ]] || fail "no XSRF-TOKEN cookie from /current-user"

sign_in() { # <email> <password> <forged X-Forwarded-For>
  curl -s -o /dev/null -w '%{http_code}' -b "$work/jar" -H "X-XSRF-TOKEN: $token" -H "X-Forwarded-For: $3" \
    -H 'Content-Type: application/json' --data "{\"email\":\"$1\",\"password\":\"$2\"}" "$web/login"
}

# 1. Twenty failures, each from a "different" forged address (documentation range, RFC 5737), for a
#    different account, so only the per-address limit (20) can stop the 21st.
for i in $(seq 1 20); do
  status=$(sign_in "nobody$i@example.test" wrong "198.51.100.$i")
  [[ $status == 200 ]] || fail "failed sign-in $i answered $status, expected 200 {user:null} (legacy)"
done
status=$(sign_in nobody21@example.test wrong 198.51.100.21)
[[ $status == 429 ]] || fail "the 21st failed sign-in from one client answered $status, not 429: the forged X-Forwarded-For was trusted"
echo "1. 20 failed sign-ins with forged X-Forwarded-For, then 429: the key is the address nginx saw"

# What the API counted: one address (the host, as nginx saw it), none of the forged ones.
keys=$(docker compose exec -T db psql -U ascrum -d ascrum -tAc \
  "SELECT key || ' ' || failures FROM login_throttle WHERE key LIKE 'ip:%' ORDER BY key")
echo "   per-address rows: $(tr '\n' ';' <<< "$keys")"
[[ $(wc -l <<< "$keys") == 1 ]] || fail "expected one per-address row, got: $keys"
! grep -q '198\.51\.100\.' <<< "$keys" || fail "a forged address was counted: $keys"

# 2. Another client, at its own address on the compose network (the api container, which has Node),
#    through the same nginx: the right password signs in, because its address has no failures.
other=$(docker compose exec -T api node --input-type=module -e "
  const base = 'http://web:8080'
  const first = await fetch(base + '/current-user')
  const cookies = first.headers.getSetCookie().map((c) => c.split(';')[0])
  const xsrf = decodeURIComponent(cookies.find((c) => c.startsWith('XSRF-TOKEN=')).split('=')[1])
  const login = await fetch(base + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': xsrf, Cookie: cookies.join('; ') },
    body: JSON.stringify({ email: 'admin@abc.com', password: 'changeme' }),
  })
  console.log(login.status, (await login.text()).includes('admin@abc.com') ? 'signed-in' : 'not-signed-in')
")
[[ $other == '200 signed-in' ]] || fail "a second client at another address got '$other' while the first is throttled: the API does not see client addresses through nginx"
echo "2. a client at another address signs in through the same nginx at once: $other"

reset
echo 'TRUST_PROXY_HOPS: the throttle keys on the client address nginx saw, and a forged X-Forwarded-For does not move it'
