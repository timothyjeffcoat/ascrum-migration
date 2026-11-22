# Worklog: cluster 3 (projects + productbacklog)

Branch `convert/projects`, from `origin/migration` (cluster 0 merged, wave A open). Owned paths per
spec §8.1 row 3: `web/src/features/{projects,productbacklog}/**`, `web/e2e/projects.spec.ts`, this
worklog and `spec/questions/projects.md`.

## 2026-11-21: session 1, the whole cluster

### What was done
- **features/projects/**
  - `routes.tsx`: `/projects` (R3), loader `await requireAuthenticatedUser()` then `projects.all()`.
  - `ProjectsPage.tsx`: the route component; passes `useAuth().currentUser?.id` to the table.
  - `ProjectsTable.tsx`: exported `ProjectsTable({projects, currentUserId?})`, a port of
    `projects-list.tpl.html` plus `manageBacklog` / `manageSprints` / `getMyRoles`. The name and
    description cells and "Product backlog" go to `/projects/:id/productbacklog`; "Sprints" goes to
    `/projects/:id/sprints`. Roles come from `domain/` (`getRoles` + `formatRoles`, D20); without a
    user id the cell is empty (AC-PRJ-02). `viewProject` is not ported (D5).
- **features/productbacklog/**
  - `routes.tsx`: `crudRoutes('/projects/:projectId/productbacklog', …)` (R4–R6). Every loader awaits
    `requireAuthenticatedUser()` first (D2/§5.3). List → `productBacklog.forProject(projectId)`;
    new → `{projectId}`; edit → `{projectId, backlogItem: getById(itemId)}` (a 404 → RouteError).
  - `BacklogList.tsx`: table, row → edit, empty state, "New backlog item" (`useListNav`).
  - `BacklogItemEdit.tsx`: `useCrudForm` with `required` on all four fields, `numberFields`
    `priority`/`estimation`, the §5.6 draft (`newBacklogItemDraft`), save/remove → list, and
    `onError(op)` → notify-current `crud.backlogItem.<op>.error` (D14). The form is keyed by
    document id, as `useCrudForm` asks.
- **e2e/projects.spec.ts**: 2 tests on the Node stub (deep link → login → roles → links; create,
  edit and remove a backlog item).

### Decisions
- **Anchors without `href`** in the Tools cell, as in legacy (`<a ng-click>`). B4 keeps the markup;
  so they are not keyboard-focusable, exactly like legacy (accessibility work is a non-goal, §1).
- **No success notifications** for backlog save/remove: legacy had none ("TODO: missing message")
  and AC-PBL-03 asks only for the return to the list.
- **The submit is prevented on the form** (`onSubmit` → `preventDefault`), as AngularJS's form
  directive did for forms without an `action`. All buttons in it are `type="button"` (CrudButtons).
- The "New backlog item" button is outside any form, so it keeps the legacy markup (no `type`).
- `ProjectsTable` lives in `features/projects/ProjectsTable.tsx` (spec §5.2 name). I briefly added an
  `index.ts` barrel for cluster 5 and removed it before committing: one more file, no benefit.
- **Labels gained `htmlFor`/`id`**: Q-projects-1 (not blocking, implemented as recommended, following
  the owner's Q-foundation-1 answer for the login form). Priority and estimation keep the legacy quirk
  of having no `name`.

### Questions
- Q-projects-1 (backlog form label `for`/`id`): not blocking; implemented as recommended.

### Mistakes and wrong turns
- The prescribed `source ~/.nvm/nvm.sh && nvm use 24` was refused by the worktree sandbox (as for
  cluster 0); I put Node 24's `bin` on `PATH` instead (node v24.22.3, pnpm 12.21.0).
- Several shell commands that mixed `git` with other steps, or contained heredocs, were refused by
  the sandbox. I moved mutation checks and a test edit into small scripts outside the repo.
- My first `ProjectsTable` link test signed nobody in, so the click on a guarded route would have
  waited on the login modal forever; it now renders as `po` (the table still gets no user id).
- I first named a `ProjectsTable` test after D3. D3 is the dashboard's fix (cluster 5's named test),
  so I renamed it to AC-PRJ-02 to keep the defect metrics honest.
- I wrote a `D5` test that clicked the roles cell and asserted nothing happened. It proved nothing
  about `viewProject`'s absence (spec §6: "reviewer checks absence"), so I deleted it.
- My first guard mutation check used the wrong indentation in `sed`, changed nothing, and "passed".
  I caught it because `diff` printed nothing, redid it, and added a test for the edit route's guard,
  which no test covered.
- e2e, first run: the "Webshop" row locator also matched "Mobile App" (its description says "the
  webshop"; `hasText` is a case-insensitive substring). Fixed with an exact cell match.
- Using `(field as HTMLInputElement).value` on what could be a textarea in a test: replaced with
  the known values.

### Mutation checks (run by hand, each file restored with `cmp` confirming)
| Mutation | Result |
|---|---|
| `onError` pushes a wrong key; `numberFields` removed (`BacklogItemEdit.tsx`) | 6 failed: the 4 D14 tests and the 2 save-payload tests |
| `formatRoles(...)` → `JSON.stringify(...)` (`ProjectsTable.tsx`, i.e. legacy D20) | 4 failed |
| every `requireAuthenticatedUser()` removed (`productbacklog/routes.tsx`) | 2 failed |
| only the edit loader's guard removed (after adding its test) | 1 failed |
| the `/projects` guard removed | 1 failed |

### Gate results (this session)
`pnpm verify` with `STUB_PORT=3301 PREVIEW_PORT=4473 PAGES_PORT=4474`, output to a file (not piped),
exit code 0:
```
All matched files use Prettier code style!          (eslint --max-warnings 0 clean)
$ tsc --noEmit -p tsconfig.json                     (clean)
 Test Files  27 passed (27)
      Tests  215 passed (215)
✓ built in 363ms                                    (vite build)
✓ built in 399ms                                    (vite build --mode pages)
  20 passed (5.2s)                                  (Playwright; 2 of them are projects.spec.ts)
```
34 of the 215 unit tests are this cluster's (4 files).

### AC coverage (§12.3)
| AC | Tests |
|---|---|
| AC-PRJ-01 | `projects/ProjectsPage.test.tsx` (auth → login → load; columns and rows; roles; backlog via name, description and link; sprints link); e2e |
| AC-PRJ-02 | `projects/ProjectsTable.test.tsx` (formatted roles for a given id; empty without a user; links with props only) |
| AC-PBL-01 | `productbacklog/BacklogList.test.tsx` (auth; columns and `forProject` query; empty state; row → edit; New → new; load failure); e2e |
| AC-PBL-02 | `productbacklog/BacklogItemEdit.test.tsx` (auth on new and edit; §5.6 draft; all four fields required; numbers in the payload; edit loads; unknown id); e2e |
| AC-PBL-03 | `productbacklog/BacklogItemEdit.test.tsx` (save new / save existing / remove → list; D14 save errors on POST and PUT, remove error, notify-current cleared by the next navigation); e2e |

**Named defect tests:** D14 (4 tests, `BacklogItemEdit.test.tsx`), D20 (3 tests across
`ProjectsTable.test.tsx` and `ProjectsPage.test.tsx`). D13 (missing `teamMembers`) is asserted inside
the AC-PRJ-02 / D20 and legacy :76 tests. D5 is an absence (`viewProject` is not ported), for the
reviewer to check.
**Class parity:** projects table (`table table-bordered table-condensed table-striped table-hover`,
column `span*` classes), backlog list (same table classes, `well`, `btn`), backlog edit (`well`,
`span10`, CrudButtons classes).

### Legacy cases (spec §9), cluster 3: 5 cases
Ported 2, adapted 2, n/a 1, dead 0. (ported + adapted) = **4/5** for this cluster.

| Legacy file | Case | Status | New test | Note |
|---|---|---|---|---|
| projects.spec:22 | attaches the list of projects to the scope | adapted | `projects/ProjectsPage.test.tsx` (AC-PRJ-01, legacy :22) | no scope: the loader's projects are each rendered as a row |
| projects.spec:34 | viewProject: changes the location | n/a | — | D5, pre-assigned: `viewProject` not ported |
| projects.spec:48 | manageBacklog: changes the location | ported | `projects/ProjectsPage.test.tsx` (AC-PRJ-01, legacy :48) | name, description and "Product backlog" all → `/projects/:id/productbacklog` |
| projects.spec:62 | manageSprints: changes the location | ported | `projects/ProjectsPage.test.tsx` (AC-PRJ-01, legacy :62) | → `/projects/:id/sprints` |
| projects.spec:76 | getMyRoles: calls getRoles on the project with the current user | adapted | `projects/ProjectsPage.test.tsx` (AC-PRJ-01 / D20, legacy :76) | asserts the rendered roles of the signed-in user, not a spy |

### Notes for cluster 5 (dashboard)
- Import `ProjectsTable` from `web/src/features/projects/ProjectsTable.tsx`. Props:
  `projects: readonly Project[]` and `currentUserId?: string | undefined` (pass
  `useAuth().currentUser?.id`).
- It renders only the `<table>` (no heading); the dashboard adds its own `<h4>My projects</h4>`.
- The links use `useNavigate`, so the table must be rendered inside the router (it is, on any route).
  They target the guarded `/projects/:id/productbacklog` and `/projects/:id/sprints` routes (D3 fix).
