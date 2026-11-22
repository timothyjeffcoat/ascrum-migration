# Conversion Spec: AScrum, AngularJS 1.2 → React 19

Status: **APPROVED rev 3** (owner: "approve all" for §0.1 S1–S15, 2026-11-20; §0.2 Phase 3 amendments P1–P3 from owner answers, 2026-11-21). Workers start only after the Phase 2 exit gate (§13) and the wave gates (§8.1).
Revision history: rev 1 (initial). Rev 2 incorporates independent team-lead review `spec/reviews/spec-review-1.md` (25 findings, all confirmed).
Inputs: `spec/inventory.md` (facts) and `spec/questions.md` (owner answers, 2026-11-20).
Authority: this spec is the contract for every worker and reviewer session. If code and spec disagree, the spec wins until it is amended. If the spec is silent, raise a question (§8.5) and do not guess.

**Roles used in this spec**
- **Owner:** the human.
- **Orchestrator:** the main Claude Code session working with the owner. It launches workers and reviewers, relays questions and answers, and runs Phases 2 and 4.
- **Worker:** a session converting one cluster in its own worktree.
- **Reviewer:** a fresh session, never the worker, that reviews one cluster PR.

---

## 0. Decision record

| Q | Decision |
|---|---|
| A1 | **Port and fix obvious bugs.** Unfinished features are not finished. Every fix is logged as an intentional deviation (§6). |
| A2 | Dead code is **not ported** (§5.9). There is one addition: a global error boundary. |
| A3 | The stub never returns `password`. The user form never pre-fills a password; on edit, a blank password means "unchanged". Committed secrets are removed from the tree, and the README notes they remain in upstream history. |
| A4 | Legacy unit tests are the parity checklist. Every one of the 133 cases gets a status (§9). Headline metric: **N/133 carried over**. |
| A5 | The legacy app is reference-only, in `legacy/`, and its toolchain is not revived. There is **no executed legacy baseline**. |
| B1 | **React 19** (challenge to the proposed 18, accepted). |
| B2 | **React Router v7, data mode** (`createBrowserRouter`, loaders). No framework mode, no SSR. |
| B3 | No server-state library. Loaders plus a typed `api/` module. |
| B4 | **Bootstrap 2.1.1** compiled from the vendored LESS. Markup keeps the legacy class names. |
| B5 | Vitest + React Testing Library + MSW for unit tests; Playwright smoke e2e as a **blocking** CI gate. |
| B6 | A hand-written `useCrudForm` hook (§4.2). No form library. |
| B7 | **pnpm, Node 24 LTS.** Vite and TypeScript (strict) as proposed. |
| C1 | One shared stub handler module with **two adapters**: a Node dev/e2e server and MSW (unit tests plus the hosted static demo on GitHub Pages). |
| C2 | **Keep the legacy wire contract**, quirks included, all isolated in `api/`. The one exception: not-found is **404**, not the `" null "` body. |
| C3 | The stub supports only `{}`, top-level equality, and `{_id:{$in:[{$oid}]}}`. Any other query gets a **400**. |
| C4 | Deterministic seed data rich enough to demonstrate every screen and every fixed defect (§7.6). |
| C5 | `server/` moves to `legacy/server`. |
| D1 | **Keep** the login modal plus transparent retry queue. |
| D2 | Guard `/projects/**` and `/dashboard` for authenticated users. |
| D3 | Breadcrumbs keep raw path segments (ids). |
| D4 | Keep a tiny `messages` module (key → `{{name}}` interpolation). |
| D5 | Sprint dates stay free text. |
| D6 | **URLs are identical** (relative to the router basename) and use HTML5 history. |
| E1 | Layout per §3, on the long-lived `migration` branch of the public repo `ascrum-migration`. |
| E2 | One worktree and one branch (`convert/<cluster>`) per cluster. PRs target **`migration`**. The **reviewer agent merges** when CI is green and no blocking deviations are open. |
| E3 | Clusters per §8, with 3 concurrent workers. |
| E4 | GitHub Actions. Branch protection on `migration` requires the CI checks; the owner configures it once Phase 2 names the checks. |
| E5 | Metrics per §10. Token and cost figures only if they can be exported; never estimated. |
| E6 | Keep the MIT LICENSE; the README credits Pawel Kozlowski & Peter Bacon Darwin and links the book. |
| F1–F4 | One LinkedIn article at the end, aimed at managers, stating plainly that agents did the conversion. Measured numbers only. Drafts go in `docs/article/`. |

### 0.1 Decisions made by the spec beyond the owner's answers: **signed off**
Owner reply 2026-11-20: "approve all". No vetoes.

