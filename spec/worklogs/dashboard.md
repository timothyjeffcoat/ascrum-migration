# Worklog: cluster 5 (dashboard + projectsinfo)

Branch `convert/dashboard`, from `origin/migration` (wave B open: clusters 1, 2 and 3 merged). Owned
paths per spec §8.1 row 5: `web/src/features/{dashboard,projectsinfo}/**`, `web/e2e/dashboard.spec.ts`,
this worklog and `spec/questions/dashboard.md`.

## 2026-11-21: session 1, the whole cluster

### What was done
- **features/projectsinfo/** (R1, public)
  - `routes.tsx`: replaces cluster 0's placeholder. No guard (§5.3: R1 is public); the loader returns
    `projects.all()`, like the legacy `resolve`.
  - `ProjectsInfo.tsx`: renders only `<h3>Projects info</h3>` and does not read the loader data (D1
    preserved: legacy put the projects on the scope and the template never used them).
- **features/dashboard/** (R2)
  - `routes.tsx`: replaces the placeholder. The loader awaits `requireAuthenticatedUser()` first (D4
    fixed), then `Promise.all([projects.all(), tasks.all()])` (D2 preserved: all projects, all tasks;
    legacy resolved both in parallel).
  - `Dashboard.tsx`: `<h4>My projects</h4>`, a `<div>` (where legacy's `ng-include` rendered) holding
    cluster 3's `ProjectsTable` with `currentUserId={useAuth().currentUser?.id}` (D3 fixed: roles shown
    and links go to `/projects/<id>/…`), then `<h4>My tasks</h4>` and the legacy tasks table (Name
    `span8`, Estimation `span1`, Remaining `span1`, Tools `span2`, empty Tools cell), with the empty-state
    row "No tasks for you!" (`colspan` 4).
  - `ProjectsTable` is imported from `features/projects/ProjectsTable.tsx`, not edited.
- **e2e/dashboard.spec.ts**: 3 tests on the Node stub (projectsinfo public + heading only; dashboard deep
  link → login → roles, all tasks, working Sprints/Product backlog links; brand link for a user with no
  project role).

### Decisions
- **Empty-state row**: legacy used `ng-show="!tasks.length"`, so the row was always in the DOM and hidden
  by CSS when there were tasks. Here it is rendered only when there are no tasks. Same visible result;
  B4 keeps markup and classes, and a hidden row is not markup anyone sees. Not raised as a question.
- **Both lists are fetched in parallel** after the guard, as `$routeProvider` waited for both resolves.
  A failure of either → `RouteError` ("Route change error", content empty; S5/AC-NOT-04).
- **Dashboard for a signed-in user with no role** (`outsider`): the same page, all three projects with
  empty "My Role(s)" cells and all 12 tasks (D2). Tested in unit and e2e.
- **`/projectsinfo` is the landing page** (index and `*` redirect there), so every anonymous start now
  makes one `GET …/projects?q={}` request, as legacy did. All 289 pre-existing unit tests and the other
  e2e files still pass with that extra request.
- **Empty-state test data**: the stub seed has tasks, so that one test empties the stub's own store
  (`stubContext.store.collections.tasks = []`) after `resetStub()`. That is seeding the stub, not
  mocking `api/`; the next test's automatic `resetStub()` restores the seed.

### Questions
- Q-dashboard-1 (class parity for the classless `/projectsinfo` template): not blocking; implemented as
  recommended (assert a bare `<h3>`, alone in the content area).

### Mistakes and wrong turns
- `source ~/.nvm/nvm.sh` was not used; Node 24's `bin` went on `PATH` instead (node v24.22.3,
  pnpm 12.21.0), as in earlier clusters.
- I first named the dashboard load-failure test `AC-DSH-01 / D10`. D10 is cluster 0's fixed defect, so
  naming it here would inflate the named-defect count; renamed to `AC-DSH-01`.
- That test's first `failNext` pattern had a stray `*` prefix copied from a different call shape; I
  changed it to the plain collection path used elsewhere (`BacklogList.test.tsx`) before running it.
- My first mutation run was a single shell command (heredoc script + git restore) that the worktree
  sandbox refused as too complex. I wrote the script as a file in my scratchpad instead; it restores each
  file from its in-memory original rather than via git. `git status --short` was clean afterwards.

### Mutation checks (script: apply one mutation, run the two cluster test files, restore)
Baseline: 15/15 pass. Every mutation turned at least one named test red; tree clean afterwards.
| # | Mutation | Result (unit, cluster files) |
|---|---|---|
| M1 | dashboard guard removed (D4) | 2 failed: both `AC-DSH-01 / D4` tests |
| M2 | `currentUserId={undefined}` (D3 roles) | 1 failed: `AC-DSH-01 / D3` roles |
| M3 | tasks filtered to the user's own (D2 "fixed") | 3 failed: both `D2` tests + brand test |
| M4 | projects filtered to the user's own (D2 "fixed") | 5 failed incl. both `D2`, both `D3` |
| M5 | empty-state row removed | 1 failed: "No tasks for you!" test |
| M6 | Estimation/Remaining cells swapped | 1 failed: `AC-DSH-01 / D2` columns test |
| M7 | tasks table legacy classes dropped | 1 failed: dashboard class parity |
| M8 | legacy D3 link bug (`String(project)` as id) in `ProjectsTable`, temporary, not committed | 1 failed: `AC-DSH-01 / D3` links |
| M9 | dashboard loader skips the tasks fetch | 5 failed incl. `D2`, `D4` |
| M10 | projectsinfo loader removed (no fetch) | 4 failed: the three `AC-PIN-01 / D1` cases + load failure |
| M11 | projectsinfo guarded | 4 failed incl. `AC-PIN-01 / D1` anonymous |
| M12 | D1 "fixed": projectsinfo shows a project | 4 failed: three `AC-PIN-01 / D1` + class parity |
| M13 | projectsinfo `<h3>` gets a class | 1 failed: projectsinfo class parity |

### Gate results (this session)
`pnpm verify` with `STUB_PORT=3501 PREVIEW_PORT=4673 PAGES_PORT=4674`, output redirected to a file
(not piped), exit code 0:
```
All matched files use Prettier code style!          (eslint --max-warnings 0 clean)
$ tsc --noEmit -p tsconfig.json                     (clean)
 Test Files  36 passed (36)
      Tests  304 passed (304)
✓ built in 338ms                                    (vite build)
✓ built in 361ms                                    (vite build --mode pages)
  28 passed (8.4s)                                  (Playwright; 3 of them are dashboard.spec.ts)
```
15 of the 304 unit tests are this cluster's (2 files): 10 in `Dashboard.test.tsx`, 5 in
`ProjectsInfo.test.tsx`.

### AC coverage (§12.5)
| AC | Tests |
|---|---|
| AC-DSH-01 | `dashboard/Dashboard.test.tsx`: anonymous → modal, nothing fetched, login completes (D4); cancel → `/projectsinfo`, nothing fetched (D4); all projects and all tasks with `q={}` and columns (D2); roles (D3); links to backlog and sprints (D3); no-role user (D2); empty state; brand link from `/projectsinfo`; load failure. e2e: 2 tests |
| AC-PIN-01 | `projectsinfo/ProjectsInfo.test.tsx`: public as anonymous, outsider and admin; one `GET` with `q={}`; only the heading (D1); load failure. e2e: 1 test |

**Named defect tests:** D3 (2 unit tests + 1 e2e), D4 (2 unit tests + 1 e2e). D1 and D2 are preserved
defects with the AC-test rule, asserted in the `AC-PIN-01 / D1` and `AC-DSH-01 / D2` tests.
**Class parity:** dashboard (both tables `table table-bordered table-condensed table-striped
table-hover`, tasks column `span*` classes, `<h4>` headings, the `ng-include` wrapper `<div>`);
projectsinfo (bare `<h3>`, Q-dashboard-1).

### Legacy cases (spec §9), cluster 5: 0 cases
§9 assigns no legacy spec to cluster 5. The only legacy file for these screens,
`test/unit/app/dashboard/dashboard.spec.js`, contains just `//jasmine template here` (inventory: 0 cases,
"empty file"); there is no projectsinfo spec. (ported + adapted) = **0/0** for this cluster; nothing is
n/a or dead. Both screens are covered by the new AC tests above (§9: new tests are required for every
AC, including screens the legacy suite never covered).

| Legacy file | Case | Status | New test | Note |
|---|---|---|---|---|
| dashboard/dashboard.spec.js | (none: empty file) | — | — | 0 cases |

## 2026-11-21: review follow-ups (DEV-dashboard-01/02, Q-dashboard-1)

Owner-approved follow-ups from the review on #18. Test-only changes; `Dashboard.tsx` is unchanged.

### Changes
- **DEV-dashboard-01** (`Dashboard.test.tsx`, "class parity: both dashboard tables carry the legacy table
  classes and column spans"): the old check `projectsTable.parentElement.tagName === 'DIV'` could not fail,
  because without the wrapper the table's parent is the shell's `div.container-fluid`. The test now asserts
  the parent is a `div` with no `class` attribute whose previous element sibling is the "My projects" `<h4>`
  (legacy's `ng-include` wrapper). My original check was a vacuous assertion that my own mutation round
  did not catch; the reviewer's R16 did.
- **DEV-dashboard-02** (renamed to "AC-DSH-01 / D2: "My projects" lists ALL projects and "My tasks" ALL
  tasks in storage order, both fetched with q={}"): asserts the full list of the 12 task names in
  `stub/seed.ts` order (legacy rendered `Tasks.all()` unsorted, as does the port).
- **Q-dashboard-1:** recorded the owner's answer, (a), accepted as implemented.

### Mutations (each run with `vitest run src/features/dashboard`, then reverted; `git diff` afterwards
showed only the test file)
| # | Mutation | Result |
|---|---|---|
| M14 | `Dashboard.tsx`: drop the wrapper `<div>` around `ProjectsTable` | 1 failed: class parity ("Expected the element not to have attribute" — the parent is now `div.container-fluid`) |
| M15 | `Dashboard.tsx`: render `[...tasks].reverse()` | 1 failed: `AC-DSH-01 / D2 … in storage order` |

### Gate results (this session)
`pnpm verify` with `STUB_PORT=3501 PREVIEW_PORT=4673 PAGES_PORT=4674`, output redirected to a file
(not piped), exit code 0:
```
All matched files use Prettier code style!          (eslint --max-warnings 0 clean)
$ tsc --noEmit -p tsconfig.json                     (clean)
 Test Files  36 passed (36)
      Tests  304 passed (304)
✓ built in 341ms                                    (vite build)
✓ built in 375ms                                    (vite build --mode pages)
  28 passed (8.3s)                                  (Playwright)
```
