# Worklog: cluster 0 (foundation)

Branch `convert/foundation`, from `origin/migration` at `e773901`. Owned paths per spec §8.1 row 0.

## 2026-11-20 (local; 2026-11-21 UTC): session 1, the whole cluster

### What was done
- **api/**: `http.ts` (prefix stripping, XSRF header read at send time, 401 → retry queue, pending
  counter + `usePendingRequests`), `collection.ts`, `collections.ts`, `ids.ts`, `errors.ts`
  (`ApiError`, D10), `types.ts` (§5.5).
- **auth/**: `retryQueue.ts`, `currentUser.ts` (S11 shared in-flight request), `loginDialog.ts`
  (module store, S7), `guards.ts`, `AuthProvider.tsx`, `useAuth.ts`, `LoginModal.tsx` (S14),
  `LoginToolbar.tsx`.
- **notifications/**: `messages.ts` (all 20 keys of §5.4), `store.ts` (two buckets, S15),
  `useNotifications.ts`, `rotation.ts` (`router.subscribe` rotation).
- **crud/**: `useCrudForm.ts` (§4.2 contract), `CrudButtons.tsx`, `useListNav.ts`, `crudRoutes.ts`,
  `validators.ts` (`required`, `email`, `equalsField`).
- **domain/**: `projects.ts` (roles, D13, D20, candidates), `users.ts`, `tasks.ts`.
- **app/**: `router.tsx`, `bootApp.tsx`, `AppRoot.tsx` (§4.1 composition), `AppShell.tsx`,
  `Header.tsx`, `Breadcrumbs.tsx` + `breadcrumbs.ts`, `NotificationsOutlet.tsx`, `RouteError.tsx`,
  `RootErrorBoundary.tsx`, `errorMessage.ts`. `main.tsx` now boots the app.
- **Placeholder feature routes** for all 8 features. Paths and guards are final per §5.3 (R1 public,
  R2–R12 `requireAuthenticatedUser`, R13–R18 `requireAdminUser`); the components are one-line
  placeholders, and the loaders contain only the guard.
- **src/test/renderRoute.tsx**: `await renderRoute(path, {as, routes?})`, plus `resetClientState()`,
  `signIn(persona)` and `recordRequests()` (an MSW `request:start` observer, not an override).
- **e2e/shell.spec.ts**: 9 tests, on `vite preview` + Node stub and on the Pages build.

### §11-4 proof (gate for wave A)
All in `web/src/app/routerDataMode.test.tsx` (real composition via `bootApp`, the same code
`main.tsx` runs), plus e2e:
| Test | Proves |
|---|---|
| `§11-4 / §4.1: the login modal sits outside RouterProvider, so a guard in an initial loader can open it while the router renders nothing at all` | the composition itself |
| `§11-4 / §4.1 / AC-AUTH-09: reloading a guarded deep link while logged out opens the login modal, and logging in as admin completes the original navigation` | deep-link reload → modal → login → original navigation completes, same router, no reload |
| `§11-4 / AC-AUTH-03: a non-admin deep link shows the "not authorized" reason; Cancel goes to / (and on to /projectsinfo) without an error` | cancel during the initial load |
| `§11-4 / AC-AUTH-06: on a later navigation the guard waits with the previous view in place, then completes after login` | guard on a non-initial navigation |
| `§11-4 / AC-NOT-01: router.subscribe rotates the notifications BEFORE the new route renders` | rotation ordering, observed from inside the new route's first render |
| `§11-4 / AC-NOT-04: RouteError's notification lands after the rotation, so it survives; the next navigation clears both` | rotation vs RouteError's effect |
| e2e `AC-AUTH-09: reloading a guarded deep link…` and `AC-SHELL-06 / AC-AUTH-09: a deep-link reload works under the Pages basename…` | the same flow in Chromium, at base `/` and `/ascrum-migration/` |

**Mutation checks** (run by hand, files restored, not committed):
- Moving `<LoginModal/>` from `AppRoot` into `AppShell` (inside the router): the first five tests above
  all **still passed**, because the shell is rendered during the initial load (see the decision on
  `HydrateFallback` below). So they did not pin the composition. I added the first test in the
  table, which renders a tree with no shell; with the mutation it fails.
- Replacing the `router.subscribe` rotation with a `useEffect` on `location.key` in the shell: the
  two rotation tests fail.

### Decisions (spec silent or needing interpretation)
- **Module stores, not React state, for the user, the dialog and the notifications.** Loaders run
  outside React, and a data router starts the first navigation's loaders when it is created, before
  anything renders. `AuthProvider` reads the stores with `useSyncExternalStore`; context only for auth
  (CLAUDE.md).
- **`bootApp()`** holds start-up (`requestCurrentUser()`, create the router, subscribe the rotation,
  wrap in `StrictMode`). `main.tsx` and `renderRoute` both call it, so the tests run the real order.
- **The shell during the initial load.** The root route's `HydrateFallback` renders the shell with no
  breadcrumbs and an empty content area, as legacy showed the header around an empty `ng-view`
  until the first `$routeChangeSuccess`. A side effect: the shell re-mounts when the first load
  completes (only the admin dropdown's open state is lost).
- **`/` redirects to `/projectsinfo`** through an index route. `*` does not match `/` under the root
  route, and legacy's `otherwise` did, which matters because cancel and logout navigate to `/`.
- **Escape and a backdrop click cancel the login** (legacy ui-bootstrap `$dialog` closed on both,
  and `security.js` treated a close without success as a cancel). Ported for parity.
- **The login form's labels gained `for`/`id`** so the fields have accessible names (Q-foundation-1).
- **A failed logout is swallowed and the user stays logged in** (D19, legacy parity).
- **`ApiError(0)`** for a network failure, as AngularJS reported status 0; `RouteError` treats it as
  a route change error.
- **`useCrudForm`**: async results are discarded when a newer request started or the value changed;
  `revert()` also drops in-flight async checks and async errors (the restored values are the loaded
  ones). A saved document removed without a `remove` option throws (no silent no-op).
- **§5.6 drafts** live with the feature screens that own the "new" routes (clusters 1–4). The
  foundation supplies `Draft<T>` and the payload rule that omits `undefined` keys.
- **`RouterProvider` is imported from `react-router`, not `react-router/dom`.** Under Vitest the two
  entry points resolved to different module copies and the hooks lost the router context
  (`useNavigate() may be used only in the context of a <Router>`). The DOM variant only adds
  `flushSync` support, which nothing here uses.

### Questions
- Q-foundation-1 (label `for`/`id`), implemented as recommended; not blocking.
- Q-foundation-2 (CLAUDE.md should show `await renderRoute(...)`), outside owned paths; not blocking.

### Mistakes and wrong turns
- The prescribed shell prefix (`source ~/.nvm/nvm.sh && nvm use 24`) was refused by the worktree
  sandbox, as were compound commands that mixed `cd` and `git`. I put Node 24's `bin` directory on
  `PATH` instead (`node v24.22.3`, `pnpm 12.21.0`) and ran git commands on their own.
- First run of the §11-4 tests: every test failed with "useNavigate() may be used only in the context
  of a <Router>", the dual-entry-point problem above.
- `navigate('/')` after Cancel stayed on `/`: the `*` route doesn't match `/` (fixed with the index
  route).
- The tests I first wrote for the composition didn't pin it (see the mutation checks).
- A test left an "unhandled rejection" (a cancelled retry whose promise only got a handler after the
  click); fixed by attaching the handler when the item is queued.
- After moving the shell into `HydrateFallback`, the logout test clicked a stale "Log out" button found
  before the first load finished. The fix first waited on the pathname, which is already `/projects`
  before the load completes, so it could still have been flaky; it now waits on `router.state.initialized`.
- I left a dead helper and a pointless "warm-up" click in the first draft of `routerDataMode.test.tsx`;
  removed before the first commit.

### Gate results (this session)
`pnpm verify` (lint + typecheck + test + build + e2e), run with `set -o pipefail`, exit code 0:
```
$ eslint --max-warnings 0 . && prettier --check .
All matched files use Prettier code style!
$ tsc --noEmit -p tsconfig.json
 Test Files  23 passed (23)
      Tests  181 passed (181)
✓ built in 334ms            (vite build)
✓ built in 356ms            (vite build --mode pages)
  18 passed (4.2s)          (Playwright: 5 harness + 9 shell + 4 pages)
```
Of the 181 unit tests, 160 are this cluster's (21 files under `src/`); the other 21 are the Phase 2
stub tests. The full unit suite was also run 3 times in a row with no failures (flakiness check).

### AC coverage (§12.0)
Every AC has at least one test whose name starts with its id: AC-API-01..08, AC-DOM-01..05,
AC-AUTH-01..09, AC-NOT-01..05, AC-CRUD-01..12, AC-SHELL-01..07 (46/46).
Named defect tests in foundation code: D10 (`api/http.test.ts`, `api/collection.test.ts`,
`app/RouteError.test.tsx`), D13 and D20 (`domain/projects.test.ts`). Preserved-defect AC tests:
D15 (`auth/LoginModal.test.tsx`), D19 (`auth/LoginModal.test.tsx`, `auth/security.test.tsx`).
Class parity: `app/Header.test.tsx` (navbar, breadcrumb), the login modal (`modal`, `login-form`,
`modal-header`, `alert-*`), `CrudButtons` and the notifications outlet; e2e AC-SHELL-07.

### Legacy cases (spec §9), cluster 0: 83 cases
Ported 48, adapted 27, n/a 8, dead 0 (83 rows). (ported + adapted) = **75/83** for this cluster.

| Legacy file | Case | Status | New test | Note |
|---|---|---|---|---|
| security.spec:28 | should open the dialog | ported | `auth/security.test.tsx` | `.login-form` appears |
| security.spec:36 | sends a http request to login the specified user | ported | `auth/security.test.tsx` | |
| security.spec:43 | calls queue.retry on a successful login | ported | `auth/security.test.tsx` | |
| security.spec:53 | does not call queue.retryAll after a login failure | ported | `auth/security.test.tsx` | |
| security.spec:61 | returns true to success handlers if the user authenticated | ported | `auth/security.test.tsx` | |
| security.spec:68 | returns false to success handlers if the user was not authenticated | ported | `auth/security.test.tsx` | |
| security.spec:82 | sends a http post to clear the current logged in user | ported | `auth/security.test.tsx` | |
| security.spec:88 | redirects to / by default | adapted | `auth/security.test.tsx` (AC-AUTH-07) | via AuthProvider + router; `/` then `/projectsinfo` |
| security.spec:97 | redirects to the path specified in the first parameter | n/a | — | parameter dropped (§5.9), pre-assigned |
| security.spec:109 | should be unauthenticated to begin with | ported | `auth/security.test.tsx` | |
| security.spec:114 | should be authenticated if we update with user info | adapted | `auth/security.test.tsx` | user set by a real login, not by assignment |
| security.spec:121 | should be admin if we update with admin user info | adapted | `auth/security.test.tsx` | same |
| security.spec:129 | should not be authenticated or admin if we clear the user | adapted | `auth/security.test.tsx` | cleared by logout |
| security.spec:144 | makes a GET request to current-user url | ported | `auth/security.test.tsx` | |
| security.spec:155 | returns the current user immediately if they are already authenticated | ported | `auth/security.test.tsx` | asserts no request |
| retry-queue.spec:15 | initially has no items to retry | ported | `auth/retryQueue.test.ts` | |
| retry-queue.spec:20 | has more items once one has been pushed | ported | `auth/retryQueue.test.ts` | |
| retry-queue.spec:27 | adds a new item to the queue | adapted | `auth/retryQueue.test.ts` | `reason` is an explicit argument (may be undefined) |
| retry-queue.spec:31 | adds a reason to the retry | ported | `auth/retryQueue.test.ts` | |
| retry-queue.spec:36 | does not add a reason to the retry if not specified | adapted | `auth/retryQueue.test.ts` | same |
| retry-queue.spec:43 | should not fail if the queue is empty | ported | `auth/retryQueue.test.ts` | |
| retry-queue.spec:46 | should empty the queue (retryAll) | ported | `auth/retryQueue.test.ts` | also asserts each retry ran |
| retry-queue.spec:57 | should empty the queue (cancelAll) | ported | `auth/retryQueue.test.ts` | also asserts each cancel ran |
| login-toolbar.spec:17 | should attach stuff to the scope | adapted | `auth/LoginToolbar.test.tsx` | no scope: asserts the toolbar is wired to AuthProvider |
| login-toolbar.spec:24 | should display a link with the current user name, when authenticated | ported | `auth/LoginToolbar.test.tsx` | |
| login-toolbar.spec:30 | should not display a link with the current user name, when not authenticated | ported | `auth/LoginToolbar.test.tsx` | |
| login-toolbar.spec:36 | should display login when user is not authenticated | adapted | `auth/LoginToolbar.test.tsx` | Log out is not rendered rather than hidden |
| login-toolbar.spec:41 | should display logout when user is authenticated | adapted | `auth/LoginToolbar.test.tsx` | same |
| login-toolbar.spec:48 | should call logout when the logout button is clicked | adapted | `auth/LoginToolbar.test.tsx` | asserts the POST and the UI, not a scope spy |
| login-toolbar.spec:54 | should call login when the login button is clicked | adapted | `auth/LoginToolbar.test.tsx` | asserts the modal opened |
| authorization.spec:25 | makes a GET request to current-user url | ported | `auth/guards.test.ts` | pre-assigned (S11 keeps the request) |
| authorization.spec:35 | adds a new item to the retry queue if not authenticated | ported | `auth/guards.test.ts` | |
| authorization.spec:51 | returns a resolved promise if we are already an admin | ported | `auth/guards.test.ts` | |
| authorization.spec:62 | adds a new item to the retry queue if not admin | ported | `auth/guards.test.ts` | |
| interceptor.spec:15 | accepts and returns a promise | adapted | `api/http.test.ts` | no interceptor object: `request()` returns a promise |
| interceptor.spec:22 | does not intercept non-401 error responses | ported | `api/http.test.ts` | |
| interceptor.spec:31 | intercepts 401 error responses and adds it to the retry queue | ported | `api/http.test.ts` | |
| edit.spec:13 | requires a valid resource object | adapted | `crud/useCrudForm.test.tsx` | types require `save`; removing a saved doc without `remove` throws |
| edit.spec:31 | should evaluate a complex expression for the resource | n/a | — | no AngularJS expressions: `initial` is a value |
| edit.spec:40 | requires a form element | n/a | — | a hook has no DOM element to require |
| edit.spec:51 | should attach methods to the scope | adapted | `crud/useCrudForm.test.tsx` | pre-assigned: getCssClasses assertion (:60) dropped |
| edit.spec:65 | should not modify the parent scope | adapted | `crud/useCrudForm.test.tsx` | pre-assigned (:74 dropped); asserts `initial` is never mutated |
| edit.spec:97 | should call resource.$saveOrUpdate | ported | `crud/useCrudForm.test.tsx` | |
| edit.spec:101 | should call resource.$saveOrUpdate with scope callbacks if specified | adapted | `crud/useCrudForm.test.tsx` | onSave gets the saved doc |
| edit.spec:115 | should call resource.$saveOrUpdate with attribute callbacks if specified | adapted | `crud/useCrudForm.test.tsx` | failure → onError('save') |
| edit.spec:133 | should update the "original" object | ported | `crud/useCrudForm.test.tsx` | |
| edit.spec:145 | should return true if the model is valid and different to the original | ported | `crud/useCrudForm.test.tsx` | |
| edit.spec:150 | should return false if the model is invalid | ported | `crud/useCrudForm.test.tsx` | |
| edit.spec:160 | should reset the resource to its original state | ported | `crud/useCrudForm.test.tsx` | |
| edit.spec:171 | should return false if the model is same as the original | ported | `crud/useCrudForm.test.tsx` | |
| edit.spec:176 | should return true if the model is different to the original | ported | `crud/useCrudForm.test.tsx` | |
| edit.spec:186 | scope.remove should call resource.$remove if resource.$id returns true | ported | `crud/useCrudForm.test.tsx` | |
| edit.spec:192 | scope.remove should call resource.$remove with scope callbacks if specified | adapted | `crud/useCrudForm.test.tsx` | S4: onRemove, no fallback to onSave; failure → onError('remove') |
| edit.spec:213 | scope.remove should call resource.$remove if resource.$id returns false | ported | `crud/useCrudForm.test.tsx` | |
| edit.spec:221 | getCssClasses: should return an object with error and success members | n/a | — | getCssClasses dropped (§5.9), pre-assigned |
| edit.spec:226 | getCssClasses: error and success false if the item is same as original | n/a | — | same |
| edit.spec:247 | getCssClasses: error true and success false if different and invalid | n/a | — | same |
| edit.spec:256 | getCssClasses: error false and success true if dirty and valid | n/a | — | same |
| edit.spec:265 | showError: should return false if no error is set | ported | `crud/useCrudForm.test.tsx` | |
| edit.spec:269 | showError: should return true if the specified error is set | ported | `crud/useCrudForm.test.tsx` | |
| crud.spec:195 | should support new method | ported | `crud/useListNav.test.tsx` | |
| crud.spec:201 | should support edit method | ported | `crud/useListNav.test.tsx` | |
| notifications.spec:12 | should allow to add, get and remove notifications | adapted | `notifications/store.test.ts` | pre-assigned: current bucket instead of sticky |
| notifications.spec:25 | removal of a non-existing notification doesnt trigger errors | ported | `notifications/store.test.ts` | |
| notifications.spec:29 | should reject notifications that are not objects | n/a | — | enforced by the types, pre-assigned |
| notifications.spec:38 | should remove notification after route change | adapted | `notifications/store.test.ts` | pre-assigned |
| notifications.spec:51 | should advertise a notification after a route change and remove on the subsequent one | adapted | `notifications/store.test.ts` | pre-assigned |
| i18nNotifications.spec:16 | should add a new sticky notification based on a localized message and its type | adapted | `notifications/store.test.ts` | pre-assigned: current bucket |
| i18nNotifications.spec:29 | should proxy getCurent method | adapted | `notifications/store.test.ts` | one store, no proxy: getCurrent returns the pushes |
| i18nNotifications.spec:35 | should proxy remove method | adapted | `notifications/store.test.ts` | same |
| localizedMessages.spec:12 | should return a localized message if defined | ported | `notifications/messages.test.ts` | catalogue passed as an argument |
| localizedMessages.spec:17 | should return a message key surrounded by a question mark | ported | `notifications/messages.test.ts` | |
| localizedMessages.spec:21 | should interpolate parameters | ported | `notifications/messages.test.ts` | |
| localizedMessages.spec:26 | should not break for missing params | ported | `notifications/messages.test.ts` | |
| breadcrumbs.spec:20 | should have sensible defaults before route navigation | adapted | `app/breadcrumbs.test.ts` | no `getFirst()`: empty list, no first crumb |
| breadcrumbs.spec:25 | should not expose breadcrumbs before route change success | adapted | `app/Header.test.tsx` (AC-SHELL-04) | asserted during a pending navigation |
| breadcrumbs.spec:31 | should correctly parse $location() after route change success | ported | `app/breadcrumbs.test.ts` | |
| httpRequestTracker.spec:10 | should not report pending requests if no requests in progress | ported | `api/http.test.ts` | |
| httpRequestTracker.spec:14 | should report pending requests if requests are in progress | adapted | `api/http.test.ts` | a real request in flight, not a pushed fake |
| validateEquals.spec:30 | should be valid initially | ported | `crud/validators.test.ts` | via `useCrudForm` + `equalsField` |
| validateEquals.spec:33 | should be invalid if the model changes | ported | `crud/validators.test.ts` | |
| validateEquals.spec:37 | should be invalid if the reference model changes | ported | `crud/validators.test.ts` | |
| validateEquals.spec:41 | should be valid if the model changes to be the same as the reference | ported | `crud/validators.test.ts` | |

Out of scope for this table (spec §9): `crud.spec` crudEditMethods (17, dead) and
`exceptionHandler.spec` (3, dead; intent covered by AC-NOT-05) are assigned to no cluster.

### Notes for wave A/B workers
- `renderRoute` is async: `const { user, router } = await renderRoute(path, { as })`. Wait for
  `router.state.initialized` (or a screen element) before clicking shell buttons: the shell re-mounts
  when the first load completes.
- Each placeholder `features/<f>/routes.tsx` already has the final paths and guard. Replace the
  placeholder component, and add data to the loader after the `await require…()` line.
- `recordRequests()` in `src/test/renderRoute.tsx` records what reached the stub (method, path,
  parsed `q`, headers, body) without overriding anything.

## 2026-11-20 (local; 2026-11-21 UTC): session 2, fix for DEV-foundation-01

### What was done
- **Finding (reviewer, blocking):** "AC-SHELL-01: the brand goes to /projectsinfo when anonymous"
  could not fail. It started at `/projectsinfo`, navigated to `/admin` (unknown path, which redirects
  back to `/projectsinfo`), then clicked the brand and waited for `/projectsinfo`, the location it
  was already at. With `home()` mutated so that an anonymous click does nothing, all 181 unit tests
  still passed.
- **Fix:** the test now starts on a test-only public route `/elsewhere`, passed through
  `renderRoute`'s `routes` option (`renderShell` gained an optional `routes` argument for this). It
  asserts the start location is `/elsewhere`, clicks the brand, and waits for `/projectsinfo`. Only
  `web/src/app/Header.test.tsx` changed; no source change.

### Mutation check (run this session)
- Mutated `home()` in `web/src/app/Header.tsx` to `if (isAuthenticated) void navigate('/dashboard')`.
- `pnpm exec vitest run src/app/Header.test.tsx`: 1 failed, 10 passed.
  `× AC-SHELL-01: the brand goes to /projectsinfo when anonymous`,
  `AssertionError: expected '/elsewhere' to be '/projectsinfo'`.
- Reverted with `git checkout -- web/src/app/Header.tsx`; `git diff --stat` then showed only
  `web/src/app/Header.test.tsx`.

### Mistakes and wrong turns
- The original test was mine (session 1): I added the `/admin` hop to get "somewhere else" without
  checking that the unknown-path redirect lands on the very target the test asserts. Lesson: an
  assertion on a final location needs a precondition proving the start location differs.

### Gate results (this session)
`pnpm verify` (exit 0):
- lint: `All matched files use Prettier code style!` (eslint `--max-warnings 0` clean)
- typecheck: `tsc --noEmit` clean
- unit: `Test Files  23 passed (23)`, `Tests  181 passed (181)`
- build: `✓ built in 337ms` (dist), `✓ built in 358ms` (dist-pages)
- e2e: `18 passed (4.2s)`
