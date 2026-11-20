# Conversion Spec: AScrum, AngularJS 1.2 → React 19

Status: **DRAFT, awaiting owner review (Phase 1 gate)**.
Inputs: `spec/inventory.md` (facts) and `spec/questions.md` (owner answers, 2026-11-20).
Authority: this spec is the contract for every worker and reviewer session. If code and spec disagree, the spec wins until it is amended. If the spec is silent, append a question to `spec/questions.md` and do not guess.

---

## 0. Decision record

| Q | Decision |
|---|---|
| A1 | **Port and fix obvious bugs.** Unfinished features are not finished. Every fix is logged as an intentional deviation (§6). |
| A2 | Dead code is **not ported** (§5.9). There is one addition: a global error boundary. |
| A3 | The stub never returns `password`. The user form never pre-fills a password; on edit, a blank password means "unchanged". Committed secrets are removed from the tree, and the README notes that they remain in upstream history. |
| A4 | Legacy unit tests are the parity checklist. **113 portable cases**; 20 cover dead code (§9). |
| A5 | The legacy app stays reference-only in `legacy/` and its toolchain is not revived. There is **no executed legacy baseline**. |
| B1 | **React 19** (challenge to the proposed 18, accepted). |
| B2 | **React Router v7, data mode** (`createBrowserRouter`, loaders, actions are optional). No framework mode, no SSR. |
| B3 | No server-state library. Loaders plus a typed `api/` module. |
| B4 | **Bootstrap 2.1.1** compiled from the vendored LESS. Markup keeps the legacy class names. |
| B5 | Vitest + React Testing Library + MSW for unit tests; Playwright smoke e2e as a **blocking** CI gate. |
| B6 | A hand-written `useCrudForm` hook. No form library. |
| B7 | **pnpm, Node 24 LTS.** Vite and TypeScript (strict) as proposed. |
| C1 | One shared stub handler module with **two adapters**: a Node dev server and MSW (tests plus the hosted static demo). The hosted demo goes on GitHub Pages. |
| C2 | **Keep the legacy wire contract**, quirks included, all isolated in `api/`. The one exception: not-found is **404**, not the `" null "` body. |
| C3 | The stub supports only `{}`, top-level equality, and `{_id:{$in:[{$oid}]}}`. Any other query gets a **400**. |
| C4 | Deterministic seed data rich enough to demonstrate every screen and every fixed defect (§7.6). |
| C5 | `server/` moves to `legacy/server`. |
| D1 | **Keep** the login modal plus transparent retry queue. |
| D2 | Guard `/projects/**` and `/dashboard` for authenticated users. |
| D3 | Breadcrumbs keep raw path segments (ids). |
| D4 | Keep a tiny `messages` module (key → template interpolation). |
| D5 | Sprint dates stay free text. |
| D6 | **URLs are identical** (relative to the router basename) and use HTML5 history. |
| E1 | Layout per §3, on the long-lived `migration` branch. |
| E2 | One worktree and one branch (`convert/<cluster>`) per cluster. PRs target **`migration`**. The **reviewer agent merges** when CI is green and no blocking deviations are open. |
| E3 | Clusters per §8, with 3 concurrent workers. |
| E4 | GitHub Actions. Branch protection on `migration` requires the CI checks; the owner configures it in repo settings (Phase 2). |
| E5 | Metrics per §10. Token and cost figures only if they can be exported; never estimated. |
| E6 | Keep the MIT LICENSE; the README credits Pawel Kozlowski & Peter Bacon Darwin and links the book. |
| F1–F4 | One LinkedIn article at the end, aimed at managers, stating plainly that agents did the conversion. Measured numbers only. Drafts go in `docs/article/`. |

### 0.1 Decisions this spec makes beyond the explicit answers (owner: please confirm or veto)
1. **D10 → fixed.** HTTP errors *reject* instead of resolving `undefined`. Loaders need this; otherwise a failed load would crash rendering.
2. **D9 → fixed.** `uniqueEmail` ignores the user being edited. Without this, A3's edit flow flags a user's own email as taken.
3. **D17 → fixed.** Gravatar URLs use **https**, because the hosted demo is https and http images would be blocked as mixed content.
4. **New defect D21 → fixed.** Removing a project shows "*saved* successfully": `onRemove` falls back to `onSave`, and the existing `crud.project.remove.success` key is never used. The port uses the remove key.
5. **Loader-failure UX.** AngularJS kept the *previous* view on screen when a resolve failed. The data router renders an error element instead. The spec'd behaviour: the shell stays, a "Route change error" notification appears, and the content area is empty.
6. **New message keys** (§5.4): `crud.backlogItem.save.error`, `crud.sprint.save.error`, `crud.task.save.error`, and `error.fatal`. These are needed for the D14 fix and the error boundary.
7. A second login-modal open is a **no-op**. Legacy threw an error, which was then swallowed and logged.
8. The stub merges the stored `password` on a `users` PUT that omits it. This is the server side of A3's "blank = unchanged".
9. The stub gets a **dev/test-only** reset endpoint, `POST /__stub/reset`. It is not part of the app's contract.
10. PRs are merged with **squash**; the PR keeps the per-commit history.

---

## 1. Goals and non-goals

**Goals**
- Behavioural parity with the legacy app (inventory §3–§6, §9), except for the deviations listed in §6.
- Boring, readable React: function components, hooks, explicit props, no clever abstractions.
- A runnable dev setup, a hosted demo, and CI that blocks on lint, typecheck, unit tests, build and e2e.

