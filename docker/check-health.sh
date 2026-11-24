#!/usr/bin/env bash
# AC-CTR-03 on the running compose stack (the unit-level tests are in api/src/health.test.ts):
#   1. Docker's own health probes create no sessions row;
#   2. with the database stopped, the api container turns unhealthy and keeps running;
#   3. with the database back, it turns healthy again by itself.
#
#   docker/check-health.sh        (from the repo root, with the stack up and the same compose
#                                  environment, e.g. COMPOSE_PROJECT_NAME, as `docker compose up`)
#
# It stops and starts the `db` service, so run it after the e2e suite, not during it.
set -euo pipefail

api=$(docker compose ps -q api)
[[ -n $api ]] || { echo "AC-CTR-03 FAIL: the api service is not running" >&2; exit 1; }

state() { docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "$api"; }
probes() { docker inspect --format '{{len .State.Health.Log}} {{(index .State.Health.Log 0).Start}}' "$api"; }
sessions() { docker compose exec -T db psql -U ascrum -d ascrum -tAc 'SELECT count(*) FROM sessions'; }

wait_for() {
  local want=$1 deadline=$((SECONDS + 60))
  until [[ $(state) == "$want" ]]; do
    if ((SECONDS >= deadline)); then
      echo "AC-CTR-03 FAIL: api is '$(state)' after 60 s, expected '$want'" >&2
      docker compose logs --tail 30 api >&2
      exit 1
    fi
    sleep 1
  done
  echo "api: $want after $((60 - deadline + SECONDS)) s"
}

wait_for 'running healthy'

# 1. Docker keeps the last 5 probe results; after 10 s at a 2 s interval all 5 are new ones.
before=$(sessions)
first=$(probes)
sleep 10
after=$(sessions)
[[ $(probes) != "$first" ]] || { echo "AC-CTR-03 FAIL: no health probe ran in 10 s" >&2; exit 1; }
[[ $after == "$before" ]] || { echo "AC-CTR-03 FAIL: sessions went from $before to $after during health probes" >&2; exit 1; }
echo "sessions rows: $before before and $after after 10 s of health probes"

# 2. and 3.
docker compose stop db
wait_for 'running unhealthy'
docker compose start db
wait_for 'running healthy'
echo 'AC-CTR-03: probes create no session; unhealthy without the database; healthy again when it is back'
