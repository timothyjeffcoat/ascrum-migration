# Worklog: cluster p5-security (Phase 5, wave B)

## 2026-11-23, session 1 (worker)

**Preconditions checked:** `spec/phase5-spec.md` reads `APPROVED rev 2`; wave A (p5-store,
p5-devsecops) is merged (`6941064`, "Wave A closed"), so wave B is open. Branch `convert/p5-security`
from `migration` at `6941064`, in its own worktree. Ports 3801/4973/4974; PostgreSQL 18 from the repo's
`compose.yaml` under my own compose project (`-p ascrum-p5-security`, `DB_PORT=55438`, which
`compose.yaml` already reads, so no override file was needed).

### Decisions, per item

**S-p5-1 / AC-SEC-01: hashing.**
- `api/src/passwords.ts`: `node:crypto` scrypt, 16-byte random salt per hash, 32-byte key, stored as
  `scrypt$<log2N>$<r>$<p>$<salt>$<key>` (base64url). Parameters N = 2^17, r = 8, p = 1, the OWASP
  minimum for scrypt, about 0.25 s per hash here (measured: 2^14 31 ms, 2^15 62 ms, 2^16 133 ms,
  2^17 254 ms). The hash carries its parameters, so the cost can rise later without a migration.
  `timingSafeEqual` for the compare; a malformed or absurd stored value never matches.
- Migration `002_security.sql` adds `users.password_hash`. The hash has its own column so a value can
  never be read as the other kind. SQL cannot compute scrypt, so rows written before 002 (any local
  database from wave A) are hashed by `PgStore.hashPlainPasswords()` when the API starts, which also
  empties the old `password` column. Tested from a database migrated to 001 only.
- Login moved into the store: `Store.usersByEmail()` became `findLogin(email, password)`, because
  PgStore can only compare hashes. S8 ("a users PUT without password keeps the stored one") moved into
  both stores as well: in `handle()` it fed the stored value back in as the new password, which with a
  hash would hash the hash.
- Reads never return the hash (`secret` column in `schema.ts`, left out of every SELECT); `handle()`
  still strips `password` from every response (D7) as before. A non-string password is dropped instead
  of being kept in `extra` (it could never sign in: login needs a non-empty string).
- An unknown e-mail pays for one decoy hash, so response time does not reveal which e-mails exist.
- **The in-memory stub keeps plain text, on purpose.** It runs in the browser (Pages demo, `dev:msw`)
  and in jsdom, where `node:crypto` scrypt does not exist (WebCrypto has PBKDF2 but no scrypt, and only
  async). Its data is the public seed whose credentials are in the README, it lives only in memory,
  and passwords never leave `handle()` (D7, AC-STUB-11). Nothing anyone can observe would change, so
  this was a decision and not a question. Comment in `store.ts`. Proposed DEV row below.
- Seed hashes are cached per PgStore instance, so a reset (dev and CI only) does not pay scrypt six
  times again. Each seed user still has a salt of its own.

**S-p5-2 / AC-SEC-02: cookie flags; "production mode" defined.**
- Production mode is the env var `APP_ENV`: `production` **or unset**; only `APP_ENV=development`
  turns it off. Fail closed: a deployment that forgets the variable gets `Secure` cookies and no reset
  route. Any other value stops the API at start-up. All variables are documented in one table at the
  top of `api/src/config.ts`.
- Cookies: `SameSite=Lax` always (one origin, nothing legitimate posts cross-site); `Secure` in
  production mode; `sid` `HttpOnly` as before; `XSRF-TOKEN` not `HttpOnly` (the front end reads it).
  Set in the Node adapter (`web/stub/server.ts`, option `secureCookies`), so `pnpm stub`, `pnpm dev`
  and Playwright (plain http) are unchanged apart from `SameSite=Lax`. MSW writes `document.cookie`
  itself and is unaffected.

**S-p5-3 / AC-SEC-04: throttling.**
- Fixed window per key, failures only: 5 failed sign-ins per e-mail and 20 per client address in
  15 minutes, then `429` with `)]}',\n{"message":"Too many failed sign-ins. Try again later."}` and
  `Retry-After: <seconds>`. Env vars `LOGIN_MAX_FAILURES_PER_ACCOUNT`, `LOGIN_MAX_FAILURES_PER_IP`,
  `LOGIN_THROTTLE_WINDOW_SECONDS`. Why these: 5 covers typos; 20 lets several people behind one NAT
  address mistype without locking each other out and still caps one address at 80 guesses an hour.
  A success clears the account's count. A refused attempt is not counted. The check runs after XSRF
  (unchanged order) and before the password is checked (no scrypt work for a blocked key).