**Non-goals**
- Redesign or restyle (Bootstrap 5 is a possible later phase, not this one).
- Finishing unfinished features (D1 projects-info content, D2 per-user dashboard, D12 sprint status/dates/capacity).
- A real backend or database. Real auth security: the stub's plaintext comparison is acceptable *in the stub only*.
- SSR, i18n beyond the one existing locale, and accessibility work beyond what the legacy markup does. Logged as possible enhancements.

---

## 2. Target stack

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node 24 LTS, pnpm | `.nvmrc`/`engines`, and `packageManager` pinned |
| Build/dev | Vite (latest stable at Phase 2) | `base` = `/` in dev, `/angular-app/` for GitHub Pages |
| UI | React 19 + TypeScript (`strict: true`) | no `any`; `unknown` + narrowing at the API boundary |
| Routing | react-router v7, data mode | `createBrowserRouter`, `basename = import.meta.env.BASE_URL` |
| Styles | Vendored Bootstrap 2.1.1 LESS via Vite's `less` support | Needs `less` with `math: 'always'`, because Bootstrap 2 uses bare `/` division (see §11) |
| Unit tests | Vitest, @testing-library/react, @testing-library/user-event, MSW (node) | jsdom environment |
| E2E | Playwright, Chromium only | runs against the Node stub with a production build |
| Lint/format | ESLint flat config + typescript-eslint + eslint-plugin-react-hooks; Prettier `--check` | |
| Versions | Latest stable of each at Phase 2, recorded in `pnpm-lock.yaml` | New dependencies after Phase 2 need a question first |

---

## 3. Repository layout (branch `migration`)

```
legacy/
  client/                 # moved from /client, untouched except secrets note
  server/                 # moved from /server; privatekey.pem + MongoLab key removed (A3)
web/
  index.html
  package.json  vite.config.ts  tsconfig.json  eslint.config.js  playwright.config.ts
  public/                 # favicon, spinner.gif, glyphicons (from legacy assets), mockServiceWorker.js
  src/
    main.tsx              # bootstraps MSW when VITE_STUB=msw, then renders <RouterProvider>
    app/                  # router.tsx, AppShell, Header, Breadcrumbs, NotificationsOutlet, RouteError, ErrorBoundary
    api/                  # http.ts (prefix, XSRF, credentials, 401→retry), collection.ts, types.ts, ids.ts
    auth/                 # AuthProvider, useAuth, retryQueue.ts, LoginModal, LoginToolbar, guards.ts
    notifications/        # store.ts, useNotifications, messages.ts (catalogue + interpolate)
    crud/                 # useCrudForm.ts, CrudButtons.tsx, listNav.ts, validators.ts
    domain/               # projects.ts (role rules), users.ts (fullName), tasks.ts (TASK_STATES)
    components/           # Gravatar.tsx, md5.ts
    features/
      admin-users/  admin-projects/  projects/  productbacklog/  sprints/  tasks/  dashboard/  projectsinfo/
        routes.tsx        # the cluster's route objects (loaders + elements); the ONLY file router.tsx imports
        *.tsx, *.test.tsx
    styles/               # stylesheet.less, variables.less, bootstrap2/ (vendored LESS)
  stub/
    store.ts  handlers.ts  query.ts  seed.ts  session.ts
    msw.ts                # adapter: MSW handlers (browser worker + node test server)
    server.ts             # adapter: node:http server for dev and e2e (port 3001)
    *.test.ts             # contract tests (AC-STUB-*)
  e2e/
    smoke.spec.ts
spec/                     # inventory, questions, conversion-spec, deviations, journal, worklogs/, metrics.jsonl
docs/article/             # LinkedIn article drafts
MIGRATION.md              # status table (§8.3)
CLAUDE.md                 # worker conventions
```

Dev wiring: `pnpm dev` runs Vite plus `stub/server.ts`, with Vite proxying `/databases`, `/login`, `/logout`, `/current-user` and `/__stub` to port 3001 (same origin, so cookies work as they did in legacy). `pnpm dev:msw` and the Pages build use MSW in the browser.

---

## 4. Architecture (the mapping of AngularJS mechanisms)

| AngularJS mechanism | React replacement |
|---|---|
| `$routeProvider` + `crudRouteProvider.routesFor()` | Route objects in each `features/*/routes.tsx`. A small `crudRoutes(prefix, {list, new, edit})` helper in `crud/` builds the list/new/edit triplet with identical paths. |
| Route `resolve` (blocks render until settled) | Route `loader`. Components read data with `useLoaderData()`. |
| `$routeChangeError` → notification | The root route's `errorElement` = `<RouteError>`, which pushes `errors.route.changeError` and renders the shell with empty content (§0.1-5). |
| `securityAuthorizationProvider.require*` resolves | `requireAuthenticatedUser()` / `requireAdminUser()` awaited at the top of loaders (`auth/guards.ts`). |
| `$http` interceptor + `securityRetryQueue` | `api/http.ts`: a 401 calls `retryQueue.push('unauthorized-server', () => request(original))` and returns that promise. |
| `security` service + `$dialog` | `AuthProvider` (context: `currentUser`, `login`, `logout`, `showLogin`). The queue's `onItemAdded` opens `<LoginModal>`. The modal closing with success → `retryAll`; cancel → `cancelAll` + navigate `/`. |
| `$rootScope` events (`$routeChangeSuccess`) | `useLocation()` / `useNavigation()` effects in `AppShell` (breadcrumbs, notification rotation). |
| `notifications` / `i18nNotifications` / `localizedMessages` | A module-level store with `useSyncExternalStore`, plus `messages.ts` doing `{{name}}` interpolation. Rotation happens on each completed navigation (`navigation.state` returns to `idle` with a new location). |
| `crudEdit` + `crudButtons` directives | `useCrudForm({initial, save, remove, validators, onSave, onRemove, onError})` + `<CrudButtons form={…}/>`. |
| `crudListMethods` | `listNav(prefix)` → `{onNew, onEdit(id)}` using `useNavigate`. |
| `mongolabResource` + resource prototypes | `api/collection.ts` (`all`, `query`, `getById`, `getByIds`, `save`, `remove`) returning **plain typed objects**. Prototype methods become pure functions in `domain/`. |
| `httpRequestTracker` | A pending-request counter in `api/http.ts` exposed through `usePendingRequests()`. |
| `ng-include`'d projects-list template | A `<ProjectsTable>` component shared by projects and dashboard. |
| html2js template cache, Grunt | Vite. |

