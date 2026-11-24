# Questions raised by cluster p5-containers (Phase 5, wave B)

Ids are `Q-p5-containers-<n>` (spec §8, `conversion-spec.md` §8.5). None blocks this cluster; each
is implemented as recommended and can be changed without touching the images' contract.

**Q-p5-containers-1. The API crashed when the database dropped its connections (not blocking; fixed
in the health module).**
Context: `api/src/main.ts` creates a `pg.Pool` with no `'error'` listener. When PostgreSQL drops an idle
connection (a restart, a failover, `docker compose stop db`), the pool emits `'error'`, and an `'error'`
event with no listener is an uncaught exception: the API process exits. Found while proving AC-CTR-03
under compose: the api container went to `exited`, not `unhealthy`. A health check cannot report from
a dead process, and on ECS a crash loop replaces the task instead of letting it reconnect. My owned
paths in `api/src` are the health endpoint and its registration only.
Options: (a) attach the listener in `addHealthCheck()` (my file), with a comment and a test that
terminates the pool's backend and expects the API to answer afterwards; (b) attach it in `main.ts`
next to `new pg.Pool` (p5-store's line; a one-line change outside my paths); (c) leave it and rely on a
restart policy.
*Recommended and implemented: (a)*, proposed as DEV-p5-containers-01. Test "AC-CTR-03: the API
outlives the database dropping its connections, and /healthz recovers" (`api/src/health.test.ts`) and
`docker/check-health.sh` (container stays `running`). (b) is the tidier home if the owner prefers it;
the test stays the same.

*Answer (2026-11-23, owner, relayed by the orchestrator): (b)*: move the pool's `'error'` listener into
the API's own start-up, so the process survives dropped connections whether or not the health module
is loaded; keep the test. Done in session 2: the listener is in `startApi()` (`api/src/main.ts`), and
`addHealthCheck()` no longer attaches one.

**Q-p5-containers-2. Merge order with p5-security (not blocking; a dependency to sequence).**
Context: two things on this branch depend on p5-security's work.
1. The web image serves exactly `web/securityHeaders.ts` (`export const securityHeaders:
   Record<string, string>`), generated at build time. That file does not exist on `migration` yet, so the
   web image build fails on purpose ("web/securityHeaders.ts is missing …"), and with it the
   `e2e-compose` job. Every other check is unaffected.
2. The §3.3 test expects 404 from the production API for `POST /__stub/reset` sent with a valid session
   and XSRF header (true today and after p5-security). A bare POST without them gets 403 today (the XSRF
   check runs before routing, p5-store's note); p5-security makes it 404 (AC-SEC-03). The test accepts
   403 or 404 for the bare POST only, and checks that nothing was reset either way.
Options: (a) p5-security merges first; then this branch merges `migration` in, `e2e-compose` goes green,
and the bare-POST assertion is narrowed to 404 in the same commit; (b) this PR merges first with a red
`e2e-compose` (not yet required), and p5-security's PR turns it green and narrows the assertion.
*Recommended: (a).* `e2e-compose` then never merges red, and the narrowing is done by the cluster that
owns the test file.

*Answer (2026-11-23, owner, relayed by the orchestrator): (a), extended.* #59 merged first (`ae6405a`);
this branch merged `migration` in and made the integration fixes the review found (DEV-p5-containers-05):
the API image takes its source files from the real import graph, `check-images.sh` starts the image,
`APP_ENV: development` beside `ALLOW_RESET`, `TRUST_PROXY_HOPS: 1` behind nginx, and the bare-POST
assertion narrowed to 404. Done in session 2 (worklog).

**Q-p5-containers-3. MSW's service worker in the production build (not blocking; left out of the
image).**
Context: `vite build` copies all of `web/public/` into `dist/`, including `mockServiceWorker.js`, which
the `msw` dev dependency generates. Only the Pages and msw modes register it; the production build never
does (`web/src/main.tsx`). AC-CTR-02 says no dev dependencies in the image.
Options: (a) delete it from `dist/` in the web image's build stage (my file); (b) make `vite.config.ts`
skip it outside the Pages/msw modes (not my path; would also change what `vite preview` serves in e2e).
*Recommended and implemented: (a)*; `docker/check-images.sh` fails if it comes back. (b) is the cleaner
long-term place.

*Answer (2026-11-23, owner, relayed by the orchestrator): (a)*, keep as implemented.

**Q-p5-containers-4. How the health check is put in front of the contract (not blocking; implemented).**
Context: the API is the contract's Node adapter, `startStubServer()` in `web/stub/server.ts` (not my
path), which creates the server with one request listener and offers no hook. `/healthz` must run
before `handle()`, or every probe creates a sessions row (DEV-p5-store-03).
Options: (a) `addHealthCheck()` takes the adapter's listener off the server and puts a dispatcher in
its place (exactly `/healthz` answered there, everything else passed to the original listener); (b) add
an option to `startStubServer()` for a handler that runs first (a change in `web/stub/`); (c) a second
port for health only.
*Recommended and implemented: (a)*, commented in `api/src/health.ts` and pinned by four tests (path
exact, other paths pass through, no session row, wiring in `startApi`). (b) is tidier if `web/stub/`
changes for another reason; (c) would add a port to every load balancer and task definition.

*Answer (2026-11-23, owner, relayed by the orchestrator): (a)*, keep as implemented.

The owner also asked for the test gaps DEV-p5-containers-06, -07, -08 and -09 to be closed before
merge (DEV-10 stays accepted). Done in session 2 (worklog).