| # | Decision | Why |
|---|---|---|
| S1 | **D10 fixed:** HTTP errors reject instead of resolving `undefined` | loaders would otherwise render with `undefined` and crash |
| S2 | **D9 fixed:** `uniqueEmail` ignores the edited user, and stale async responses are discarded | otherwise A3's edit flow flags a user's own email as taken |
| S3 | **D17 fixed:** Gravatar uses https; md5 is module-scoped | the https demo would block http images |
| S4 | **D21 fixed (new defect):** removing a project shows "removed", not "saved" | legacy `onRemove` falls back to `onSave` |
| S5 | **Loader-failure UX:** the shell stays, a "Route change error" notification appears, and the content area is empty. Legacy kept the previous view instead | the data router renders an error element |
| S6 | **New message keys** §5.4: save errors for backlog item/sprint/task, remove errors for project/backlog item/sprint/task, `error.fatal` | needed by the D14 and S12 fixes and the error boundary |
| S7 | A second login-modal open is a **no-op** (legacy threw, and the error was swallowed) | — |
| S8 | The stub merges the stored `password` on a `users` PUT that omits it | the server side of A3 "blank = unchanged" |
| S9 | The stub has a dev/test-only `POST /__stub/reset` (excluded from the Pages build) | test isolation |
| S10 | Squash-merge PRs; bookkeeping goes through PRs (§8.3) | branch protection forbids direct pushes |
| S11 | Concurrent `/current-user` requests share **one in-flight promise**. Re-fetching while anonymous is otherwise unchanged | the start-up request and the first guard race in legacy |
| S12 | A failed **remove** shows a `*.remove.error` message. Legacy reused "save" wording or showed nothing | — |
| S13 | Selects get explicit blank options: "Assigned to" allows **unassigning** (legacy couldn't once set); other blanks read `-- choose --` | a React controlled select needs an explicit option |
| S14 | `login.error.serverError`'s `{{exception}}` = `HTTP <status>` (legacy printed `[object Object]`) | — |
| S15 | The notification **sticky bucket is dropped** (no producer exists once `pushSticky` is dead) | dead code (A2) |

### 0.2 Phase 3 amendments (owner answers to cluster questions)
Each row is an owner answer from `spec/questions/<cluster>.md`; the deviation logs cite them.

| # | Amendment | Source |
|---|---|---|
| P1 | **Linked labels in every form.** Each legacy `<label>` gets `htmlFor` and its control an `id` (the field name; the login modal uses `login-email`/`login-pass`). Nothing else in the markup changes: classes, strings and legacy quirks such as missing `name` attributes stay. Refines B4. | Q-foundation-1, Q-projects-1 (2026-11-21) |
| P2 | **The user form's `password` is a `values` field;** only `passwordRepeat` is `extra`. It starts as `''` on both routes (edit loads `{...user, password:''}`), so a password-only change on edit makes the form dirty and saveable, as in legacy. `toPayload` still omits a blank `password` (A3, AC-USR-06). §5.6 and AC-USR-04 are updated. | Q-admin-users-1 (2026-11-21) |
| P3 | **A stale team pick is cleared.** When `extra.selTeamMember` stops being a `teamMemberCandidates` entry (e.g. that user becomes Product Owner), it is cleared, so `Add` is disabled. Legacy kept the stale pick and could add the PO as a developer. AC-APR-04 is updated. | Q-admin-projects-1 (2026-11-21) |

Accepted as-is, no spec change: the breadcrumbs follow a failed navigation (DEV-foundation-02), the extra `div` around the project form's `CrudButtons` (Q-admin-projects-2), and a blank gravatar for an empty e-mail (Q-admin-users-2).

---

## 1. Goals and non-goals

**Goals**
- Behavioural parity with the legacy app (inventory §3–§6, §9), except for the deviations listed in §6 and §0.1.
- Boring, readable React: function components, hooks, explicit props, no clever abstractions.
- A runnable dev setup, a hosted demo, and CI that blocks on lint, typecheck, unit tests, build and e2e.

**Non-goals**
- Redesign or restyle (Bootstrap 5 is a possible later phase).
- Finishing unfinished features (D1 projects-info content, D2 per-user dashboard, D12 sprint status/dates/capacity).
- A real backend or database. Real auth security: the stub's plaintext comparison is acceptable *in the stub only*.
- SSR, i18n beyond the one locale, and accessibility work beyond the legacy markup. Logged as possible enhancements.

---

## 2. Target stack

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node 24 LTS, pnpm | `.nvmrc`, `engines`, and `packageManager` pinned |
| Build/dev | Vite (latest stable at Phase 2) | `base` = `/` in dev and for e2e; `/ascrum-migration/` for the Pages build |
| UI | React 19 + TypeScript `strict` | no `any`; `unknown` + narrowing at the API boundary |
| Routing | react-router v7, data mode | `createBrowserRouter(routes, {basename: import.meta.env.BASE_URL})` |
| Styles | Vendored Bootstrap 2.1.1 LESS via Vite's `less` support | `less` with `math: 'always'` (§11) |
| Unit tests | Vitest (jsdom), @testing-library/react + user-event, MSW node | shared helpers in `src/test/` (§13) |
| E2E | Playwright, Chromium, **`workers: 1`, `fullyParallel: false`** | each spec file starts with `POST /__stub/reset`; runs against the Node stub + `vite preview` |
| Lint/format | ESLint flat config + typescript-eslint + eslint-plugin-react-hooks; Prettier `--check` | |
| Versions | Latest stable of each at Phase 2, recorded in `pnpm-lock.yaml`, except react-router pinned to v7 and TypeScript to 6.0 (Q-harness-1/-2) | new dependencies after Phase 2 need an answered question |

---

## 3. Repository layout (branch `migration`)

```
legacy/
  client/                 # moved from /client, untouched
  server/                 # moved from /server; privatekey.pem, MongoLab apiKey and cookieSecret removed (A3/D18)
web/
  index.html  package.json  vite.config.ts  tsconfig.json  eslint.config.js  playwright.config.ts  vitest.config.ts
  public/                 # favicon.ico, img/spinner.gif, img/glyphicons-halflings(-white).png, mockServiceWorker.js
  src/
    main.tsx              # §4.1: providers OUTSIDE RouterProvider; MSW bootstrap when VITE_STUB=msw
    app/                  # router.tsx, AppShell, Header, Breadcrumbs, NotificationsOutlet, RouteError, RootErrorBoundary
    api/                  # http.ts, collection.ts, collections.ts, types.ts, ids.ts, errors.ts
    auth/                 # AuthProvider, useAuth, retryQueue.ts, LoginModal, LoginToolbar, guards.ts, currentUser.ts
    notifications/        # store.ts, useNotifications.ts, messages.ts
    crud/                 # useCrudForm.ts, CrudButtons.tsx, useListNav.ts, crudRoutes.ts, validators.ts
    domain/               # projects.ts (roles + candidates), users.ts, tasks.ts
    components/           # Gravatar.tsx, md5.ts
    features/<feature>/   # routes.tsx (§4.3) + screens + *.test.tsx
    styles/               # stylesheet.less, variables.less (asset paths rewritten, §11-6), bootstrap2/
    test/                 # §13: setup.ts, server.ts, stubControl.ts (Phase 2); renderRoute.tsx (cluster 0)
  stub/                   # store.ts, handlers.ts, query.ts, seed.ts, session.ts, msw.ts, server.ts, *.test.ts
  e2e/                    # shell.spec.ts (cluster 0), <cluster>.spec.ts, full-path.spec.ts (cluster 4)
spec/
  inventory.md  questions.md  conversion-spec.md  deviations.md  journal.md  metrics.jsonl
  questions/<cluster>.md  # per-cluster questions (§8.5)
  worklogs/<cluster>.md
  reviews/                # spec and cluster review reports
docs/article/
MIGRATION.md  CLAUDE.md  README.md
```

Dev wiring: `pnpm dev` runs Vite plus `stub/server.ts` on port 3001, with Vite proxying `/databases`, `/login`, `/logout`, `/current-user` and `/__stub` (same origin, real cookies). `pnpm dev:msw` and the Pages build run the stub in the browser via MSW.

---

## 4. Architecture

| AngularJS mechanism | React replacement |
|---|---|
| `$routeProvider` + `crudRouteProvider.routesFor()` | Each feature's `routes.tsx` (§4.3); `crudRoutes()` builds list/new/edit with identical paths |
| Route `resolve` | Route `loader` + `useLoaderData()` |
| `$routeChangeError` → notification | `RouteError` on the layout route (§4.1) |
| `securityAuthorizationProvider.require*` | `await requireAuthenticatedUser()` / `requireAdminUser()` at the top of loaders |
| `$http` interceptor + `securityRetryQueue` | `api/http.ts`: a 401 → `retryQueue.push('unauthorized-server', resend)` |
| `security` service + `$dialog` | `AuthProvider` + `LoginModal`, mounted outside the router (§4.1) |
| `$routeChangeSuccess` listeners | `router.subscribe` (notification rotation) and `useLocation` (breadcrumbs) |
| notifications / i18nNotifications / localizedMessages | `notifications/store.ts` (`useSyncExternalStore`) + `messages.ts` |
| `crudEdit` + `crudButtons` | `useCrudForm` (§4.2) + `<CrudButtons>` |
| `crudListMethods` | `useListNav(prefix)` → `{onNew(), onEdit(id)}` |
| `mongolabResource` + resource prototypes | `api/collection.ts` returning plain typed objects; prototype methods become pure functions in `domain/` |
| `httpRequestTracker` | Pending counter in `api/http.ts`, exposed as `usePendingRequests()` |
| `ng-include` of the projects-list template | `<ProjectsTable>` (cluster 3), reused by the dashboard |

**Wire-quirk isolation rule:** the `)]}',\n` prefix, XSRF, `_id.$oid`, `?q=` JSON, and `{user:null}` login failure are handled **only** in `api/` and `auth/`. Feature code sees `id?: string`, typed helpers, and `login() → Promise<boolean>`.

### 4.1 Composition (`main.tsx`)
```
<RootErrorBoundary>                        // class component; pushes error.fatal for errors outside the router
  <AuthProvider router={router}>           // owns currentUser, retry queue wiring; navigates via router.navigate
    <LoginModal/>                          // mounted here so guards in INITIAL loaders can open it (no deadlock)
    <RouterProvider router={router}/>
  </AuthProvider>
</RootErrorBoundary>
```
Route tree (`app/router.tsx`):
```
{ path: '/', element: <AppShell/>,                  // header, breadcrumbs, notifications outlet, <Outlet/>
  children: [
    { errorElement: <RouteError/>,                  // pathless layout route: errors render INSIDE the shell
      children: [ ...features' routes, { path: '*', loader: () => redirect('/projectsinfo') } ] } ] }
```
- `RouteError` reads `useRouteError()`. An `ApiError` or a guard rejection → notify-current `errors.route.changeError`; any other error (render or loader bug) → notify-current `error.fatal {message}`. It renders nothing in the content area.
- **Notification rotation** is subscribed in `main.tsx` with `router.subscribe(state => …)`. When `state.navigation.state === 'idle'` and `state.location.key` differs from the last rotated key, current-route := next-route and next-route := []. This runs before React renders the new route, so `RouteError`'s push (in its effect) lands *after* the rotation.
- Guard cancel and logout navigate with `router.navigate('/')`.

### 4.2 `useCrudForm` contract (cluster 0 implements; clusters 1–4 consume)
```ts
type ErrorKey = string                                   // e.g. 'required' | 'email' | 'equal' | 'uniqueEmail' | 'number'
type Ctx = { isNew: boolean; originalId?: string }
type Validator<V>      = (value: unknown, values: V, ctx: Ctx) => ErrorKey | null
type AsyncValidator<V> = (value: unknown, values: V, ctx: Ctx) => Promise<ErrorKey | null>

function useCrudForm<T extends object, X extends object = {}>(opts: {
  initial: Draft<T>                                     // loaded doc or §5.6 draft; deep-copied as `original`
  extra?: X                                             // form-only fields (password repeat, selected team member): never saved, never dirty
  validators?: Partial<Record<keyof T | keyof X, Validator<Draft<T> & X>[]>>
  asyncValidators?: Partial<Record<keyof T | keyof X, AsyncValidator<Draft<T> & X>>>
  numberFields?: (keyof T)[]                            // input string → number; '' → undefined (AngularJS type=number parity)
  toPayload?: (values: Draft<T>, extra: X, ctx: Ctx) => Draft<T>   // e.g. omit blank password (AC-USR-06)
  save: (payload: Draft<T>) => Promise<T>
  remove?: (doc: T) => Promise<void>
  onSave: (saved: T) => void
  onRemove?: (doc: Draft<T>) => void                    // default: onSave semantics are NOT reused (S4); each screen passes its own
  onError: (op: 'save' | 'remove') => void
}): {
  values: Draft<T>; extra: X
  setField(name: keyof T, raw: unknown): void; setExtra(name: keyof X, raw: unknown): void
  errors: Partial<Record<string, ErrorKey[]>>; showError(field: string, key: ErrorKey): boolean
  pending: boolean                                      // any async validator in flight
  canSave: boolean; canRevert: boolean; canRemove: boolean
  save(): void; revert(): void; remove(): void
}
```
Rules:
- Validation runs on every change. Errors are **visible whenever a field is invalid**; there is no "touched" concept (legacy parity, R-08).
- `canSave` = no errors && !pending && dirty. Dirty = deep-unequal(values, original). `extra` is excluded from dirty and payload.
- An async validator result is applied only if the field's value is unchanged since the request started (stale responses are discarded, S2).
- `revert()` restores `values` (and resets `extra` to its initial value). Validation reruns, so errors may still show, as in legacy.

### 4.3 Route-file contract
Each `features/<f>/routes.tsx` exports `export const routes: RouteObject[]`, with **flat, absolute paths** (leading `/`). Clusters 3 and 4 never nest under each other's routes.
`crudRoutes(basePath, {list?, create?, edit?}): RouteObject[]`, where each part is `{loader, Component}`, produces `basePath`, `basePath/new`, and `basePath/:itemId`.

---

## 5. Component mapping

Disposition: **port**, **fix** (§6 or §0.1), or **drop** (§5.9).

### 5.1 Foundation (cluster 0)
| Legacy unit | React unit | Disposition |
|---|---|---|
| `vendor/mongolab/mongolab-resource.js` | `api/http.ts`, `api/collection.ts`, `api/ids.ts`, `api/errors.ts` | port + fix D10 |
| resources `projects/backlog/sprints/tasks/users.js` | `api/collections.ts` + `domain/*.ts` | port; drop unused queries (D11) |
| `security.js`, `retryQueue.js`, `interceptor.js`, `authorization.js` | `auth/*`, `api/http.ts` | port + S7, S11 |
| `LoginFormController.js` + `form.tpl.html` | `auth/LoginModal.tsx` | port + S14 |
| `toolbar.js` + `.tpl.html` | `auth/LoginToolbar.tsx` | port |
| `notifications.js`, `i18nNotifications.js`, `localizedMessages.js`, `I18N.MESSAGES` | `notifications/*` | port + S6, S15 |
| `breadcrumbs.js`, `httpRequestTracker.js` | `app/Breadcrumbs.tsx`, `usePendingRequests` | port |
| `crud.js` (`crudListMethods`), `crudRouteProvider.js` | `crud/useListNav.ts`, `crud/crudRoutes.ts` | port |
| `directives/crud/edit.js`, `crudButtons.js` | `crud/useCrudForm.ts`, `crud/CrudButtons.tsx`, `crud/validators.ts` | port (§4.2) |
| `app.js`, `index.html`, `header.tpl.html`, `notifications.tpl.html` | `main.tsx`, `app/*` | port |
| `exceptionHandler.js` (intent only) | `RouteError` (`error.fatal` branch) + `RootErrorBoundary` | new (A2) |
| `Projects.prototype.*` + `TeamMembersController` candidate filters | `domain/projects.ts` | port + fix D13 |

### 5.2 Feature clusters
| Legacy unit | React unit | Cluster | Disposition |
|---|---|---|---|
| `admin-users.js` routes | `features/admin-users/routes.tsx` | 1 | port |
| `UsersListCtrl` + list tpl | `UsersList.tsx` | 1 | port |
| `UsersEditCtrl` + edit tpl | `UserEdit.tsx` | 1 | fix D8, D9 |
| `uniqueEmail.js` | `features/admin-users/uniqueEmail.ts` (AsyncValidator) | 1 | fix D9/S2 |
| `validateEquals.js` | `crud/validators.ts` `equalsField(name)` (cluster 0); used by UserEdit | 0/1 | port |
| `gravatar.js` (+ md5) | `components/Gravatar.tsx`, `components/md5.ts` | 1 | fix D17 |
| admin-projects routes + `ProjectsListCtrl` + list tpl | `features/admin-projects/routes.tsx`, `ProjectsAdminList.tsx` | 2 | port |
| `ProjectsEditCtrl` + `TeamMembersController` + edit tpl | `ProjectEdit.tsx`, `TeamMembers.tsx` | 2 | fix D21/S4 |
| `projects.js` + `projects-list.tpl.html` | `features/projects/routes.tsx`, `ProjectsPage.tsx`, `ProjectsTable.tsx` | 3 | fix D5, D20 |
| `productbacklog.js` + tpls | `features/productbacklog/*` (`BacklogList`, `BacklogItemEdit`) | 3 | fix D14; guard |
| `sprints.js` + tpls | `features/sprints/*` (`SprintsList`, `SprintEdit`, `SprintBacklogPicker`) | 4 | fix D13, D14; guard |
| `tasks.js` + tpls | `features/tasks/*` (`TasksList`, `TaskEdit`) | 4 | fix D6, D14; guard |
| `dashboard.js` + tpl | `features/dashboard/*` (`Dashboard`, using `ProjectsTable`) | 5 | fix D3; guard (D4) |
| `projectsinfo.js` + tpl | `features/projectsinfo/*` (`ProjectsInfo`) | 5 | port (D1 preserved) |

### 5.3 Routes (identical paths; D6)
All 18 legacy routes (inventory §3, R1–R18) exist with identical paths; `*` redirects to `/projectsinfo`.
- `requireAdminUser`: R13–R18.
- `requireAuthenticatedUser`: R2–R12 (R2 and R4–R12 newly guarded, per D2/D4).
- R1 is public.

### 5.4 Message catalogue (`notifications/messages.ts`; cluster 0 owns; complete up front)
All 12 legacy keys verbatim, plus:
| Key | Text |
|---|---|
| `crud.project.remove.error` | `Something went wrong when removing project with id '{{id}}'.` |
| `crud.backlogItem.save.error` | `Something went wrong when saving a backlog item...` |
| `crud.backlogItem.remove.error` | `Something went wrong when removing a backlog item...` |
| `crud.sprint.save.error` | `Something went wrong when saving a sprint...` |
| `crud.sprint.remove.error` | `Something went wrong when removing a sprint...` |
| `crud.task.save.error` | `Something went wrong when saving a task...` |
| `crud.task.remove.error` | `Something went wrong when removing a task...` |
| `error.fatal` | `An unexpected error occurred: {{message}}` |

### 5.5 Types (`api/types.ts`)
Wire documents carry `_id?: {$oid}`. `api/` converts them to app types with `id?: string`, and converts back on save. **`api/` does not fill defaults**: optional fields stay optional, so the D13 handling in `domain/` is exercised.
```ts
type User        = { id?: string; email: string; firstName: string; lastName: string; admin?: boolean; password?: string } // password only ever outbound
type Project     = { id?: string; name: string; desc?: string; productOwner?: string; scrumMaster?: string; teamMembers?: string[] }
type BacklogItem = { id?: string; projectId: string; name: string; desc: string; priority: number; estimation: number }
type Sprint      = { id?: string; projectId: string; name: string; capacity: number; start: string; end: string; sprintBacklog?: string[] }
type TaskState   = 'TODO' | 'IN_DEV' | 'BLOCKED' | 'IN_TEST' | 'DONE'
type Task        = { id?: string; projectId: string; sprintId: string; productBacklogItemId: string; name: string; desc: string; estimation: number; remaining: number; state: TaskState; assignedUserId?: string }
type CurrentUser = { id: string; email: string; firstName: string; lastName: string; admin: boolean }
type Draft<T>    = { [K in keyof T]?: T[K] }   // what a form holds before validation guarantees required fields
```
Unknown extra fields on wire documents are preserved on round-trip (a PUT replaces the whole document).

### 5.6 Initial drafts for "new" routes
Text fields start as `''`; numbers and selects start as `undefined`; `toPayload` omits `undefined` keys.
| Route | Draft |
|---|---|
| `/admin/users/new` | `{email:'', lastName:'', firstName:'', admin:false, password:''}`; extra `{passwordRepeat:''}` (P2) |
| `/admin/projects/new` | `{name:'', desc:'', teamMembers:[]}`; extra `{selTeamMember: undefined}` |
| `…/productbacklog/new` | `{projectId, name:'', desc:''}` |
| `…/sprints/new` | `{projectId, name:'', start:'', end:'', sprintBacklog:[]}` |
| `…/tasks/new` | `{projectId, sprintId, name:'', desc:'', state:'TODO'}` |

Loaded docs for edit routes: a missing `sprintBacklog`/`teamMembers` is set to `[]` **inside the form only** (`initial`), never in `api/`.

### 5.9 Not ported (A2)
- `directives.modal`.
- `services.exceptionHandler`, replaced per §5.1.
- `crudEditMethods`, `getCssClasses`.
- The `/authenticated-user` and `/admin-user` endpoints.
- `Projects.forUser`; `Tasks.forUser`, `forProductBacklogItem`, `forProject`.
- `notifications.pushSticky` and the sticky bucket (S15).
- `ProjectsViewCtrl.viewProject` (D5).
- `security.logout(redirectTo)`'s parameter: no caller passes it, and logout always goes to `/`.

---

## 6. Defect disposition (inventory §13)

| ID | Disposition | Behaviour in the port | Test rule |
|---|---|---|---|
| D1 | preserved | `/projectsinfo` loads projects and renders only `<h3>Projects info</h3>` | AC test |
| D2 | preserved | dashboard shows all projects and all tasks | AC test |
| D3 | **fixed** | dashboard `ProjectsTable`: roles shown, working links | named test |
| D4 | **fixed** | `/dashboard` requires authentication | named test |
| D5 | **fixed** (dropped) | no `viewProject` | reviewer checks absence |
| D6 | **fixed** | saving a task → `/projects/:projectId/sprints/:sprintId/tasks` | named test |
| D7 | **fixed** (stub) | `password` never appears in any response | AC-STUB-11 (Phase 2) |
| D8 | **fixed** | password fields always start empty | named test |
| D9 | **fixed** | uniqueness ignores the edited user; stale results discarded | named test |
| D10 | **fixed** | non-2xx responses reject → `RouteError` / `onError` | named test |
| D11 | **fixed** (dropped) | mis-keyed task queries removed | reviewer checks absence |
| D12 | preserved | status `ACTIVE`; free-text dates; capacity unused | AC test |
| D13 | **fixed** | missing backlog ids: blank row, removable, counted as 0; missing `teamMembers` treated as `[]` | named test |
| D14 | **fixed** | save errors notify-current (§5.4) | named test |
| D15 | preserved | non-admin writes to users/projects → 401 → modal with "not authorized" | AC test |
| D16 | **fixed** (dropped) | §5.9 | reviewer checks absence |
| D17 | **fixed** | module-scoped md5, https URL | named test |
| D18 | **fixed** | secrets removed from `legacy/server`; README note | Phase 2 exit check (grep) |
| D19 | preserved | bad login = 200 `{user:null}`; logout errors not surfaced | AC test |
| D20 | **fixed** | roles render as `PO`, `SM, DEV`, or empty | named test |
| D21 | **fixed** | project remove pushes `crud.project.remove.success` | named test |

"Named test" means a test whose name contains the D-id.

---

## 7. API stub plan

### 7.1 Shape
`stub/handlers.ts` exports `handle(req: StubRequest, ctx: {store, sessions}): StubResponse`, where `StubRequest = {method, path, query, headers, cookies, body}` and `StubResponse = {status, headers, setCookies, body}`. The adapters (`stub/msw.ts`, `stub/server.ts`) only translate to and from this shape.

### 7.2 Transport rules (legacy-faithful)
- Every JSON response body is prefixed with `)]}',\n` (`Content-Type: application/json`).
- Every response sets cookie `XSRF-TOKEN=<session token>`. Session: cookie `sid` → `{userId?, xsrf}` in memory.
- **Order of checks:**
  1. XSRF, for non-GET/HEAD/OPTIONS requests (including `/login`): a header mismatch → **403** with body `Forbidden` (text/plain; Express 3 `res.send(403)`).
  2. Auth (§7.3).
  3. Routing.

### 7.3 Endpoints
| Method | Path | Behaviour |
|---|---|---|
| POST | `/login` | `{email,password}`; match → set session user, 200 `{user: CurrentUser}`; no match → 200 `{user:null}` |
| POST | `/logout` | clear session user → 204 |
| GET | `/current-user` | 200 `{user: CurrentUser \| null}` |
| GET | `/databases/ascrum/collections/:c` | `?q=` optional JSON → 200 `Doc[]` |
| GET | `/databases/ascrum/collections/:c/:id` | 200 `Doc` / **404** `{message}` |
| POST | `/databases/ascrum/collections/:c` | 200 created Doc with new `_id.$oid` |
| PUT | `/databases/ascrum/collections/:c/:id` | replace (users: keep stored password if absent, S8) → 200 Doc / 404 |
| DELETE | `/databases/ascrum/collections/:c/:id` | 200 deleted Doc / 404 |
| POST | `/__stub/reset` | dev/test only; reseed and clear sessions → 204. Skips sessions and XSRF (Q-harness-4) |

- `:db` must be `ascrum`; `:c` must be one of `users, projects, productbacklog, sprints, tasks`. Anything else → 404.
- Writes need a session user, otherwise **401** `{user:null}`. Writes to `users`/`projects` also need admin, otherwise **401** `{user}` (D15).
- `password` is stripped from every `users` document in every response.
- `q` grammar per C3. Anything else, or invalid JSON → **400** `{message}`.
- Ids are 24-hex. The seed uses fixed ids; new ids come from a counter, deterministic after a reset.

### 7.4 Adapters
- **Node** (`node:http`, port 3001, real cookies): `pnpm dev` (proxied) and Playwright.
- **MSW**: `setupWorker` (`dev:msw`, Pages) and `setupServer` (Vitest).
  - Cookies go through the request `Cookie` header and `document.cookie`.
  - If mocked `Set-Cookie` doesn't reach `document.cookie`, the adapter writes the cookies itself (§11-2).
  - The Pages build excludes `/__stub/reset`.

### 7.5 Contract tests (`stub/*.test.ts`, Phase 2)
| AC | Rule |
|---|---|
| AC-STUB-01 | JSON responses carry the `)]}',\n` prefix |
| AC-STUB-02 | `XSRF-TOKEN` is set on every response, stable within a session |
| AC-STUB-03 | an unsafe method without a matching header → 403 `Forbidden`, checked **before** auth, including `/login` |
| AC-STUB-04 | login success sets the session and returns `{user}`; failure → 200 `{user:null}` |
| AC-STUB-05 | logout → 204, session user cleared |
| AC-STUB-06 | `/current-user` → `{user}` / `{user:null}` |
| AC-STUB-07 | `q`: `{}`, equality (AND), `$in` of `$oid` (including an empty list → `[]`); anything else → 400 |
| AC-STUB-08 | GET by id → doc / 404 |
| AC-STUB-09 | POST creates with a new id; PUT replaces; DELETE returns the deleted doc; missing → 404 |
| AC-STUB-10 | anonymous write → 401 `{user:null}`; non-admin write to users/projects → 401 `{user}` |
| AC-STUB-11 | no response ever contains `password` (D7) |
| AC-STUB-12 | users PUT without `password` keeps the stored one (S8) |
| AC-STUB-13 | unknown db or collection → 404 |
| AC-STUB-14 | reset reseeds and clears sessions; the route is absent from the Pages build |
| AC-STUB-15 | after a reset, generated ids and seed are deterministic |

### 7.6 Seed (C4)
Deterministic, in `stub/seed.ts`; credentials go in the README.
- **Users:** `admin@abc.com`/`changeme` (admin); `po@`, `sm@`, `dev1@`, `dev2@`, `outsider@ascrum.test`, all with password `demo`.
- **Projects:**
  - "Webshop": PO po, SM sm, devs dev1, dev2.
  - "Mobile App": PO sm, SM dev1, dev dev2.
  - "Legacy Cleanup": PO admin, `teamMembers` **absent** (D13).
- **Backlog:** about 6 items on Webshop, 3 on Mobile App, 0 on Legacy Cleanup.
- **Sprints:**
  - Webshop: 2, one of which references a deleted backlog id (D13).
  - Mobile App: 1.
  - Legacy Cleanup: 0.
- **Tasks:** about 12 on Webshop, covering all 5 states, some unassigned. One sprint has 0 tasks.

---

## 8. Clusters, schedule, ownership

### 8.1 Clusters
| # | Cluster | Owns (write access) | Depends on | Wave |
|---|---|---|---|---|
| 0 | foundation | `web/src/{main.tsx,app,api,auth,notifications,crud,domain}/**`, `web/src/test/renderRoute.tsx`, placeholder `features/*/routes.tsx` (each feature's file passes to its cluster), `web/e2e/shell.spec.ts` | Phase 2 exit (§13) | serial, first |
| 1 | admin-users | `features/admin-users/**`, `components/**`, `e2e/admin-users.spec.ts` | 0 | A |
| 2 | admin-projects | `features/admin-projects/**`, `e2e/admin-projects.spec.ts` | 0 | A |
| 3 | projects + productbacklog | `features/{projects,productbacklog}/**`, `e2e/projects.spec.ts` | 0 | A |
| 4 | sprints + tasks | `features/{sprints,tasks}/**`, `e2e/sprints-tasks.spec.ts`, **`e2e/full-path.spec.ts`** | 0, A merged | B |
| 5 | dashboard + projectsinfo | `features/{dashboard,projectsinfo}/**`, `e2e/dashboard.spec.ts` | 0, 3 (`ProjectsTable`) | B |
| * | **every cluster** may also write | `spec/worklogs/<cluster>.md`, `spec/questions/<cluster>.md` | — | — |

- `full-path.spec.ts` covers: login as admin → create project → backlog item → sprint (add the item) → task → logout.
- **Gates:**
  - **Wave A starts** only when cluster 0 is merged and §11-4 is proven.
  - **Wave B starts** only when all wave-A clusters are merged.
  - Anything outside the owned paths → a question (§8.5); never an edit.

### 8.2 Workflow per cluster
1. **Worker** (fresh session, worktree, branch `convert/<cluster>` from `migration`): implements, ports the §9 cases, and keeps its worklog. When the Definition of Done in CLAUDE.md is met, it opens a PR into `migration` and **stops**.
2. **CI** must be green.
3. **Reviewer** (fresh session; never the worker), working on the PR branch:
   - Commits the cluster's `MIGRATION.md` row = `converted`.
   - Reviews each AC against code **and** a named test, plus the §5/§6 diff and the owned-paths check.
   - Posts an AC checklist as a PR comment.
   - Appends findings to `spec/deviations.md` and commits them on the PR branch.
4. **Blocking deviation:** the reviewer stops and reports. The **orchestrator** relaunches a worker session on the same branch, briefed with the deviation ids. Then steps 2–3 repeat.
5. **Pass:**
   - The reviewer commits row = `verified` plus a `spec/journal.md` entry on the PR branch.
   - Once CI is green it runs `gh pr merge --squash`.
   - It then opens a bookkeeping PR `chore/status-<cluster>` (row = `merged`, PR link) and squash-merges it once CI is green.

### 8.3 `MIGRATION.md`
`pending` → `converted` → `verified` → `merged`, as defined in §8.2. Only reviewers edit it, and only through PRs (S10). Workers never touch it.

### 8.4 `spec/deviations.md` entry format
`DEV-<cluster>-<nn> | AC/D id | what was wrong | caught by (CI / reviewer / owner / e2e) | severity (blocking / non-blocking) | resolution | PR link`.
Ids are cluster-scoped, so concurrent reviewers never clash.

### 8.5 Questions during Phase 3
1. A worker appends to `spec/questions/<cluster>.md` with id `Q-<cluster>-<n>` (context, options, recommendation), marks the item blocked in its worklog, and continues with unblocked work. If nothing is unblocked, it commits, pushes the branch, and stops.
2. The orchestrator relays the question to the owner. The answer is committed to `migration` through a small PR, which also amends this spec if needed.
3. The orchestrator relaunches or resumes the worker, which rebases onto `migration` and continues.

---

## 9. Legacy test porting (A4)

Every legacy `it` gets one status:
- **ported:** same assertion, new mechanism;
- **adapted:** same behaviour, assertion reshaped;
- **n/a:** reason mandatory;
- **dead:** the unit is not ported.

The worker records each case in its worklog table, and the reviewer checks the table. The headline metric is **(ported + adapted) / 133**, reported with the dead and n/a counts beside it.

| Legacy spec | Cases | Target | Cluster |
|---|---|---|---|
| security/security.spec | 15 | `auth/*.test.tsx` | 0 |
| security/retry-queue.spec | 8 | `auth/retryQueue.test.ts` | 0 |
| security/login/login-toolbar.spec | 7 | `auth/LoginToolbar.test.tsx` | 0 |
| security/authorization.spec | 4 | `auth/guards.test.ts` | 0 |
| security/interceptor.spec | 3 | `api/http.test.ts` | 0 |
| directives/crud/edit.spec | 23 | `crud/useCrudForm.test.tsx`, `crud/CrudButtons.test.tsx` | 0 |
| services/crud.spec (list methods) | 2 | `crud/useListNav.test.tsx` | 0 |
| notifications, i18nNotifications, localizedMessages | 5+3+4 | `notifications/*.test.ts` | 0 |
| breadcrumbs, httpRequestTracker | 3+2 | `app/*.test.tsx`, `api/http.test.ts` | 0 |
| admin/users (edit 3, list 1, uniqueEmail 5, validateEquals 4) + gravatar 5 | 18 | `features/admin-users/*`, `components/*`, `crud/validators.test.ts` (validateEquals: cluster 0) | 1 (0 for validateEquals) |
| admin/projects/admin-projects.spec | 11 | `features/admin-projects/*` | 2 |
| projects/projects.spec | 5 | `features/projects/*` | 3 |
| services/crud.spec (crudEditMethods) | 17 | **dead** | — |
| services/exceptionHandler.spec | 3 | **dead** (intent covered by AC-NOT-05) | — |

**Pre-assigned statuses** (the reviewer enforces these):
| Case (legacy file:line) | Status | Reason |
|---|---|---|
| edit.spec:221, 226, 247, 256 (`getCssClasses`) | n/a | `getCssClasses` dropped (§5.9) |
| edit.spec: assertions at :60 and :74 on `getCssClasses` | adapted | drop those assertions, keep the rest |
| projects.spec:34 (`viewProject` changes the location) | n/a | D5 |
| notifications.spec:29 (rejects non-objects) | n/a | enforced by the TypeScript types |
| notifications.spec:12, 38, 51 and i18nNotifications.spec:16 (use `pushSticky`) | adapted | use the current/next-route buckets (S15) |
| admin-users-edit.spec:26 (extracts the password) | n/a | contradicts D8; replaced by the D8 test |
| security.spec:97 (logout redirects to the given path) | n/a | parameter dropped (§5.9) |
| authorization.spec:25 (GET `/current-user`) | ported | S11 keeps the request |

New tests are **required** for every §12 AC, including screens the legacy suite never covered.

---

## 10. Metrics (E5)
Source of truth: `spec/metrics.jsonl` (hook) and `gh` data. The journal cites them and never estimates.
- Wall-clock per phase and cluster (first/last event per branch).
- Sessions and sub-agents per cluster.
- Local gate runs and failures before green; CI runs and failures per PR (`gh run list`).
- Deviations by "caught by" and severity.
- Legacy cases: ported + adapted / 133, with dead and n/a counts.
- New tests.
- LOC: legacy **2,290** lines (40 JS files = 1,849 + 17 templates = 441, measured with `wc -l`) vs `web/src` excluding tests, counted the same way; test LOC separately.
- Bundle: legacy size computed from the vendored files (no Grunt run) vs `vite build` output, gzip.
- Human interventions: owner answers, overrides and vetoes.

---

## 11. Risks to verify in Phase 2
1. **Bootstrap 2 LESS on less 4:** needs `math: 'always'`. Verify with a Playwright computed-style check (AC-SHELL-07). *Phase 2 result: proven, but it also needed three commented syntax patches in the vendored copy and a small PostCSS plugin that drops only the IE star hacks LightningCSS rejects (`spec/questions/harness.md` Q-harness-3; it replaced `errorRecovery`, review R2-05).*
2. **MSW cookies:** whether a mocked `Set-Cookie` reaches `document.cookie` in the browser worker; if not, the §7.4 fallback. *Phase 2 result: in Chromium, MSW 3 does it itself (fallback off); in jsdom it does not (fallback on in `src/test/server.ts`).*
3. **GitHub Pages:** 404.html SPA fallback, `/ascrum-migration/` basename, MSW worker scope.
4. **Router v7 data mode:** the §4.1 composition, guard → modal on a deep-link reload, and `router.subscribe` rotation ordering. Prove these with tests before wave A (gate in §8.1).
5. **Playwright in CI:** browser install time; Chromium only.
6. **Absolute legacy asset paths** (`/static/img/...` in `variables.less:133-134` and `header.tpl.html:20`): rewrite them to base-relative paths for both `/` and `/ascrum-migration/`.

---

## 12. Acceptance criteria
Each AC must be covered by at least one test whose name starts with the AC id.
"Notify-next" / "notify-current" mean a next-route / current-route notification.

**Class-parity rule:** every screen has at least one assertion on its legacy root classes, e.g. `table table-bordered table-condensed table-striped table-hover` or `well`. Snapshots stay banned.

### 12.0 Foundation (cluster 0)
**API**
- **AC-API-01** The `)]}',\n` prefix is stripped before parsing; bodies without it also parse.
- **AC-API-02** Requests are same-origin with credentials. Unsafe methods send `X-XSRF-TOKEN` = the current `XSRF-TOKEN` cookie, **read at send time**.
- **AC-API-03** `collection(name)` targets `/databases/ascrum/collections/<name>`.
  - `query(q)` sends `q=JSON.stringify(q)`.
  - **`all()` sends `q={}`**, as legacy did.
- **AC-API-04** A 404 on `getById` rejects with `ApiError{code:'resource.notfound'}`; any other non-2xx rejects with `ApiError{status}` (D10).
- **AC-API-05** `getByIds(ids)` sends `{_id:{$in:[{$oid}…]}}`, including for an empty list.
- **AC-API-06** `save` POSTs a new document and PUTs an existing one to `/<id>` without `_id`. `remove` DELETEs `/<id>`. Results are converted to app types.
- **AC-API-07** A 401 enqueues `unauthorized-server`. On retry, the request is **re-sent with freshly computed headers**. The caller's promise settles with the retry's outcome, or rejects on cancel.
- **AC-API-08** `usePendingRequests()` is true while at least one request is in flight.

**Domain**
- **AC-DOM-01** `canActAsProductOwner`, `canActAsScrumMaster`, `canActAsDevTeamMember`, `isDevTeamMember` follow inventory §6.1; a missing `teamMembers` is treated as `[]` (D13).
- **AC-DOM-02** `getRoles`: PO is exclusive; otherwise `SM` then `DEV`. `formatRoles` joins with `", "` (D20).
- **AC-DOM-03** `fullName` = `"Last First (email)"`.
- **AC-DOM-04** `TASK_STATES` = `TODO, IN_DEV, BLOCKED, IN_TEST, DONE`.
- **AC-DOM-05** `productOwnerCandidates`, `scrumMasterCandidates`, `teamMemberCandidates(users, project)` match legacy admin-projects.js:63-79, including "not already a member".

**Auth**
- **AC-AUTH-01** `/current-user` behaviour:
  - On start, `/current-user` is requested.
  - While anonymous, each guard requests it again (legacy).
  - While authenticated, the cached user is returned without a request.
  - Concurrent requests share one in-flight promise (S11).
- **AC-AUTH-02** Every retry-queue push opens the login modal; a push while it is open does not open another (S7).
- **AC-AUTH-03** Modal reason, when the queue is non-empty:
  - authenticated → `login.reason.notAuthorized`;
  - anonymous → `login.reason.notAuthenticated`.

  An empty queue (opened from the toolbar) shows no reason alert.
- **AC-AUTH-04** Sign in is disabled until the email is valid and the password is non-empty.
  - `{user:null}` → `login.error.invalidCredentials`.
  - HTTP failure → `login.error.serverError` with exception `HTTP <status>` (S14).
- **AC-AUTH-05** Success closes the modal and retries the queued items in order. Clear empties the fields. Cancel rejects every queued item and runs `router.navigate('/')`.
- **AC-AUTH-06** Guards in loaders continue if satisfied. Otherwise they push `unauthenticated-client` / `unauthorized-client` and wait; after login the loader completes without a reload.
- **AC-AUTH-07** Logout POSTs `/logout`, clears the user, and navigates to `/`.
- **AC-AUTH-08** Toolbar: authenticated → `First Last` + "Log out"; otherwise "Log in" (opens the modal with no reason).
- **AC-AUTH-09** Reloading a guarded deep link (e.g. `/admin/users`) while logged out shows the modal. Logging in as admin completes the original navigation (unit test + e2e).

**Notifications**
- **AC-NOT-01** Two buckets, current-route and next-route; `getCurrent` = current-route. On each completed navigation (new `location.key`), current := next and next := []. The rotation happens before the new route renders (§4.1).
- **AC-NOT-02** Pushes take a key + params with `{{name}}` interpolation. A missing key renders `?key?`.
- **AC-NOT-03** The outlet renders one `alert alert-<type>` per notification, each with an `x` close button. The outlet is not rendered when empty.
- **AC-NOT-04** An `ApiError` or guard rejection in a loader → notify-current `errors.route.changeError`. The shell stays and the content area is empty.
- **AC-NOT-05** Any other error under the layout route (render or non-API loader error) → notify-current `error.fatal {message}`, with the shell intact. Errors outside the router → `RootErrorBoundary` renders the same message.

**CRUD** (§4.2)
- **AC-CRUD-01** `original` is a deep copy of `initial`. Dirty = deep-unequal(values, original); `extra` is excluded.
- **AC-CRUD-02** `canSave` = no errors && !pending && dirty; `canRevert` = dirty; `canRemove` = has id.
- **AC-CRUD-03** `revert` restores values and `extra` and reruns validation. Errors still show if invalid (legacy).
- **AC-CRUD-04** Save success → original := the server result → `onSave(result)`. Save failure → `onError('save')`.
- **AC-CRUD-05** Remove with an id → DELETE → `onRemove`; without an id → `onRemove` with no request. Remove failure → `onError('remove')`.
- **AC-CRUD-06** Errors are visible whenever a field is invalid; there is no touched concept. `showError(field, key)` reflects the current errors.
- **AC-CRUD-07** `CrudButtons`:
  - `Save` (`btn btn-primary save`, disabled unless canSave);
  - `Revert changes` (`btn btn-warning revert`, disabled unless canRevert);
  - `Remove` (`btn btn-danger remove`, rendered only if canRemove).

  All are `type="button"`.
- **AC-CRUD-08** `useListNav(prefix)`: `onNew` → `prefix/new`; `onEdit(id)` → `prefix/id`.
- **AC-CRUD-09** Cross-field and conditional validators get `(value, values, ctx)`. `equalsField(name)` fails with `equal`, and re-validates when the other field changes.
- **AC-CRUD-10** Async validator: `pending` is true while in flight and `canSave` is false; a stale result (the value changed meanwhile) is ignored.
- **AC-CRUD-11** `numberFields`: input `'3'` → `3`; `''` → `undefined`, which fails `required`.
- **AC-CRUD-12** `toPayload` output is what gets saved; `extra` never reaches the payload.

**Shell**
- **AC-SHELL-01** The brand "AScrum" → `/dashboard` if authenticated, otherwise `/projectsinfo`.
- **AC-SHELL-02** Nav:
  - "Current Projects" always;
  - "My Projects" when authenticated;
  - the "Admin" dropdown (Manage Projects, Manage Users) for admins only, toggled by click and closed when an item is chosen.
- **AC-SHELL-03** A nav item is `active` when its path matches the first path segment.
- **AC-SHELL-04** Breadcrumbs: one per raw segment; all but the last are links. They update only after navigation completes.
- **AC-SHELL-05** The spinner image (base-relative src) shows while requests are pending.
- **AC-SHELL-06** An unknown path redirects to `/projectsinfo`. A deep-link reload works:
  - e2e on `vite preview` with base `/`;
  - a Playwright check on a preview of the Pages build with base `/ascrum-migration/` and MSW.
- **AC-SHELL-07** Playwright: `.navbar-inner` has a Bootstrap 2 computed style (gradient background), and a glyph icon's background-image resolves (no 404). The shell uses the legacy classes.

### 12.1 admin-users (cluster 1)
- **AC-USR-01** `/admin/users` requires admin. Columns: gravatar (50px, `d=monsterid`), E-mail, Last name, First name, and a `Remove` button.
- **AC-USR-02** A row click → `/admin/users/:id`; "New User" → `/admin/users/new`.
- **AC-USR-03** `Remove` doesn't trigger row navigation.
  - Success → the row disappears, plus notify-current `crud.user.remove.success {id}`.
  - Failure → notify-current `crud.user.remove.error {id}`.
- **AC-USR-04** Edit fields, with legacy messages verbatim:
  - E-mail: required, valid, unique.
  - Last name and First name: required.
  - Password (a `values` field) / Password (repeat) (an `extra` field; P2): required on create; on edit, required only if either is non-empty; they must match ("Passwords do not match.").
  - Admin checkbox; gravatar at 200px.
- **AC-USR-05** `uniqueEmail` AsyncValidator: `query({email})`; invalid only if some result id ≠ `ctx.originalId` (D9). An empty value skips the check.
- **AC-USR-06** Passwords always start empty (D8). On edit with blank passwords, `password` is omitted from the payload.
- **AC-USR-07** Save → notify-next `crud.user.save.success {id}` → `/admin/users`. Save error → notify-current `crud.user.save.error`. Remove from edit → notify-next `crud.user.remove.success {id}` → list. Remove error → notify-current `crud.user.remove.error {id}`.
- **AC-GRAV-01** `https://www.gravatar.com/avatar/<md5(trim(lower(email)))>`, with `s`, `d` and `f=y` added only when set; md5 is module-scoped (D17).

### 12.2 admin-projects (cluster 2)
- **AC-APR-01** `/admin/projects` requires admin. Name/Description table; row → edit; "New Project".
- **AC-APR-02** Name is required; description is optional.
- **AC-APR-03** Product Owner and Scrum Master are required selects with a `-- choose --` option. Options come from the AC-DOM-05 candidates, labelled with `fullName`.
- **AC-APR-04** Dev-team table: rows of full name + `Remove`.
  - The add row has a select (`extra.selTeamMember`; blank option `-- choose --`) of `teamMemberCandidates`, plus `Add`, disabled until a choice is made.
  - Add clears the selection. Removing the selected member clears it too. A selection that is no longer a candidate is cleared (P3).
- **AC-APR-05** Candidate lists recompute as PO/SM/team change.
- **AC-APR-06** Outcomes:
  - Save → notify-next `crud.project.save.success {id}` → `/admin/projects`.
  - Save error → notify-current `crud.project.save.error`.
  - Remove → notify-next `crud.project.remove.success {id}` → list (D21).
  - Remove error → notify-current `crud.project.remove.error {id}`.

### 12.3 projects + productbacklog (cluster 3)
- **AC-PRJ-01** `/projects` requires authentication. `ProjectsTable` columns: Name, Description, My Role(s) (`formatRoles`), Tools ("Product backlog", "Sprints"). The name and description cells open the backlog.
- **AC-PRJ-02** `ProjectsTable({projects, currentUserId?})` is exported; with no user, the roles cell is empty.
- **AC-PBL-01** `/projects/:projectId/productbacklog` requires authentication. Columns: Name, Description, Priority, Estimation. Row → edit. Empty state: "No items in the backlog". Button: "New backlog item".
- **AC-PBL-02** Edit: Name (required), User story (required textarea), Priority and Estimation (`numberFields`, required). The draft is per §5.6.
- **AC-PBL-03** Save/remove → backlog list. Save error → `crud.backlogItem.save.error`; remove error → `crud.backlogItem.remove.error`; both notify-current (D14).

### 12.4 sprints + tasks (cluster 4)
- **AC-SPR-01** `/projects/:projectId/sprints` requires authentication. Columns: Name, Start date, End date, Status (literal `ACTIVE`), Tools ("Tasks" → the sprint's tasks). The first four cells open the edit page. Empty state: "No sprints defined". Button: "New sprint".
- **AC-SPR-02** Edit: Name (required), Capacity (number, required), Start date and End date (required free text).
- **AC-SPR-03** Backlog picker. Both tables' item names link to `/projects/:projectId/productbacklog/:itemId`.
  - Left table: the sprint's items (name, estimation, `Remove`), with footer "Estimation in total" = the sum of the items found.
  - Right table: project backlog items not in the sprint, with "Add to sprint".
  - Add and remove update both tables immediately and mark the form dirty. All buttons are `type="button"`.
- **AC-SPR-04** Unknown ids in `sprintBacklog` → a blank, removable row counted as 0 (D13).
- **AC-SPR-05** Save/remove → sprints list. Save error → `crud.sprint.save.error`; remove error → `crud.sprint.remove.error`; both notify-current (D14).
- **AC-TSK-01** `/projects/:projectId/sprints/:sprintId/tasks` requires authentication. Columns: Name (opens edit), Estimation, Remaining, empty Tools. Empty state: "No tasks defined for this sprint". Button: "New task".
- **AC-TSK-02** Edit fields:
  - Name: required.
  - Product Backlog item: required select over `getByIds(sprint.sprintBacklog)`, blank option `-- choose --`.
  - Description: required.
  - Estimation and Remaining: numbers, required.
  - State: required select over `TASK_STATES`; a new task gets `TODO`.
  - Assigned to: optional select over `getByIds(project.teamMembers)` labelled `fullName`, blank option `-- unassigned --`; choosing it removes `assignedUserId` (S13).
  - The draft is per §5.6.
- **AC-TSK-03** Save/remove → `/projects/:projectId/sprints/:sprintId/tasks` (D6). Save error → `crud.task.save.error`; remove error → `crud.task.remove.error`; both notify-current (D14).
- **AC-E2E-FULL** `e2e/full-path.spec.ts`: admin login → create project with team → backlog item → sprint (add the item) → task → logout, against the Node stub.

### 12.5 dashboard + projectsinfo (cluster 5)
- **AC-DSH-01** `/dashboard` requires authentication (D4). "My projects" = `ProjectsTable` over **all** projects with the current user's roles (D2, D3). "My tasks" = **all** tasks (Name, Estimation, Remaining, empty Tools), with empty state "No tasks for you!".
- **AC-PIN-01** `/projectsinfo` is public. The loader fetches all projects, and the page renders only `Projects info` (D1).

### 12.6 Stub (Phase 2)
AC-STUB-01..15, §7.5.

---

## 13. Phase 2: harness deliverables and exit criteria
The orchestrator owns Phase 2. It ends with a PR into `migration`, reviewed by a fresh reviewer session against this section.

**Deliverables**
1. **Legacy move and secrets.**
   - `git mv client legacy/client`, `git mv server legacy/server`.
   - Remove `legacy/server/cert/privatekey.pem`.
   - Replace the MongoLab `apiKey` and the `cookieSecret` with placeholders (D18).
2. **Scaffold:** `web/` per §3, including `index.html`, `public/` assets, `styles/` (vendored LESS with asset paths rewritten, §11-6), and all tool configs. `main.tsx` stays minimal until cluster 0.
3. **Scripts:** `dev`, `dev:msw`, `build`, `build:pages`, `preview`, `lint`, `typecheck`, `test`, `e2e`, `verify` (= lint + typecheck + test + build + e2e).
4. **Stub:** complete per §7 with AC-STUB-01..15 green, both adapters, and the seed.
5. **Test infrastructure** (`web/src/test/`):
   - `setup.ts`;
   - `server.ts`, a shared MSW `setupServer` built from the stub handlers;
   - `stubControl.ts`: `resetStub()` before each test, plus `failNext(method, pathPattern, status)` for error injection.

   Per-test `server.use()` overrides are **allowed** for error injection. Mocking `api/` is not.
6. **CI** (`.github/workflows/ci.yml`): jobs `lint`, `typecheck`, `test`, `build`, `e2e` on PRs and pushes to `migration`, using Node 24 and pnpm. The owner then makes these required checks.
7. **Pages:** `.github/workflows/pages.yml` deploys `build:pages` from `migration`.
8. **Docs:** `MIGRATION.md` (all clusters `pending`); `spec/deviations.md` with its header; `spec/worklogs/` and `spec/questions/`; an interim README with a WIP banner, credits, the secrets note and demo credentials.
9. **Risk proofs** §11-1, -2, -3, -5 and -6 recorded in the journal. §11-4 is proven by cluster 0.

**Exit criteria:** CI is green on the Phase 2 PR; the Pages demo serves the shell placeholder at a deep link; `grep -r` finds no MongoLab key or private key outside git history; and the reviewer has signed off against this list.