**Wire-quirk isolation rule:** `)]}',\n`, `XSRF-TOKEN`/`X-XSRF-TOKEN`, `_id.$oid`, `?q=` JSON, and `{user:null}` login failure are handled **only** inside `api/` and `auth/`. Feature code sees `id: string` (via `idOf(doc)`), typed query helpers, and `login() → boolean`.

---

## 5. Component mapping

Disposition: **port** (same behaviour), **fix** (deviation in §6), **merge** (folded into another unit), **drop** (dead, §5.9).

### 5.1 Foundation (cluster 0)
| Legacy unit | React unit | Disposition |
|---|---|---|
| `vendor/mongolab/mongolab-resource.js` | `api/http.ts`, `api/collection.ts`, `api/ids.ts` | port + fix D10 |
| resources `projects/backlog/sprints/tasks/users.js` | `api/collection.ts` instances in `api/collections.ts` + `domain/*.ts` | port; drop unused queries (D11) |
| `security/security.js`, `retryQueue.js`, `interceptor.js`, `authorization.js` | `auth/AuthProvider.tsx`, `auth/retryQueue.ts`, `api/http.ts`, `auth/guards.ts` | port |
| `security/login/LoginFormController.js` + `form.tpl.html` | `auth/LoginModal.tsx` | port |
| `security/login/toolbar.js` + `.tpl.html` | `auth/LoginToolbar.tsx` | port |
| `services/notifications.js`, `i18nNotifications.js`, `localizedMessages.js`, `I18N.MESSAGES` | `notifications/store.ts`, `notifications/messages.ts` | port (+ new keys §5.4) |
| `services/breadcrumbs.js` | `app/Breadcrumbs.tsx` (derived from location) | port |
| `services/httpRequestTracker.js` | `usePendingRequests()` in `api/http.ts` | port |
| `services/crud.js` (`crudListMethods`), `crudRouteProvider.js` | `crud/listNav.ts`, `crud/crudRoutes.ts` | port |
| `directives/crud/edit.js`, `crudButtons.js` | `crud/useCrudForm.ts`, `crud/CrudButtons.tsx`, `crud/validators.ts` | port |
| `app.js` (AppCtrl, HeaderCtrl), `index.html`, `header.tpl.html`, `notifications.tpl.html` | `app/AppShell.tsx`, `app/Header.tsx`, `app/NotificationsOutlet.tsx`, `app/router.tsx` | port |
| (`exceptionHandler.js`: intent only) | `app/ErrorBoundary.tsx` | new (A2) |

### 5.2 Feature clusters
| Legacy unit | React unit | Cluster | Disposition |
|---|---|---|---|
| `admin/users/admin-users.js` (routes) | `features/admin-users/routes.tsx` | 1 | port |
| `UsersListCtrl` + `users-list.tpl.html` | `features/admin-users/UsersList.tsx` | 1 | port |
| `UsersEditCtrl` + `users-edit.tpl.html` | `features/admin-users/UserEdit.tsx` | 1 | fix D8, D9 |
| `uniqueEmail.js` | `features/admin-users/uniqueEmail.ts` (async validator) | 1 | fix D9 |
| `validateEquals.js` | `crud/validators.ts` `equalsField()`; used by UserEdit | 1 | port |
| `directives/gravatar.js` (+ md5 factory) | `components/Gravatar.tsx`, `components/md5.ts` | 1 | fix D17 |
| `admin/projects/admin-projects.js` routes + `ProjectsListCtrl` + list tpl | `features/admin-projects/routes.tsx`, `ProjectsAdminList.tsx` | 2 | port |
| `ProjectsEditCtrl` + `TeamMembersController` + edit tpl | `features/admin-projects/ProjectEdit.tsx`, `TeamMembers.tsx` | 2 | fix D21, D13 |
| `projects/projects.js` (`ProjectsViewCtrl`) + `projects-list.tpl.html` | `features/projects/routes.tsx`, `ProjectsPage.tsx`, `ProjectsTable.tsx` | 3 | fix D5, D20 |
| `productbacklog.js` + list/edit tpl | `features/productbacklog/routes.tsx`, `BacklogList.tsx`, `BacklogItemEdit.tsx` | 3 | fix D14; guard (D2) |
| `sprints.js` + list/edit tpl | `features/sprints/routes.tsx`, `SprintsList.tsx`, `SprintEdit.tsx`, `SprintBacklogPicker.tsx` | 4 | fix D13, D14; guard |
| `tasks.js` + list/edit tpl | `features/tasks/routes.tsx`, `TasksList.tsx`, `TaskEdit.tsx` | 4 | fix D6, D14; guard |
| `dashboard.js` + tpl | `features/dashboard/routes.tsx`, `Dashboard.tsx` (uses `ProjectsTable`) | 5 | fix D3; guard (D4) |
| `projectsinfo.js` + tpl | `features/projectsinfo/routes.tsx`, `ProjectsInfo.tsx` | 5 | port (D1 preserved) |

