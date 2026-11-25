# Worklog: fix-slow-login (spec §0.2 P7, DEV-owner-04)

Branch `convert/fix-slow-login`, from `origin/migration`. Test-only follow-up. Owned paths:
`web/e2e/forms-enter.spec.ts`, this worklog and `spec/questions/fix-slow-login.md` (not needed).

## 2026-11-25: session 1

### Why
P7 ("one sign-in at a time") was covered only by the jsdom test in `web/src/auth/LoginModal.test.tsx`,
which calls `requestSubmit()` twice in one tick. The slow-reply case the orchestrator measured once in
Chromium (POST /login held for 500 ms, a second Enter sent a second POST) was a throwaway script. A
reader asked whether that case is in the suite; the owner decided to add it.

### What was done
One Playwright test in `web/e2e/forms-enter.spec.ts`, in the existing `Enter in forms (P4)` describe
(so it keeps the file's `POST /__stub/reset` in `beforeEach`):
`P7 / DEV-owner-04: Enter twice while the sign-in reply is held sends one POST /login`.

- `page.route` with a predicate `url.pathname === '/login'`. In the `chromium` project the app calls
  `/login` at the origin root (`api/http.ts` builds `new URL(path, window.location.origin)`), and
  `vite preview` proxies it to the Node stub (`STUB_PATHS` in `vite.config.ts`). Non-POST requests to
  that path fall through with `route.fallback()`.
- Each POST is counted synchronously at the start of the handler, then held on a promise. The test
  presses Enter in the password field, waits until the first POST has reached the route (a promise,
  not a timer), and presses Enter again.
- **No fixed sleep for the negative check.** Without the guard, the second Enter's submit handler calls
  `fetch` synchronously (`onLogin` → `login` → `request` → `fetch`, with no `await` in between). The test
  then sends a sentinel `fetch('/login?e2e-p7-sentinel')` from the page, which the same route fulfils
  with 204. Once the sentinel has come back, any second POST has already reached the route, so
  `loginPosts` is checked there (exactly 1), the modal is still open, and it shows no `.alert-error`.
- Then the held reply is released with `route.continue()`, the real stub answers, the modal closes,
  the header shows the `Admin User` link, no `.alert-error` is on the page, and the count is still 1.

### Decision: `chromium` only, no config change
The `pages` project in `playwright.config.ts` has `testMatch: /pages\/.*\.spec\.ts/`, and `chromium`
ignores `pages/`. So `forms-enter.spec.ts` already runs only in `chromium`; nothing needs scoping. Checked
with `pnpm exec playwright test --list -g P7`: one entry, `[chromium]`. It should not run in `pages`
either: there MSW answers inside a service worker, and Playwright's `page.route` does not see requests
that a service worker handles, so the reply could not be held and the count would be 0. No question
file was needed.

### Proof that it bites (red without the guard)
Temporarily replaced `if (signingIn.current) return` in `web/src/auth/LoginModal.tsx` with a comment,
rebuilt (`pnpm build`) and ran the test:

```
Error: expect(received).toBe(expected) // Object.is equality
Expected: 1
Received: 2
  > 75 |     expect(loginPosts).toBe(1)
1 failed
```

The same mutation with `--repeat-each=20`: **20 failed**, every one `Received: 2` (the sentinel keeps
the red deterministic too). Restored with `git checkout -- web/src/auth/LoginModal.tsx`; `git status`
then listed only `web/e2e/forms-enter.spec.ts`, and `git diff --stat -- web/src` was empty. Rebuilt
before every later run.

### Flakiness
With the guard back: `pnpm exec playwright test e2e/forms-enter.spec.ts --project chromium -g P7
--repeat-each=20` → **20 passed (13.1s)**, each run about 230–270 ms.

### Mistakes and wrong turns
- The first run used the shell's default Node 22: the Pages server crashed with
  `ERR_HTTP_HEADERS_SENT`. Under Node 24 the same crash remained, because `dist-pages/` had not been
  built yet (a focused `playwright test` still starts every web server). `pnpm build:pages` fixed it.
- The first `pnpm verify` exited 1 at `pnpm test:integration`: no `DATABASE_URL`. Started a throwaway
  PostgreSQL container (the compose image, host port 55470, removed afterwards) and reran.

### Gates (this session, from `web/`, Node 24, ports 4501/5673/5674, `DATABASE_URL` on 55470)
`pnpm verify`: **exit 0**.
```
$ eslint --max-warnings 0 . ../api ../docker && prettier --check . ../api ../docker
All matched files use Prettier code style!
$ tsc --noEmit -p tsconfig.json && tsc --noEmit -p ../docker/tsconfig.json
 Test Files  42 passed (42)
      Tests  443 passed (443)
 Test Files  6 passed (6)
      Tests  87 passed (87)
  42 passed (24.0s)
```
The reviewer's gate grep (`rg -n "\.(skip|only|todo|fixme|fails)\b|\['(skip|only)'\]|\.extend\(| as [a-z]+ \}" web/e2e`):
no matches (exit 1).
