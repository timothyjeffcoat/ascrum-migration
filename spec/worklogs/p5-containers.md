# Worklog: cluster p5-containers (Phase 5, wave B)

## 2026-11-23, session 1 (worker)

**Preconditions checked:** `spec/phase5-spec.md` reads `APPROVED rev 2`; wave A is merged (`6941064`,
"Wave A closed"), and the orchestrator opened wave B. Branch `convert/p5-containers` from `migration` at
`6941064`, in its own worktree. Ports: e2e 3901/5073/5074; compose project `ascrum-p5-containers`, host
ports 55439–55443.

### What was done
- **API image** (`docker/api.Dockerfile`, context = repo root):
  - two stages on `node:24.22.3-alpine3.24` (pinned by version and digest). `deps` installs api/'s
    production dependencies alone (`pnpm install --prod --frozen-lockfile --ignore-scripts`, pnpm at
    web/package.json's `packageManager` through corepack, no workspace file, so only `pg` and its
    dependencies). The runtime stage copies those, `api/src` (without tests), the migrations and the six
    contract files from `web/stub/` that the API imports (p5-store's note), and runs
    `node api/src/main.ts` as `node` (uid 1000). Files stay root-owned, so the process cannot rewrite them.
  - `docker/api.Dockerfile.dockerignore` is an allowlist: `*`, then only those files back in, with tests,
    `testDb.ts` and `.env*` excluded even if a pattern would match them.
  - Config from the environment only: `DATABASE_URL`, `PORT` (default 3000), `ALLOW_RESET` (unset).
  - `HEALTHCHECK` with Node's own `fetch` on `/healthz`.
- **Health endpoint** (`api/src/health.ts`, registered in `startApi()`; AC-CTR-03): `GET`/`HEAD`
  `/healthz` answers 200 `{"status":"ok"}` when `SELECT 1` answers within 2 s, else 503
  `{"status":"unavailable"}`; `Cache-Control: no-store`; 405 for other methods. It runs **before**
  `handle()`, so a probe never creates a session row or gets a cookie. Why the path cannot clash: see
  the header of `health.ts` (handle() routes only the contract paths and `/__stub/reset`; the match is
  exact; the web origin does not route `/healthz` at all).
- **Web image** (`docker/web.Dockerfile`): `vite build` (production mode, not Pages) in a Node stage,
  then `nginxinc/nginx-unprivileged:1.30.6-alpine3.24` (uid 101, port 8080, pinned by digest) serving
  `dist/` from `/srv/ascrum`. `docker/web/default.conf.template`: `/login`, `/logout`, `/current-user`
  (exact) and `/databases/` go to `${API_UPSTREAM}`; `/assets/` is `try_files $uri =404`; everything else
  falls back to `index.html`. `/__stub/` returns 404 unless `ROUTE_STUB_CONTROL=on`.
- **Security headers from p5-security's module:** `docker/web/security-headers.ts` imports
  `web/securityHeaders.ts` at image build time and writes `add_header <name> "<value>" always;` plus
  `proxy_hide_header <name>;` for every entry, included once at server level. It refuses a missing
  module, an empty map, a non-string value, a bad name, a duplicate name and a value containing `$`,
  `"`, `\` or a control character (nginx would expand or mis-quote those). Tested locally with a
  placeholder module that existed only in a scratch copy of the tree, never in this worktree.
- **compose.yaml:** `db` (unchanged apart from comments), `api` and `web` with health checks and
  `depends_on: condition: service_healthy`; profile `prod-check` adds `api-prod` and `web-prod`, the same
  images with their defaults (production configuration), for the §3.3 test. Every host port is on
  127.0.0.1 and overridable; `IMAGE_TAG` keeps parallel checkouts' images apart.
- **Playwright:** `E2E_BASE_URL` points the `chromium` project at a running stack and starts only the
  Pages server; unset, nothing changes. New `web/e2e/containers/compose.spec.ts` (4 tests), which only
  the external run includes. `pnpm e2e:compose` (web/package.json) builds the Pages bundle and runs the
  whole suite with the four URLs derived from the same port variables as compose.
- **AC-CTR-02 check:** `docker/check-images.sh` inspects the built images: configured `USER` and the uid
  a container really gets; every file (`docker export | tar -t`) for `.env`, test files and test
  folders; for the API, an allowlist of what may be in `/app` outside `node_modules`, and none of
  api/package.json's devDependencies installed; for web, no `node_modules` at all and no sources, maps or
  MSW worker in the site root.
- **AC-CTR-03 at container level:** `docker/check-health.sh`: Docker's probes add no sessions row over
  10 s; `docker compose stop db` turns the api `running unhealthy`; `start db` turns it healthy again.
- **CI:** job `e2e-compose` in `.github/workflows/ci.yml` (only that job): build both images, AC-CTR-02
  check, `docker compose --profile prod-check up --wait`, `pnpm e2e:compose`, `check-health.sh`, logs on
  failure, and `down --volumes` under `if: always()`.
- **Gates cover the new TypeScript:** `pnpm lint` and `pnpm typecheck` now include `docker/`
  (`docker/eslint.config.js` re-exports web's config like api/ does; `docker/.prettierrc.json` points at
  web's; `docker/tsconfig.json` extends web's strict config). Checked that they bite: a planted `as any`
  is an ESLint error and a planted type error fails `tsc` (both reverted).

### Decisions
- **Migrations at start, not a separate step.** `startApi()` already applies pending migrations under a
  PostgreSQL advisory lock before it listens, and seeds only a database it has just created. Two
  containers starting together cannot race (p5-store's AC-PG-02 test), and compose needs no extra
  one-shot service. The image can still run `node api/src/migrate.ts` as an explicit step (same image,
  other command); wave C may prefer that so the app's database role needs no DDL rights (notes below).
- **nginx over a small Node static server:** it is one well-known process for static files and the
  reverse proxy, with an official non-root image; a Node server would be new code for path safety, MIME
  types, streaming and proxying. The cost is nginx's add_header inheritance trap, handled by declaring
  the headers once at server level, saying so in the config, and a test over every kind of response.
- **Alpine bases:** the smallest official images that still have a shell and busybox (wget for the web
  health check, `id` for the non-root check). Distroless Node would be smaller but has no tag per Node
  version to pin.
- **Two locks on the reset route:** the API needs `ALLOW_RESET=1` (spec §3.3) and the web origin needs
  `ROUTE_STUB_CONTROL=on` to route `/__stub/` at all. Both images default to off; only compose's `api`
  and `web` services (local and CI) turn them on. The e2e files reset through the web origin
  (`request.post('/__stub/reset')` on the base URL), which is why the web side needs the switch.
- **Third-party test files pruned.** `pg-protocol` ships `*.test.js`/`.ts` and `pg-types` a `test/`
  folder. Nothing requires them; the deps stage deletes `*.test.*` and package-level `test(s)/` and
  `__tests__/` folders. The e2e run against the image proves the API still works.
- **npm, npx, corepack and yarn removed from the API's runtime stage:** the API never installs anything
  at run time; fewer tools for an attacker and fewer packages for the wave C image scan. They are in the
  base layers, so the image is not smaller for it.
- **`init: true` on the API services** (found by measuring, see mistakes): Node as PID 1 ignored SIGTERM,
  so every `docker compose stop api` took 10.3 s (SIGKILL); with an init process it takes 0.27 s.
- **The security-header test reads the module itself** (computed-path dynamic import, since the file does
  not exist on this branch yet) and asserts each header exactly once with exactly its value, on index,
  SPA fallback, a hashed asset, a public file, a 404 asset, a proxied API answer, a proxied API error and
  the reset path, on both `web` and `web-prod`.

### Measurements (this machine, Docker 29.6.2)
| Image | `docker image ls` (unpacked) | Compressed (`inspect .Size`) | Base image | Our layers (unpacked) |
|---|---|---|---|---|
| API | 245 MB | 62.7 MB | node:24.22.3-alpine3.24: 244 MB / 62.5 MB | ~1.2 MB (node_modules 983 kB, sources 57 kB + 57 kB, migrations 25 kB) |
| web | 90.9 MB | 25.8 MB | nginx-unprivileged:1.30.6-alpine3.24: 90.1 MB / 25.6 MB | ~0.64 MB (dist 598 kB, config 41 kB) |

- Cold builds (`--no-cache`, base images already pulled): API 5.9 s, web 32.0 s (pnpm install of web's
  dev dependencies and `vite build`).
- `docker compose --profile prod-check up --wait` from an empty volume, images built: 10.0 s until all five
  services were healthy.
- Playwright against the stack: 41 tests (37 existing + 4 container checks), 13.8 s.
- `check-health.sh`: unhealthy 2–8 s after the database stopped (three runs: 2, 7, 8 s), healthy 2 s
  after it was back.

### Breakages run against my own checks (each alone, in a scratch copy, then discarded)
| # | Breakage | Caught by |
|---|---|---|
| M0 | `addHealthCheck` not registered in `startApi` | `health.test.ts`: "…200 … no session row" (1 of 4 red) |
| M0b | no pool `'error'` listener | `health.test.ts`: the run ends with an unhandled error (exit 1) |
| M1 | an `add_header Cache-Control …` in `location /assets/` (the inheritance trap) | "AC-CTR-01 / S-p5-5: …" |
| M2 | web image default `ROUTE_STUB_CONTROL=on` | "§3.3: …" (web-prod answered the reset) |
| M3 | API image default `ALLOW_RESET=1` | "§3.3: …" (api-prod reset the database) |
| M4 | health check registered nowhere (container level) | `up --wait` fails (api never healthy); all 4 container tests red |
| M5 | `USER node` removed | `check-images.sh`: USER unset, uid 0 |
| M6 | `testDb.ts` let into the API image | `check-images.sh`: test helper |
| M7 | `pnpm install` without `--prod` | `check-images.sh`: dev dependency `@types/pg` installed |
| M8 | a `.env` in `web/public/` and the `.env*` ignore rule removed | `check-images.sh`: `srv/ascrum/.env` |
| M8b | the same `.env`, ignore rule kept | not in the image (the rule works) |
| M9 | no pool `'error'` listener, container level | `check-health.sh`: api `exited unhealthy`, expected `running unhealthy` |
| — | `web/securityHeaders.ts` missing (the real state of this branch) | web image build stops with "web/securityHeaders.ts is missing …" |

An earlier M8 (ignore rule removed, no `.env` anywhere) "survived": an equivalent mutant, since there
was nothing to leak.

### Mistakes and wrong turns
- **The API crashed when the database went away** (not my code, found by my check): the first
  `docker compose stop db` turned the api container `exited`, not `unhealthy`. `pg.Pool` emits `'error'`
  for a dropped idle connection and nothing listened. Fixed in `health.ts` (Q-p5-containers-1,
  DEV-p5-containers-01) with a test that terminates the pool's backend.
- **`testIgnore: /(pages|containers)\//` ignored the whole chromium suite in this worktree**, whose path
  contains `p5-containers/`. The first `pnpm verify` was green with only **4** Playwright tests (the
  Pages project). I caught it reading the count, not the exit code. Now anchored at `e2e/containers/`;
  the next run had 37. The old `/pages\//` has the same weakness for a checkout under a folder called
  `pages`; I left that pattern as it was.
- My first draft of the health test expected 503 for `HEAD` on a pool with an empty schema; `SELECT 1`
  needs no table, so it is 200. Fixed before the first run.
- The web image's first build failed because the allowlist did not let in the nginx template.
- My scratch mutation script used `set -u`, which breaks `nvm.sh`; the first M1 "failure" was nvm, not
  the test. Rerun without `-u`.
- Stop time: the API took 10.3 s to stop under compose until `init: true` (decisions above).

### Proposed deviation rows (the reviewer writes `spec/deviations.md`)
- `DEV-p5-containers-01 | §3.1 / AC-CTR-03 | The API now survives PostgreSQL dropping idle connections: a pool 'error' listener (in health.ts) logs and the pool reconnects. Before, the process exited (uncaught 'error' event) | worker (compose check) | non-blocking | test "AC-CTR-03: the API outlives the database dropping its connections …"; check-health.sh; Q-p5-containers-1 | this PR`
- `DEV-p5-containers-02 | §3.6 / N1 | New API path GET/HEAD /healthz, outside the legacy contract. It runs before handle() (no session, no cookie), and the web origin does not route it | worker (design) | non-blocking | header of api/src/health.ts; health.test.ts; compose.spec.ts | this PR`
- `DEV-p5-containers-03 | AC-CTR-02 | The web image drops mockServiceWorker.js from the vite build output (the production build never registers it) | worker (design) | non-blocking | web.Dockerfile; check-images.sh; Q-p5-containers-3 | this PR`
- `DEV-p5-containers-04 | §6 | e2e-compose is red until web/securityHeaders.ts exists (p5-security), and the §3.3 test accepts 403 or 404 for a reset POST without session/XSRF until p5-security's AC-SEC-03 lands | worker (design) | non-blocking | Q-p5-containers-2 | this PR / p5-security`

### Notes for wave C (p5-infra)
- **Which images deploy:** under Q-p5-4 (a) only the API image goes to ECS; the web build goes to S3 and
  CloudFront. The web image is then a local/CI stand-in for CloudFront, so CloudFront's behaviours must
  mirror `docker/web/default.conf.template` (the four contract paths to the API, SPA fallback) and its
  response headers policy should be generated from `web/securityHeaders.ts` the same way, not copied.
- **Health checks:** ECS ignores the Dockerfile `HEALTHCHECK`; put `/healthz` in the task definition
  and the target group (port 3000). It answers 503 while the database is down, so every target goes
  unhealthy together during an RDS outage or failover; ALB then fails open to all targets, which is
  acceptable here, but say so in the design.
- **Signals:** set `initProcessEnabled: true` (linuxParameters) in the task definition, the ECS twin of
  compose's `init: true`, or a task stop waits for its `stopTimeout`.
- **Migrations:** at start under an advisory lock (safe for several tasks). For a least-privilege app
  role, run `node api/src/migrate.ts` as a one-off task with a DDL role, then start the service with a
  DML-only role. The seed is loaded only when migration 001 is applied (a brand-new database).
- **Secrets:** `DATABASE_URL` carries the password. Inject it as an ECS secret from Secrets Manager
  (S-p5-4). RDS needs TLS; `pg` takes `sslmode` in the URL but the image has no RDS CA bundle, so either
  add the bundle to the image (a decision, not done here) or configure `ssl` in code (p5-store's file).
- **Scanning (ECR scan-on-push):** both bases are pinned by version and digest. Dependabot's docker
  ecosystem should watch `/docker` so the digests move (p5-devsecops's config, not mine). The API image
  no longer has npm/yarn/corepack in its filesystem.
- **CDK `DockerImageAsset`:** build with directory = repo root and `file: 'docker/api.Dockerfile'`.
  Docker honours `docker/api.Dockerfile.dockerignore`, but CDK's asset hash reads only a root
  `.dockerignore`, so give the asset an explicit `exclude` or accept extra rebuilds.
- **Architecture:** the bases are multi-arch; Fargate on Graviton (arm64) is cheaper and needs
  `--platform linux/arm64` (or buildx) at build time.
- **Sessions:** health probes no longer add rows, but DEV-p5-store-03 (no expiry) still stands.

### Gate results (this session, from `web/`, Node 24.22.3, `STUB_PORT=3901 PREVIEW_PORT=5073 PAGES_PORT=5074`, `DATABASE_URL` → the compose db on 55439)
- `pnpm verify` → exit 0:
  ```
  $ eslint --max-warnings 0 . ../api ../docker && prettier --check . ../api ../docker
  All matched files use Prettier code style!
  $ tsc --noEmit -p tsconfig.json && tsc --noEmit -p ../docker/tsconfig.json
  $ vitest run --project unit
   Test Files  41 passed (41)
        Tests  416 passed (416)
  $ vitest run --project integration
   Test Files  4 passed (4)
        Tests  43 passed (43)
  $ pnpm build && pnpm build:pages && playwright test
    37 passed (13.5s)
  ```
  (Integration: 38 before this cluster, +5 in `api/src/health.test.ts`.)
- Compose stack (scratch copy of this tree plus a placeholder `web/securityHeaders.ts`, project
  `ascrum-p5-containers`, ports 55439–55443), from an empty volume:
  ```
  docker compose --profile prod-check up --wait      → all 5 services healthy, 10.0 s
  docker/check-images.sh                             → AC-CTR-02: both images run as non-root and contain no dev dependencies, test files or .env files
  pnpm e2e:compose                                   → 41 passed (13.8s)   [37 chromium incl. 4 container checks, 4 pages]
  docker/check-health.sh                             → AC-CTR-03: probes create no session; unhealthy without the database; healthy again when it is back
  ```
- `shellcheck` 0.10.0 on both scripts and `actionlint` 1.7.7 on `ci.yml` (run from their images, then
  removed): no findings.

### AC → test
| AC | Test(s) / CI step |
|---|---|
| AC-CTR-01 | CI `e2e-compose`: "AC-CTR-01 docker compose up, wait until every service is healthy" and "AC-CTR-01 the full Playwright suite against the stack"; `web/e2e/containers/compose.spec.ts` › "AC-CTR-01 / §3.6: one origin …", "AC-CTR-01 / S-p5-5: both web configurations send exactly web/securityHeaders.ts …" |
| AC-CTR-02 | CI step "AC-CTR-02 images run as non-root, no dev dependencies, test files or .env" (`docker/check-images.sh`) |
| AC-CTR-03 | `api/src/health.test.ts` (5 tests named AC-CTR-03: 200 and no session row; 503 when refused; 503 within the timeout when the database hangs; survives dropped connections; exact path and methods); `compose.spec.ts` › "AC-CTR-03: the API container answers /healthz …"; CI step "AC-CTR-03 the api health check without the database …" (`docker/check-health.sh`) |
| §3.3 | `compose.spec.ts` › "§3.3: the production configuration answers 404 to POST /__stub/reset and resets nothing" (web-prod and api-prod) |

### Questions
Q-p5-containers-1..4 in `spec/questions/p5-containers.md`, none blocking. Q-p5-containers-2 is the merge
order with p5-security (recommended: p5-security first).

### Legacy-case table
Not applicable: spec §9 assigns no legacy test cases to Phase 5 clusters.