### 5.3 Routes (identical paths; D6)
All 18 legacy routes (inventory §3, R1–R18) exist with identical paths; `*` redirects to `/projectsinfo`. Guards:
- `requireAdminUser`: R13–R18 (unchanged).
- `requireAuthenticatedUser`: R2–R12 (R3 unchanged; R2, R4–R12 newly guarded per D2/D4).
- R1 is public.

### 5.4 Message catalogue (`notifications/messages.ts`)
All 12 legacy keys verbatim, plus:
| Key | Text |
|---|---|
| `crud.backlogItem.save.error` | `Something went wrong when saving a backlog item...` |
| `crud.sprint.save.error` | `Something went wrong when saving a sprint...` |
| `crud.task.save.error` | `Something went wrong when saving a task...` |
| `error.fatal` | `An unexpected error occurred: {{message}}` |

### 5.5 Domain types (`api/types.ts`)
Wire documents (`_id?: {$oid: string}`) are converted at the boundary to app types with `id?: string`; `api/` converts back on save.
```ts
type User          = { id?: string; email: string; firstName: string; lastName: string; admin: boolean; password?: string } // password only ever outbound
type Project       = { id?: string; name: string; desc?: string; productOwner?: string; scrumMaster?: string; teamMembers: string[] }
type BacklogItem   = { id?: string; projectId: string; name: string; desc: string; priority: number; estimation: number }
type Sprint        = { id?: string; projectId: string; name: string; capacity: number; start: string; end: string; sprintBacklog: string[] }
type TaskState     = 'TODO' | 'IN_DEV' | 'BLOCKED' | 'IN_TEST' | 'DONE'
type Task          = { id?: string; projectId: string; sprintId: string; productBacklogItemId: string; name: string; desc: string; estimation: number; remaining: number; state: TaskState; assignedUserId?: string }
type CurrentUser   = { id: string; email: string; firstName: string; lastName: string; admin: boolean }
```
Unknown extra fields on wire documents are preserved on round-trip (Mongo semantics: a PUT replaces the whole document).

### 5.9 Not ported (A2)
`directives.modal`, `services.exceptionHandler` (replaced by the error boundary), `crudEditMethods`, the `/authenticated-user` and `/admin-user` endpoints, `Projects.forUser`, `Tasks.forUser`/`forProductBacklogItem`/`forProject`, `notifications.pushSticky` (the store keeps the sticky bucket internally, since `getCurrent` semantics need it, but exposes no API for it), `getCssClasses`, `ProjectsViewCtrl.viewProject` (D5).

---

## 6. Defect disposition (inventory §13)

| ID | Disposition | Behaviour in the port |
|---|---|---|
| D1 | preserved | `/projectsinfo` loads projects and renders only `<h3>Projects info</h3>` |
| D2 | preserved | dashboard shows all projects and all tasks |
| D3 | **fixed** | dashboard uses `ProjectsTable`: roles shown, links go to `/projects/:id/productbacklog` and `/projects/:id/sprints` |
| D4 | **fixed** | `/dashboard` requires authentication (Q-D2) |
| D5 | **fixed** (dropped) | no `viewProject`; no link to the non-existent `/projects/:id` |
| D6 | **fixed** | saving a task navigates to `/projects/:projectId/sprints/:sprintId/tasks` |
| D7 | **fixed** (stub) | `password` is never present in any response; reads stay public otherwise |
| D8 | **fixed** | password fields always start empty |
| D9 | **fixed** | uniqueness ignores the edited user's own id |
| D10 | **fixed** | non-2xx responses reject; loader errors go to `RouteError` |
| D11 | **fixed** (dropped) | unused, mis-keyed task queries removed |
| D12 | preserved | status cell shows `ACTIVE`; free-text dates; capacity unused |
| D13 | **fixed** | missing backlog ids are skipped in totals and shown as blank rows that can still be removed; `teamMembers` undefined is treated as `[]` |
| D14 | **fixed** | save errors push a current-route error notification (§5.4) |
| D15 | preserved | non-admin writes to users/projects get 401 → login modal with the "not authorized" reason |
| D16 | **fixed** (dropped) | §5.9 |
| D17 | **fixed** | module-scoped md5 (no globals), https URL |
| D18 | **fixed** | secrets removed from `legacy/server`; README note |
| D19 | preserved | bad login = 200 `{user:null}`; logout errors are not surfaced |
| D20 | **fixed** | roles render as `PO`, `SM, DEV`, or empty |
| D21 | **fixed** | removing a project pushes `crud.project.remove.success` |

Every **fixed** row must have a test naming its D-id (e.g. `it('D6: saving a task returns to the sprint task list')`).

---

## 7. API stub plan

### 7.1 Shape
`stub/handlers.ts` exports one pure function, `handle(req: StubRequest, ctx: {store, sessions}): StubResponse`, where `StubRequest = {method, path, query, headers, cookies, body}` and `StubResponse = {status, headers, setCookies, body}`. Both adapters (`stub/msw.ts`, `stub/server.ts`) only translate to and from this shape, so the contract is tested once against `handle`.

### 7.2 Transport rules (C2, legacy-faithful)
- Every JSON response body is prefixed with `)]}',\n` (`Content-Type: application/json`).
- Every response sets cookie `XSRF-TOKEN=<token for this session>`. Non-GET/HEAD/OPTIONS requests whose `X-XSRF-TOKEN` header doesn't match → **403**, empty body. This applies to `/login` too.
- Session: cookie `sid` (random) → `{userId?, xsrf}` held in memory.