- The account key is the e-mail exactly as sent, like the lookup (DEV-p5-store-08). Known cost of a
  per-account limit: anyone can lock an account for up to 15 minutes by failing 5 times. Accepted for
  this app; a CAPTCHA or per-account backoff would be a product change.
- Counts live in PostgreSQL (`login_throttle`, migration 002) so several API containers share them and
  a restart keeps them; one upsert per key, no read-modify-write. The memory stub has
  `MemoryLoginThrottle` but runs **without** a throttle unless a test asks for one, as legacy (the
  Playwright suite signs in many times from one address).
- **Client address and proxies.** `TRUST_PROXY_HOPS` (default 0). With 0 the socket address is used
  and `X-Forwarded-For` is ignored, so a client that reaches the API directly cannot choose its own
  key. With n > 0 the n-th entry from the right is used: each proxy appends, so only entries our own
  proxies appended can be believed, and whatever a client prepends is ignored. For wave C,
  CloudFront → ALB → API is 2 hops, and that only holds if the ALB accepts traffic from CloudFront
  alone. Under MSW there is no address, so only the per-account limit applies.
- Front end: the modal already shows `login.error.serverError` for any HTTP error (S14), so no app
  change was needed. The new test drives the stub's real throttle (not an injected 429).

**AC-SEC-03: reset route 404.** `handle()` now answers `/__stub/reset` before sessions and XSRF in
both cases: 204 when allowed (as before), and 404 `{message:"Not found"}` with no cookie and no session
row when not. The XSRF rule protects state-changing routes; a route that does not exist changes
nothing, and the 404 for exactly this path tells a scanner only that it is absent. Every real route and
every other unknown path still checks XSRF first (test "AC-SEC-03: the XSRF rule is unchanged for every
real route, and for unknown ones"). Also, `ALLOW_RESET=1` in production mode stops the API at start-up.

**S-p5-5 / AC-SEC-05: headers.** `web/securityHeaders.ts` exports `securityHeaders: Record<string,
string>` (name and shape as agreed with p5-containers): CSP (`default-src 'self'`, script/style/font/
connect/worker/manifest `'self'`, `img-src 'self' https://www.gravatar.com`, `object-src 'none'`,
`base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`,
`Permissions-Policy` (camera, microphone, geolocation, payment, usb off). Reasons are in the file.
Applied to `vite preview` only (the dev server's HMR needs inline script). No HSTS and no
`upgrade-insecure-requests`: both belong to the TLS terminator (CloudFront, wave C) and would break or
be ignored on http://localhost.
- **Gravatar**: "own assets only" conflicts with AC-GRAV-01; raised as Q-p5-security-1, implemented
  option (a), images from that one host.
- **Pages build**: GitHub Pages cannot send response headers, so the Pages demo runs without them.
  A `<meta http-equiv>` CSP would be possible but needs an `index.html`/build change outside my paths
  (and cannot carry `frame-ancestors`). Not done; noted for the owner.

**S-p5-4: secrets.** Everything the API needs comes from the environment (`config.ts`). `git grep`
for passwords, tokens, keys and connection strings outside `legacy/`, tests and the seed found only the
documented throwaway local/CI database credentials (`compose.yaml`, `ci.yml`, a hint in `testDb.ts`).
There is no session-signing secret to manage: sessions are random server-side ids, not signed cookies.

**Hand-overs from wave A.**
- **DEV-p5-store-03:** sessions expire after `SESSION_IDLE_SECONDS` (default 8 h, a working day) of
  inactivity; each request moves `last_seen_at` (one `UPDATE … RETURNING` that only matches a live
  row); the API deletes expired sessions and ended throttle windows every `SESSION_SWEEP_SECONDS`
  (default 600) on an unref'd timer. Same semantics in `MemorySessions`. Session **rotation** at login:
  the session moves to a new `sid` (`Sessions.rotate`, one `UPDATE sessions SET sid`), the old one is
  gone. See Q-p5-security-2 for the XSRF token. Note for p5-containers: a cookie-less health check
  still creates a session row on each call; the sweep removes it after the idle lifetime, but a health
  route that does not touch sessions is better (it is their AC-CTR-03).
- **DEV-p5-store-10:** the lookup is now `findLogin()`; the e-mail is bind parameter `$1`. Two guards:
  three new payloads in `INJECTED_EMAILS` (`x$e$ OR admin --`, `x$$ OR admin --`, and `x\' OR admin --`
  for an `E''` builder that doubles quotes), and a structural test that records every statement a
  sign-in sends (a `connect` listener on a fresh pool) and asserts the e-mail is never in the SQL text
  and is in the parameters.
- **DEV-p5-store-11:** the O1 order test now moves the "Checkout" item to Mobile App and back (a
  non-HOT update of the indexed `project_id`) before the filtered check.

### Red, then green
Tests were written first and run against the unchanged code (Vitest strips types, so options the code
did not know yet were simply ignored and the behaviour is what failed).
- Unit, `stub/handlers.test.ts` + `LoginModal.test.tsx` on `6941064` + new tests: `Tests 8 failed |
  32 passed (40)`. AC-SEC-04 ×4 `expected 200 to be 429`; rotation `expected undefined to be truthy`
  (no new sid); DEV-p5-store-03 expiry `expected { user: {…} } to deeply equal { user: null }`;
  sweep `ctx.sessions.sweep is not a function`; **AC-SEC-03 `expected 403 to be 404`** (the wave A
  finding). `LoginModal.test.tsx` failed to import (`stub/throttle.ts` did not exist yet).
- AC-SEC-01/02/03 on the real API: `api/src/security.test.ts` could not import its new modules, so its
  red is an import error, not behaviour. Behavioural evidence from the unchanged API instead
  (`node api/src/main.ts` on my database, then removed): `Set-Cookie: sid=…; Path=/; HttpOnly` and
  `XSRF-TOKEN=…; Path=/` (no Secure, no SameSite); `POST /__stub/reset` without the header → `403`;
  `SELECT email, password FROM users` → `admin@abc.com | changeme`, `po@ascrum.test | demo`, ….
- AC-SEC-05 e2e, with `securityHeaders.ts` present but not applied to preview: `2 failed | 1 passed`
  (headers `Received: undefined`; the enforcement control found no `script-src` violation). The
  "no violation on any screen" test passed with no CSP at all, which is why the control test exists.
- The hand-over tests close test gaps in correct code, so they are red only against a mutant (below).
- Green after implementing: unit `430 passed (430)`, integration `65 passed (65)`, e2e security
  `3 passed`.

### Mutations (each alone, reverted with `git checkout`, tree clean after)
Runner script in my scratch space; results:

| # | Mutant | Suite | Result |
|---|---|---|---|
| M1 | DEV-p5-store-10: lookup spliced into `$e$…$e$` | integration | 3 red: DEV-p5-store-07, AC-PG-05 login, DEV-p5-store-10 structural |
| M2 | DEV-p5-store-11: `ORDER BY` only without `WHERE` | integration | 1 red: DEV-p5-store-06 / O1 |
| M3 | plain text in `password_hash`, compared as text | integration | 44 red (incl. all 3 AC-SEC-01) |
| M4 | `Secure` never set | integration | 1 red: AC-SEC-02 production |
| M5 | throttle never consulted | unit | 5 red incl. the LoginModal 429 test |
| M6 | reset checked only when allowed (wave A order) | unit | 1 red: AC-SEC-03 |
| M7 | no `sid` rotation at login | unit | 1 red: rotation test |
| M8a | `MemorySessions` never expire | unit | 1 red: DEV-p5-store-03 |
| M8b | `PgSessions` never expire on read | integration | 1 red: DEV-p5-store-03 (+1 timeout, below) |
| M9 | sweep timer does nothing | integration | 1 red: sweep timer test (+1 timeout, below) |
| M10 | left-most `X-Forwarded-For` trusted | integration | 2 red: clientIpOf, one-proxy HTTP test |
| M11 | Pg: success does not clear the account | integration | 1 red |
| M12 | Pg: PUT without password clears the hash | integration | 2 red: AC-STUB-12, AC-SEC-01 S8 |
| M13 | CSP `img-src` without Gravatar | e2e | 1 red: "no violation on any screen" |
| M14 | CSP `script-src 'unsafe-inline'` | e2e | 1 red: enforcement control |

### Mistakes and wrong turns
- **XSRF rotation was visible to the front end.** My first rotation also issued a new XSRF token. The
  full unit run then failed `src/api/http.test.ts` AC-API-07 (cluster 0), which pins the token sent by
  the retry after login. N1 makes that a question: Q-p5-security-2. I changed to rotating the `sid`
  only, which the front end cannot see, and kept the test green without touching it.
- **AC-PG-02's table list** failed with the new `login_throttle` table: an expected update in my path.
- **Playwright `response.headers()`** omits security headers; I first misread the result as
  `vite preview` not sending them to assets. `curl` showed it did; switched to `allHeaders()`, and kept
  the first (200) response per asset because later navigations revalidate with a 304.
- **A flaky-by-design test caught in the mutation run:** the first AC-SEC-01 test, at production
  scrypt cost, timed out at 5002 ms in two mutation runs (M8b, M9) where the mutant had nothing to do
  with it. I moved every API test that does not need it to the cheap test cost and gave the two
  production-cost tests an explicit 30 s timeout. `TEST_SCRYPT` (N = 2^10) is the same code path; the
  first AC-SEC-01 test pins that `startApi`'s default is `PRODUCTION_SCRYPT`.
- Two shell slips while probing: `pkill -f "api/src/main.ts"` matched my own shell and killed it
  (twice); nothing else was affected. And one inline edit script was refused by the command checker;
  I redid it with the Edit tool.

### Proposed DEV rows (for the reviewer; I do not write `spec/deviations.md`)
- **DEV-p5-security-01** (S-p5-1): PgStore stores scrypt hashes; MemoryStore keeps plain text (browser
  and jsdom have no scrypt; no observable difference). `Store.findLogin` replaces `usersByEmail`; S8
  moved into the stores.
- **DEV-p5-security-02** (S-p5-2): `SameSite=Lax` on both cookies in every mode (legacy and the stub
  set none); `Secure` in production mode, which is `APP_ENV` unset or `production`.
- **DEV-p5-security-03** (S-p5-3, Q-p5-10 (b)): 429 + `Retry-After` after 5/account or 20/address
  failures in 15 minutes, API only; the memory stub does not throttle.
- **DEV-p5-security-04** (AC-SEC-03): with reset off, `/__stub/reset` is 404 before XSRF.
- **DEV-p5-security-05** (session fixation): login moves the session to a new `sid`; the old `sid` reads
  as a new anonymous session. XSRF token kept (Q-p5-security-2).
- **DEV-p5-security-06** (DEV-p5-store-03): sessions expire after 8 h idle and are swept; legacy
  sessions never expired.
- **DEV-p5-security-07** (S-p5-5): CSP allows Gravatar images (Q-p5-security-1); the Pages demo has no
  security headers.

### Notes for other clusters
- **p5-containers:** serve `securityHeaders` from `web/securityHeaders.ts` as is. The API image needs
  `APP_ENV=development` wherever it sets `ALLOW_RESET=1` (compose, e2e-compose): otherwise it refuses
  to start. If the web container proxies the API paths, set `TRUST_PROXY_HOPS=1` on the API. Playwright
  against compose signs in from one address: 20 failed sign-ins per 15 minutes is the limit, and
  `POST /__stub/reset` clears it. The production image must run with `APP_ENV` unset or `production`.
- **Wave C (p5-infra):** `DATABASE_URL` from Secrets Manager; `APP_ENV=production` (or unset);
  `TRUST_PROXY_HOPS=2` for CloudFront → ALB, with the ALB reachable from CloudFront only; HSTS on the
  CloudFront response headers policy; the same `securityHeaders` map for the S3/CloudFront web build.
- **Later migration:** `users.password` (plain, from 001) is empty after the first start on 002 and can
  be dropped once every database has started once. With nothing deployed yet that could be now, but a
  local wave A volume would lose its passwords, so I left it.

### Questions
- Q-p5-security-1 (CSP and Gravatar): implemented (a), pending.
- Q-p5-security-2 (rotate the XSRF token at login too): implemented (a), pending.
Neither blocks the PR.

### Gates (this session, from `web/`, with `DATABASE_URL` on my own Postgres)
`pnpm verify` on `da0068b` (code as pushed; this worklog is the only later change), exit 0:
```
$ eslint --max-warnings 0 . ../api && prettier --check . ../api
All matched files use Prettier code style!
$ tsc --noEmit -p tsconfig.json
 Test Files  41 passed (41)          # unit
      Tests  430 passed (430)        # was 413 on migration: +16 security (memory), +1 LoginModal 429
 Test Files  4 passed (4)            # integration (PostgreSQL 18)
      Tests  65 passed (65)          # was 38: +27 in api/src/security.test.ts
✓ built in 347ms                     # dist
✓ built in 369ms                     # dist-pages
  40 passed (24.3s)                  # Playwright, was 37: +3 in e2e/security.spec.ts
```
