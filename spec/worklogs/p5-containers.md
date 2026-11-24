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

## 2026-11-23, session 2 (worker, after the review of #60 blocked on DEV-p5-containers-05)

### What was done
- **Merged `origin/migration`** (#59, p5-security, `ae6405a`) into the branch. Conflicts: `MIGRATION.md`,
  `spec/journal.md`, `spec/deviations.md` (bookkeeping, both sides kept: the p5-security rows and
  summary counts plus this cluster's ten rows; the summary now counts 84 rows) and `api/src/main.ts`
  (#59's `startApi()` with the health check kept right after `startStubServer()`).
- **Owner answers recorded** in `spec/questions/p5-containers.md`: Q-1 (b), Q-2 (a) extended, Q-3 (a),
  Q-4 (a), and close DEV-06..-09 before merge.
- **DEV-05, the integration fixes.**
  - *Which `web/stub/` files reach the API image: derived from the real import graph.*
    `docker/api/import-graph.ts` loads `api/src/main.ts` under a `module.registerHooks()` resolve hook and
    prints every file Node resolved under the app root (outside `node_modules`). The `.dockerignore` now
    lets in all non-test `api/src/*.ts` and `web/stub/*.ts`; a build stage runs the script and copies
    exactly that list into the image. Why this over "all non-test `web/stub/*.ts`": that rule would also
    ship `contractTests.ts`, `securityTests.ts` (test helpers that are not `*.test.ts`) and `msw.ts`, and
    would need a name list to keep them out, which drifts the same way the old allowlist did. The import
    graph is what the process loads, so a new contract file gets in by itself, and a new helper stays out
    by itself. Type-only imports are erased by type stripping and are (correctly) not listed. Today's
    graph: 9 files in `api/src`, 7 in `web/stub` (with `throttle.ts`).
  - *The check that let it through.* `check-images.sh` now (a) runs the same script **inside the built
    image** (`--network none`, script bind-mounted): an import smoke test that fails on
    `ERR_MODULE_NOT_FOUND`, and the loaded list must equal the `.ts` files present (none missing, none
    extra); (b) **starts the API image** with only `DATABASE_URL` against a throwaway PostgreSQL (the
    compose `db` image) on a private `--internal` network, waits for Docker's health status `healthy`
    and asks `/healthz` itself (200 `{"status":"ok"}`); (c) checks the API image's `CMD` is
    `["node","api/src/main.ts"]` and that no compose service using the image overrides `command` or
    `entrypoint` (so every container goes through `loadConfig()`, the condition attached to
    DEV-p5-security-16). The `/app` allowlist no longer names `web/stub/` files; the graph decides.
  - *Compose.* `api`: `APP_ENV: development` beside `ALLOW_RESET: '1'`, and `TRUST_PROXY_HOPS: '1'`.
    `api-prod`: `TRUST_PROXY_HOPS: '1'` only (production mode by default, no `ALLOW_RESET`). Both sit
    behind one nginx, which sets `X-Forwarded-For $proxy_add_x_forwarded_for` (appends the address it
    saw), and the API reads the n-th entry from the right, so a client can only prepend entries it
    cannot make count.
  - *The throttle sees distinct clients through nginx:* new `docker/check-client-address.sh` (CI step
    after the Playwright run). 20 failed sign-ins from the host through `web`, each for another account
    and with another forged `X-Forwarded-For` (198.51.100.x), then the 21st gets 429; `login_throttle`
    holds one per-address row (`ip:172.20.0.1 20`) and none of the forged ones; then a second client at
    another address (the `api` container calling `http://web:8080`) signs in at once (200). Reset before
    and after.
  - *§3.3 narrowed to 404 only*, and the bare POST's body (`{"message":"Not found"}`) and absence of
    cookies pinned too (AC-SEC-03).
- **Q-1 (b).** The pool's `'error'` listener moved from `addHealthCheck()` to the top of `startApi()`
  (before `migrate()`), with a comment; `health.ts` now only points there. The test is unchanged
  (comment updated).
- **DEV-06.** The §3.3 test asserts web-prod's 404 is nginx's own: `text/html`, `<center>nginx</center>`,
  no `)]}',` prefix. If web-prod routed `/__stub/` to api-prod, the 404 would be the API's JSON.
- **DEV-07.** New test "§3.6 / DEV-p5-containers-07" on both web configurations: `/databasesX` is the
  app; two API 404s (unknown collection, unknown document) pass through with status, JSON type, prefix
  and message; `Server` is exactly `nginx` and no page shows `nginx/<version>`; `/assets/` is 404 and no
  `Index of`.
- **DEV-08 (bug fixed).** `absolute_redirect off;` in the nginx template. New test "DEV-p5-containers-08"
  on both web configurations: `/databases`, `/assets`, `/img`, `/databases/`, `/assets/` without
  following redirects; every 3xx `Location` must not contain `:8080` and must resolve to the caller's
  origin, and `/databases` must be among the redirects (so the test cannot pass vacuously).
- **DEV-09.**
  - `db` pinned: `postgres:18.7-alpine3.24@sha256:0115267a…` (the multi-arch index digest; same digest as
    `18-alpine` today, `PG_VERSION` 18.7, Alpine 3.24.4 read from the image).
  - Both Dockerfiles now write each pin out on its `FROM` line instead of `FROM ${NODE_IMAGE}`:
    Dependabot's docker parser matches literal `FROM` lines only (`FROM_LINE` regex in dependabot-core's
    `docker/lib/dependabot/docker/file_parser.rb`, which has no ARG substitution). Session 1's comment
    "Dependabot's docker ecosystem can bump both together" was wrong for the ARG form.
  - `.github/dependabot.yml`: a `docker` entry for `/docker` (grouped) and a `docker-compose` entry for
    `/`, both into `migration`, prefix `deps`. Source: GitHub Docs, "Dependabot supported ecosystems and
    repositories" (docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories):
    `docker` (v1) and `docker-compose` (v2, v3) both list version updates as supported and
    **security updates as "Not supported"**; "Dependabot supports Docker Compose in a similar way to
    Docker". The fetcher picks files whose name matches `/dockerfile|containerfile/i`, which also
    matches `api.Dockerfile.dockerignore`; it has no `FROM` line, so it should yield no dependency. Worth
    watching on the first Dependabot run. Existing entries and comments unchanged.
  - `check-images.sh`: every `FROM` in `docker/*.Dockerfile` (except earlier stage names) and every
    compose image not built here must match `name:<tag with a digit>@sha256:<64 hex>`; compose services
    with `pull_policy: never` are exempt only if their image is one a `build` service produces.
  - `check-images.sh`, secrets: for both images, the history entries **our** Dockerfile adds (the image's
    history minus its runtime base's, pulled by its pinned ref; the script refuses if the tail does not
    match) and the full `docker image inspect` JSON (Env, Labels, Cmd, Entrypoint, Healthcheck) go into a
    temp folder scanned by `gitleaks dir --redact --ignore-gitleaks-allow` with its default rules
    (`GITLEAKS_CONFIG*` unset). Plus a name rule: no `ENV` name like `PASSWORD`, `SECRET`, `TOKEN`,
    `CREDENTIAL`, `PRIVATE`, `API_KEY`, `ACCESS_KEY`. CI installs Gitleaks in `e2e-compose` exactly as
    `secrets.yml` does (version 8.30.1, release tarball, SHA-256 check); the comment says to move both
    together. No new tool.
- **CI (`e2e-compose`).** New steps: install Gitleaks; the client-address check after Playwright. The
  check-images step name lists what it now covers.

### Red before, green after
Each breakage alone, then restored (`git diff` clean against the change). nginx breakages were applied by
mounting a modified template over `/etc/nginx/templates/default.conf.template` through a compose
override file in my scratch folder; image breakages were small Dockerfiles `FROM ascrum-api:p5c` built
in my scratch folder (never in the repo). "Old" = the checks on `30ea63a` (the merge, before this
session's changes); for the e2e rows, the old spec narrowed to 404 as the reviewer did.

| Gap | Breakage | Old checks | New checks |
|---|---|---|---|
| DEV-05 start-up | API image built from session 1's Dockerfile and allowlist (no `throttle.ts`) | `check-images.sh` exit 0 (`AC-CTR-02: both images …`); the container exits `ERR_MODULE_NOT_FOUND … /app/web/stub/throttle.ts` | red, 2 findings: import graph fails (`ERR_MODULE_NOT_FOUND`), start-up `exited unhealthy` |
| DEV-05 start-up | `ENV ALLOW_RESET=1` in the API image (loads, crashes at start in production mode) | (not checked) | red: does not start (`config.ts:62`) |
| DEV-05 extra file | `contractTests.ts` copied into `/app/web/stub/` | red (named in the old allowlist) | red: `> web/stub/contractTests.ts` present but never loaded |
| DEV-p5-security-16 | API image `CMD` replaced by a plain HTTP server | (not checked) | red: CMD finding; and start-up red (no `/healthz`) |
| DEV-p5-security-16 | compose `api-prod` with `command:` override | (not checked) | red: services that override … `api-prod` |
| TRUST_PROXY_HOPS | `api` with `TRUST_PROXY_HOPS: '0'` | (no check) | red: second client gets `429 not-signed-in` |
| TRUST_PROXY_HOPS | nginx `X-Forwarded-For $http_x_forwarded_for` (passes the client's header) | (no check) | red: 21st sign-in 200, forged header trusted |
| TRUST_PROXY_HOPS | `api` with `TRUST_PROXY_HOPS: '2'` | (no check) | red: 21st sign-in 200 |
| TRUST_PROXY_HOPS | nginx sets no `X-Forwarded-For` | (no check) | red: 21st sign-in 200 |
| Q-1 (b) | listener removed from `startApi()` | — | red: integration run exit 1, "Errors 1 error" (unhandled `57P01` from the terminated backend; the 5 assertions themselves pass) |
| DEV-06 | B8: `ROUTE_STUB_CONTROL: 'on'` on `web-prod` | green, 4/4 (survived, as in the review) | red: §3.3 test, `content-type` `application/json`, not `text/html` |
| DEV-07 | B10: `location /databases` (no slash) | green 4/4 | red: `/databasesX` 404, not 200 (and DEV-08's test) |
| DEV-07 | B11: `proxy_intercept_errors on; error_page 404 = /index.html` | green 4/4 | red: unknown collection 200, not 404 |
| DEV-07 | B12: `server_tokens on` | green 4/4 | red: DEV-07 test (`Server`) and §3.3 (error page shows `nginx/1.30.6`) |
| DEV-07 | B13 as the reviewer described it: `autoindex on` in `location /assets/` | green 4/4 | **green 6/6: an equivalent mutant.** `try_files $uri =404` answers before the index module, so the listing is unreachable (`/assets/` is still 404) |
| DEV-07 | B13 made effective: `autoindex on` plus `try_files $uri $uri/ =404` | green 4/4 | red: `/assets/` 200, not 404 |
| DEV-08 | template without `absolute_redirect off` (the shipped config of session 1) | green 4/4 | red: `/databases` `Location` contains `:8080` |
| DEV-09 | B15: `FROM node:24-alpine` | green | red: not pinned |
| DEV-09 | pin through `ARG NODE_IMAGE=…@sha256:…` / `FROM ${NODE_IMAGE}` | green | red: not written out (Dependabot cannot read it) |
| DEV-09 | `FROM node:alpine@sha256:…` (digest, no version) | green | red |
| DEV-09 | compose `db: postgres:18-alpine` | green | red: service db not pinned |
| DEV-09 | B14: `ARG DB_PASSWORD=<random 32>` + `ENV DATABASE_PASSWORD=$DB_PASSWORD` | green | red: Gitleaks (generic-api-key in `inspect.json` and twice in `history.txt`) and the name rule |
| DEV-09 | `ENV APP_OPTS="api_key=<random 32>"` (harmless name) | green | red: Gitleaks only |
| DEV-09 | `ARG BUILD_HELPER_TOKEN=<random 32>` used by a `RUN` (visible only in history) | green | red: Gitleaks (history) |
| DEV-09 | `LABEL …="ghp_<random 36>"` (GitHub token shape) | green | red: Gitleaks `github-pat` |
| DEV-09 | `ENV PGPASSWORD=ascrum` (low entropy) | green | red: name rule only |

The planted values were random strings generated for the run (no real credential), lived only in my
scratch folder and in throwaway local images (`ascrum-api:p5c-r*`, removed at the end), and were never
committed or pushed; no draft PR was needed.

### Decisions
- **Import graph over a broader glob** (above). The cost: the build stage needs `pg` installed before it
  can list the graph (it already has it), and a module loaded only through a computed dynamic `import()`
  would not be listed; the start-up check would catch that.
- **Gitleaks scans our layers, not the base's.** The first run on the web image found a
  `generic-api-key` in the *nginx base image's* history: the `KEY_SHA512=…` of nginx's package signing
  key, which is public. Base layers are the upstream's and the image scan's (wave C) business; this
  check is about what our Dockerfiles add. The script proves the split: it fails if the image history
  does not end with the base's history exactly.
- **The name rule beside Gitleaks**, because Gitleaks' generic rule needs entropy and a keyword, and
  skips values that contain a stopword (below).
- **The start-up check uses no host port**: private `--internal` network, Docker's own health status,
  and `docker exec` for `/healthz`. Its containers and network are removed by an `EXIT` trap, also on
  failure.
- **The client-address check is a script, not Playwright**: the second client must come from another
  address, which only a container on the compose network has. `api` has Node, so no extra image.
- **The direct API ports** (`API_PORT`, `PROD_API_PORT`) skip nginx; with `TRUST_PROXY_HOPS: 1` a caller
  there could pick its throttle key. They are bound to 127.0.0.1 and exist for `/healthz` and §3.3
  checks; noted in `compose.yaml`.

### Mistakes and wrong turns
- **"FAKE" made the secret invisible.** My first planted values were `FAKE<random>`, to look obviously
  fake. Gitleaks found none of them: its generic rule ignores a match that contains a stopword, and
  "fake" is one. Only the name rule caught the `DATABASE_PASSWORD` variant. Rerun with plain random
  strings: all red. A check proven only with a "FAKE"-prefixed plant would have looked weaker than it is;
  a real secret has no such word.
- **The questions file.** I first inserted each owner answer before the *next* question's heading, which
  put Q-2's answer under Q-1 and Q-1's under Q-2. Caught on reading it back, before committing.
- **The import-graph stage** first had a leftover `cp`/`rm` line from an earlier idea; removed before the
  first build.
- **`/assets` did not redirect in my probe** (200, the SPA fallback, because `try_files $uri` does not
  match a directory); only `/databases` redirected to `:8080`. The test checks all of `/databases`,
  `/assets`, `/img` and the slash forms anyway.
- **B13 as described is an equivalent mutant** (table): the reviewer's "survived" was right, but no test
  could have turned it red, since the shipped `try_files` hides the listing either way.

### Gate results (this session, from `web/`, Node 24.22.3, `STUB_PORT=3901 PREVIEW_PORT=5073 PAGES_PORT=5074`, `DATABASE_URL` → the compose db on 55439)
- `pnpm verify` → exit 0:
  ```
  All matched files use Prettier code style!
   Test Files  41 passed (41)
        Tests  435 passed (435)
   Test Files  6 passed (6)
        Tests  81 passed (81)
    41 passed (24.0s)
  ```
- Compose stack, project `ascrum-p5-containers`, ports 55439–55443, from an empty volume (`down --volumes`
  first), on the tree as committed:
  ```
  docker compose --profile prod-check build             → exit 0
  docker/check-images.sh ascrum-api:p5c ascrum-web:p5c  → exit 0
    pins: every FROM and every pulled compose image is pinned by version and digest
    ascrum-api:p5c: USER=node, runs as uid 1000
    ascrum-api:p5c: no secret in its 12 own history entries or the image config
    ascrum-api:p5c: main.ts loads exactly the 16 .ts files in /app
    ascrum-api:p5c: starts with only DATABASE_URL and answers /healthz: 200 {"status":"ok"}; [api] listening on http://localhost:3000 (production mode)
    ascrum-web:p5c: USER=101, runs as uid 101
    ascrum-web:p5c: no secret in its 6 own history entries or the image config
    check-images: AC-CTR-02 (non-root, no dev dependencies, test files or .env), pins, no secrets in layers or config, the API loads and starts
  docker compose --profile prod-check up --wait          → exit 0, 5/5 healthy in 11 s
  pnpm e2e:compose                                       → 47 passed (38.2s)
  docker/check-client-address.sh                         → exit 0 (per-address rows: ip:172.20.0.1 20; second client 200 signed-in)
  docker/check-health.sh                                 → AC-CTR-03: probes create no session; unhealthy without the database; healthy again when it is back
  ```
  `api` logs `development mode`, `api-prod` logs `production mode`.
- `shellcheck` 0.10.0 on the three scripts and `actionlint` 1.7.7 on `ci.yml` (from their images, removed
  afterwards): no findings.

### AC → test (changes only)
| Item | Test / check |
|---|---|
| §3.3 | `compose.spec.ts` › "§3.3 / DEV-p5-containers-06: …" (404 only; nginx's own 404 on web-prod; API's JSON 404 without cookies on api-prod) |
| AC-CTR-01 / §3.6 | `compose.spec.ts` › "§3.6 / DEV-p5-containers-07: …", "DEV-p5-containers-08: …" |
| AC-CTR-02 + DEV-05/-09 | `docker/check-images.sh` (pins, secrets, import graph, start-up, CMD) |
| AC-SEC-04 behind nginx | `docker/check-client-address.sh` (CI step in `e2e-compose`) |
| AC-CTR-03 / Q-1 (b) | `api/src/health.test.ts` › "AC-CTR-03: the API outlives the database dropping its connections …" (listener now in `startApi()`) |

### For the re-reviewer
- `spec/deviations.md` and `MIGRATION.md` changed only by the merge (both sides kept); no edit of mine.
- The `docker-compose` Dependabot ecosystem and the `.dockerignore` files matching the docker fetcher's
  filename pattern can only be confirmed by Dependabot's first run on `migration`.
- The Gitleaks version now lives in two workflows (`secrets.yml`, `ci.yml`); nothing checks that they agree.