### 7.3 Endpoints
| Method | Path | Behaviour |
|---|---|---|
| POST | `/login` | body `{email,password}`; match → set session user, 200 `{user: CurrentUser}`; no match → 200 `{user:null}` |
| POST | `/logout` | clear session user → 204 |
| GET | `/current-user` | 200 `{user: CurrentUser \| null}` |
| GET | `/databases/ascrum/collections/:c` | `?q=` optional JSON; 200 `Doc[]` |
| GET | `/databases/ascrum/collections/:c/:id` | 200 `Doc` or **404** `{message}` |
| POST | `/databases/ascrum/collections/:c` | body Doc → 200 created Doc with new `_id.$oid` |
| PUT | `/databases/ascrum/collections/:c/:id` | replaces the document (`users`: keeps the stored password if the body has none) → 200 Doc; missing → 404 |
| DELETE | `/databases/ascrum/collections/:c/:id` | 200 deleted Doc; missing → 404 |
| POST | `/__stub/reset` | **dev/test only** (excluded from the Pages build): reseeds the store, clears sessions → 204 |

- `:db` must be `ascrum`; `:c` must be one of `users, projects, productbacklog, sprints, tasks`. Anything else → 404.
- Auth: writes (POST/PUT/DELETE) need a session user, otherwise **401** `{user:null}`. Writes to `users`/`projects` also need `admin`, otherwise **401** `{user: CurrentUser}` (D15 preserved).
- `password` is stripped from **every** `users` document in **every** response.
- `q` grammar (C3): `{}`; `{field: scalar}` (top-level equality, AND across keys); `{_id: {$in: [{$oid: string}, …]}}`. Anything else (including invalid JSON) → **400** `{message}`.
- Ids: 24-hex strings. The seed uses fixed ids; new ids come from a counter-based generator (deterministic after reset).

### 7.4 Adapters
- **Node** (`stub/server.ts`, `node:http`, no framework): port 3001; real cookies. Used by `pnpm dev` (through the Vite proxy) and by Playwright.
- **MSW** (`stub/msw.ts`): `setupWorker` for `dev:msw` and the Pages demo; `setupServer` for Vitest. Cookies are emulated through `document.cookie` / the request `Cookie` header. If MSW cannot set the `XSRF-TOKEN` cookie from a mocked response, the MSW adapter writes it to `document.cookie` itself (to be verified in Phase 2, §11).

### 7.5 Contract tests (`stub/*.test.ts`)
`AC-STUB-01..` covers every row of §7.2–§7.3, including the 400/401/403/404 paths, password stripping, and password merge on PUT. These run in CI like any other unit test.

### 7.6 Seed (C4: demonstrate everything)
Deterministic, defined in `stub/seed.ts`. Demo credentials are listed in the README.
- **Users (6):** `admin@abc.com`/`changeme` (admin, as in legacy); `po@ascrum.test`, `sm@ascrum.test`, `dev1@ascrum.test`, `dev2@ascrum.test`, `outsider@ascrum.test`, all with password `demo`, none admin.
- **Projects (3):**
  - "Webshop": PO = po, SM = sm, devs = dev1, dev2.
  - "Mobile App": PO = sm, SM = dev1, dev = dev2. This shows the same person in different roles across projects.
  - "Legacy Cleanup": `teamMembers` field **absent**, PO = admin. Exercises the D13 fix.
- **Backlog:** about 6 items on Webshop, 3 on Mobile App, 0 on Legacy Cleanup (empty-state text).
- **Sprints:**
  - Webshop: 2 sprints; one of them references a **deleted backlog id** (D13 demo).
  - Mobile App: 1 sprint.
  - Legacy Cleanup: 0 sprints (empty state).
- **Tasks:** about 12 across the Webshop sprints, covering all 5 states, some unassigned. One sprint has 0 tasks (empty state).

---

## 8. Clusters, schedule, ownership

### 8.1 Clusters
| # | Cluster | Owns (write access) | Depends on | Wave |
|---|---|---|---|---|
| 0 | foundation | `web/src/{app,api,auth,notifications,crud,domain}/**`, placeholder `features/*/routes.tsx` | Phase 2 harness | serial, first |
| 1 | admin-users | `features/admin-users/**`, `components/**` | 0 | A |
| 2 | admin-projects | `features/admin-projects/**` | 0 | A |
| 3 | projects + productbacklog | `features/projects/**`, `features/productbacklog/**` | 0 | A |
| 4 | sprints + tasks | `features/sprints/**`, `features/tasks/**` | 0 | B |
| 5 | dashboard + projectsinfo | `features/dashboard/**`, `features/projectsinfo/**` | 0, 3 (`ProjectsTable`) | B |

Cluster 0 pre-registers every feature's `routes.tsx` with placeholder elements ("Not yet converted") and all §5.4 message keys, so no feature worker ever has to edit `router.tsx` or `messages.ts`. Any change a worker needs outside its owned paths → a question in `spec/questions.md`, and that part stays blocked. The worker does **not** edit the file.

E2E: cluster 0 writes `e2e/smoke.spec.ts` covering login/logout and the shell only. Each feature cluster appends its own steps to the smoke flow in a separate file, `e2e/<cluster>.spec.ts` (avoids conflicts). The full smoke path (login → admin creates project → backlog item → sprint → task → logout) is complete once wave B merges.

### 8.2 Workflow per cluster
1. **Worker** (fresh session, own worktree, branch `convert/<cluster>` from `migration`): implements against §5/§6/§12 and ports the legacy cases (§9). Keeps `spec/worklogs/<cluster>.md`. Opens a PR into `migration` once local gates pass.
2. **CI** must be green: lint, typecheck, unit, build, e2e.
3. **Reviewer** (fresh session, *not* the worker): reads §12's ACs for the cluster, §6, the diff, and the worklog. Checks each AC against code **and** a named test. Appends findings to `spec/deviations.md`. Comments on the PR with an AC checklist.
4. A **blocking** deviation goes back to the worker, then steps 2–3 repeat. Non-blocking deviations are logged and may merge.
5. **Merge:** the reviewer runs `gh pr merge --squash` when CI is green and there are 0 open blocking deviations. The reviewer then updates `MIGRATION.md` and appends to `spec/journal.md`.

### 8.3 `MIGRATION.md` statuses
`pending` → `converted` (PR open, CI green) → `verified` (reviewer: all ACs pass, no open blocking deviations) → `merged`. **Only the reviewer edits `MIGRATION.md`**, on `migration`, after merging; workers never touch it. That avoids conflicts and stops agents from grading their own work.

### 8.4 `spec/deviations.md` entry format
`DEV-<nnn> | cluster | AC/D id | what was wrong | caught by (CI / reviewer / owner / e2e) | severity (blocking / non-blocking) | resolution | PR link`

---

## 9. Legacy test porting (A4)

Each legacy `it` gets exactly one of three statuses: **ported** (same assertion, new mechanism), **adapted** (same behaviour, assertion reshaped for React), or **n/a** (it tests AngularJS mechanics only; a one-line reason is mandatory). The worker records the per-case status in a table in their worklog. Metric: (ported + adapted) / 113.

| Legacy spec | Cases | Target | Cluster |
|---|---|---|---|
| security/security.spec | 15 | `auth/*.test.tsx` | 0 |
| security/retry-queue.spec | 8 | `auth/retryQueue.test.ts` | 0 |
| security/login/login-toolbar.spec | 7 | `auth/LoginToolbar.test.tsx` | 0 |
| security/authorization.spec | 4 | `auth/guards.test.ts` | 0 |
| security/interceptor.spec | 3 | `api/http.test.ts` | 0 |
| directives/crud/edit.spec | 23 | `crud/useCrudForm.test.tsx`, `crud/CrudButtons.test.tsx` | 0 |
| services/crud.spec (list methods) | 2 | `crud/listNav.test.ts` | 0 |
| services/notifications, i18nNotifications, localizedMessages | 5+3+4 | `notifications/*.test.ts` | 0 |
| services/breadcrumbs, httpRequestTracker | 3+2 | `app/*.test.tsx`, `api/http.test.ts` | 0 |
| admin/users (edit 3, list 1, uniqueEmail 5, validateEquals 4) + gravatar 5 | 18 | `features/admin-users/*`, `components/*` | 1 |
| admin/projects/admin-projects.spec | 11 | `features/admin-projects/*` | 2 |
| projects/projects.spec | 5 | `features/projects/*` | 3 |
| **Portable total** | **113** | | |
| services/crud.spec (crudEditMethods) | 17 | not ported (dead) | — |
| services/exceptionHandler.spec | 3 | not ported; the intent is covered by ErrorBoundary tests | — |

New tests are **required** for every AC in §12, including the screens the legacy suite never covered (backlog, sprints, tasks, dashboard, projectsinfo, login form, shell).

---

## 10. Metrics (E5)
Source of truth: `spec/metrics.jsonl` (written by a hook) and `gh` data. The journal cites these and never estimates.
- Wall-clock per phase and per cluster (first and last event per branch).
- Agent sessions and sub-agents per cluster.
- Local gate runs and failures before green; CI runs and failures per PR (`gh run list`).
- Deviations by "caught by" and severity (`deviations.md`).
- Legacy cases carried over (N/113); new test count.
- LOC: legacy app (1,849 JS + templates) vs `web/src` excluding tests; test LOC separately.
- Bundle: legacy minified size (computed from vendored files without running Grunt) vs `vite build` output, gzip.
- Human interventions: owner answers and overrides, counted from questions.md and the PRs.

---

## 11. Risks to verify in Phase 2 (before any worker starts)
1. **Bootstrap 2 LESS on modern `less`.** Less 4 defaults to `math: 'parens-division'`, while Bootstrap 2 uses bare division (e.g. `@gridGutterWidth / 2`). Needs `math: 'always'`; verify that the compiled CSS matches the legacy classes.
2. **MSW and cookies.** Whether the `XSRF-TOKEN`/`sid` Set-Cookie headers on mocked responses reach `document.cookie` in the browser worker; otherwise use the fallback from §7.4.
3. **GitHub Pages deep links.** The 404.html SPA fallback, the `/angular-app/` basename, and the MSW worker scope under that base.
4. **Router v7 data mode** + the notification rotation on navigation (no direct `$routeChangeSuccess` equivalent). Prove it with a test before cluster 0 closes.
5. **Playwright in CI** (browser install time). Chromium only.

---

## 12. Acceptance criteria

Each AC must be covered by at least one test whose name starts with the AC id. "Notify-next"/"notify-current" mean a next-route / current-route notification.

### 12.0 Foundation (cluster 0)

**API**
- **AC-API-01** Responses are parsed after stripping a leading `)]}',\n`; bodies without the prefix also parse.
- **AC-API-02** Requests are same-origin with credentials. Non-GET/HEAD/OPTIONS requests send `X-XSRF-TOKEN` equal to the current `XSRF-TOKEN` cookie.
- **AC-API-03** `collection(name)` targets `/databases/ascrum/collections/<name>`. `query(q)` sends `q=JSON.stringify(q)`; `all()` sends no `q`.
- **AC-API-04** A 404 on `getById` rejects with `ApiError{code:'resource.notfound'}`. Any other non-2xx rejects with `ApiError{status}` (D10).
- **AC-API-05** `getByIds(ids)` sends `{_id:{$in:[{$oid}…]}}`, including for an empty list.
- **AC-API-06** `save` POSTs a new document and PUTs an existing one to `/<id>` without `_id`. `remove` DELETEs `/<id>`. Results are converted to app types (`id`).
- **AC-API-07** A 401 enqueues a retry (`unauthorized-server`). The caller's promise settles with the retried request's result, or rejects when the queue is cancelled.
- **AC-API-08** `usePendingRequests()` is true while at least one request is in flight.

**Domain**
- **AC-DOM-01** `canActAsProductOwner`, `canActAsScrumMaster`, `canActAsDevTeamMember`, `isDevTeamMember` follow inventory §6.1; a missing `teamMembers` is treated as `[]` (D13).
- **AC-DOM-02** `getRoles`: PO is exclusive; otherwise `SM` then `DEV`. `formatRoles` joins with `", "` (D20).
- **AC-DOM-03** `fullName(user)` = `"Last First (email)"`.
- **AC-DOM-04** `TASK_STATES` = `TODO, IN_DEV, BLOCKED, IN_TEST, DONE`, in that order.

**Auth**
- **AC-AUTH-01** On start, the app requests `/current-user` once. `isAuthenticated` = user present; `isAdmin` = `user.admin === true`.
- **AC-AUTH-02** Every push onto the retry queue opens the login modal. A push while it is already open does not open a second one.
- **AC-AUTH-03** Modal reason: if the queue has items and the user is authenticated → `login.reason.notAuthorized`; unauthenticated → `login.reason.notAuthenticated`; empty queue (opened from the toolbar) → no reason alert.
- **AC-AUTH-04** Sign in is disabled until the email is valid and the password is non-empty. `{user:null}` → `login.error.invalidCredentials`. HTTP failure → `login.error.serverError` with `{{exception}}`.
- **AC-AUTH-05** A successful login closes the modal and retries every queued item in order. Clear empties the fields. Cancel rejects all queued items and navigates to `/` (→ `/projectsinfo`).
- **AC-AUTH-06** `requireAuthenticatedUser`/`requireAdminUser` in loaders: if satisfied, continue. Otherwise push `unauthenticated-client` / `unauthorized-client` and wait. After a successful login the loader completes without a reload.
- **AC-AUTH-07** Logout POSTs `/logout`, clears the user, and navigates to `/`.
- **AC-AUTH-08** Toolbar: when authenticated shows `First Last` and a "Log out" button; otherwise a "Log in" button that opens the modal (no reason).

**Notifications**
- **AC-NOT-01** Three buckets. `current` = sticky + current-route. On each completed navigation, current-route is replaced by next-route, and next-route is cleared.
- **AC-NOT-02** Pushes take a message key + params. Interpolation uses `{{name}}`. A missing key renders `?key?`.
- **AC-NOT-03** The outlet renders one `alert alert-<type>` per notification, each with a close button `x` that removes it. The outlet is not rendered when empty.
- **AC-NOT-04** A loader error pushes notify-current `errors.route.changeError`; the shell stays and the content area is empty (§0.1-5).
- **AC-NOT-05** An uncaught render error is caught by the ErrorBoundary, which pushes notify-current `error.fatal` and renders an empty content area. The shell stays usable.

**CRUD**
- **AC-CRUD-01** `useCrudForm` keeps a deep copy of the original. `dirty` = deep-unequal(current, original).
- **AC-CRUD-02** `canSave` = valid && dirty; `canRevert` = dirty; `canRemove` = has id.
- **AC-CRUD-03** `revert` restores the original and hides validation messages for untouched fields.
- **AC-CRUD-04** `save` success → original := server result, then `onSave(result)`; failure → `onError`.
- **AC-CRUD-05** `remove` with an id → DELETE, then `onRemove ?? onSave`. Without an id → callback without a request.
- **AC-CRUD-06** Validators: `required`, `email`, `number`, `equalsField`, and async custom validators. `showError(field, key)` reflects them.
- **AC-CRUD-07** `CrudButtons`: `Save` (`btn btn-primary save`, disabled unless canSave), `Revert changes` (`btn btn-warning revert`, disabled unless canRevert), `Remove` (`btn btn-danger remove`, rendered only if canRemove).
- **AC-CRUD-08** `listNav(prefix)`: `onNew` → `prefix/new`; `onEdit(id)` → `prefix/id`.

**Shell**
- **AC-SHELL-01** The brand "AScrum" navigates to `/dashboard` when authenticated, otherwise to `/projectsinfo`.
- **AC-SHELL-02** Nav: "Current Projects" always; "My Projects" when authenticated; "Admin" dropdown (Manage Projects, Manage Users) for admins only, toggled by click and closed when an item is chosen.
- **AC-SHELL-03** A nav item is `active` when its path matches the first path segment.
- **AC-SHELL-04** Breadcrumbs: one per path segment, with the raw segment as its name. All but the last are links. They update only after navigation completes.
- **AC-SHELL-05** The spinner image shows while requests are pending.
- **AC-SHELL-06** An unknown path redirects to `/projectsinfo`. A deep link reload works in dev, preview and the Pages build.
- **AC-SHELL-07** The Bootstrap 2.1.1 CSS is loaded; shell markup uses the legacy classes (`navbar`, `navbar-inner`, `brand`, `nav`, `breadcrumb`, `container-fluid`).

### 12.1 admin-users (cluster 1)
- **AC-USR-01** `/admin/users` requires admin. The table shows gravatar (50px, `d=monsterid`), E-mail, Last name, First name, and a `Remove` button per row.
- **AC-USR-02** A row click → `/admin/users/:id`; "New User" → `/admin/users/new`.
- **AC-USR-03** `Remove` does not trigger row navigation. On success the row disappears and notify-current `crud.user.remove.success {id}`; on failure notify-current `crud.user.remove.error {id}`.
- **AC-USR-04** Edit form fields, with messages from the legacy template:
  - E-mail: required, valid email, unique.
  - Last name and First name: required.
  - Password and Password (repeat): required on create; on edit, required only if either is non-empty; they must match ("Passwords do not match.").
  - Admin checkbox; gravatar at 200px.
- **AC-USR-05** Uniqueness is checked asynchronously with `query({email})`. It is invalid only if a result's id ≠ the edited user's id (D9). An empty value is not checked.
- **AC-USR-06** Password fields start empty, including on edit (D8). Saving an edit with blank passwords omits `password` from the payload.
- **AC-USR-07** Save → notify-next `crud.user.save.success {id}` and navigate to `/admin/users`. Error → notify-current `crud.user.save.error`. Remove from the edit page → notify-next `crud.user.remove.success {id}` and navigate to the list.
- **AC-GRAV-01** URL = `https://www.gravatar.com/avatar/<md5(trim(lowercase(email)))>`, with `s`, `d` and `f=y` appended only when set. md5 is module-scoped, with no globals (D17).

### 12.2 admin-projects (cluster 2)
- **AC-APR-01** `/admin/projects` requires admin. Name/Description table; row → edit; "New Project".
- **AC-APR-02** Name is required; description is optional.
- **AC-APR-03** Product Owner and Scrum Master are both required selects with a `-- choose --` option. Their options are the PO/SM candidates labelled with `fullName`.
- **AC-APR-04** Dev-team table: one row per member (full name + Remove). The add row has a select of dev candidates (not PO, not already a member) and an `Add` button disabled until a choice is made. Add clears the selection. Removing the selected member clears the selection.
- **AC-APR-05** Candidate lists recompute live as PO/SM/team change (AC-DOM-01).
- **AC-APR-06** Save → notify-next `crud.project.save.success {id}` and go to `/admin/projects`. Error → notify-current `crud.project.save.error`. Remove → notify-next `crud.project.remove.success {id}` and go to the list (D21).

### 12.3 projects + productbacklog (cluster 3)
- **AC-PRJ-01** `/projects` requires authentication. `ProjectsTable` columns: Name, Description, My Role(s) (`formatRoles`), Tools ("Product backlog", "Sprints" links). Clicking the name/description cells opens the backlog.
- **AC-PRJ-02** `ProjectsTable` is exported for reuse (`{projects, currentUserId?}`). Without a user, the roles cell is empty.
- **AC-PBL-01** `/projects/:projectId/productbacklog` requires authentication. Columns: Name, Description, Priority, Estimation. Row → edit. Empty state: "No items in the backlog". There is a "New backlog item" button.
- **AC-PBL-02** Edit: Name (required), User story (required textarea), Priority (number, required), Estimation (number, required). A new item gets `projectId` from the route.
- **AC-PBL-03** Save or remove → back to the backlog list. Save error → notify-current `crud.backlogItem.save.error` (D14).

### 12.4 sprints + tasks (cluster 4)
- **AC-SPR-01** `/projects/:projectId/sprints` requires authentication. Columns: Name, Start date, End date, Status (literal `ACTIVE`, D12), Tools ("Tasks" button → the sprint's tasks). The first four cells open the edit page. Empty state: "No sprints defined". There is a "New sprint" button.
- **AC-SPR-02** Edit: Name (required), Capacity (number, required), Start date and End date (required free text).
- **AC-SPR-03** Backlog picker. Left table: the sprint's items (name links to `/projects/:projectId/productbacklog/:itemId`, estimation, Remove), with a footer "Estimation in total" = the sum over the items found. Right table: project backlog items not in the sprint, each with "Add to sprint". Add and remove update both tables immediately and mark the form dirty.
- **AC-SPR-04** Unknown ids in `sprintBacklog` render a row with blank name and estimation that can still be removed, and they count 0 toward the total (D13).
- **AC-SPR-05** Save or remove → the sprints list. Save error → notify-current `crud.sprint.save.error` (D14).
- **AC-TSK-01** `/projects/:projectId/sprints/:sprintId/tasks` requires authentication. Columns: Name (opens edit), Estimation, Remaining, and an empty Tools column. Empty state: "No tasks defined for this sprint". There is a "New task" button.
- **AC-TSK-02** Edit:
  - Name: required.
  - Product Backlog item: required select over the sprint's backlog items (`getByIds(sprint.sprintBacklog)`).
  - Description: required.
  - Estimation and Remaining: numbers, required.
  - State: required select over `TASK_STATES`; a new task defaults to `TODO`.
  - Assigned to: optional select over the project's team members (`getByIds(project.teamMembers)`), labelled `fullName`.
  - A new task gets `projectId` and `sprintId` from the route.
- **AC-TSK-03** Save or remove → `/projects/:projectId/sprints/:sprintId/tasks` (D6). Save error → notify-current `crud.task.save.error` (D14).

### 12.5 dashboard + projectsinfo (cluster 5)
- **AC-DSH-01** `/dashboard` requires authentication (D4). It renders "My projects" (`ProjectsTable` over **all** projects, with the current user's roles, D2/D3) and "My tasks" (**all** tasks: Name, Estimation, Remaining, empty Tools; empty state "No tasks for you!").
- **AC-PIN-01** `/projectsinfo` is public. Its loader fetches all projects, and the page renders only the heading `Projects info` (D1).

### 12.6 Stub (Phase 2 harness)
- **AC-STUB-01..n**: one per row/rule in §7.2–§7.3, as listed in §7.5.
