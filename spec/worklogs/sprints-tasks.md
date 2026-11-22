# Worklog: cluster 4 (sprints + tasks)

## 2026-11-21, session 1 (worker)

**Preconditions checked:** spec status line reads `APPROVED rev 3` (§0.2 P1–P4); `MIGRATION.md` wave B
gate is open (clusters 1, 2, 3 merged). Branch `convert/sprints-tasks` from `origin/migration` at
`6d9426c`.

### What was done
- `features/sprints/`: `routes.tsx` (R7–R9 via `crudRoutes()`), `SprintsList.tsx`, `SprintEdit.tsx`,
  `SprintBacklogPicker.tsx` (spec §5.2 names), `sprintBacklog.ts` (pure picker helpers).
- `features/tasks/`: `routes.tsx` (R10–R12 via `crudRoutes()`), `TasksList.tsx`, `TaskEdit.tsx`.
- Tests: `sprintBacklog.test.ts`, `SprintsList.test.tsx`, `SprintEdit.test.tsx`, `TasksList.test.tsx`,
  `TaskEdit.test.tsx`: 73 unit tests in the cluster.
- e2e: `e2e/sprints-tasks.spec.ts` (4 tests: sprint list + picker + save/remove; picker link; task
  create/edit/unassign/remove; P4 Enter on both forms) and `e2e/full-path.spec.ts` (AC-E2E-FULL).

### Decisions
- **Guards:** every loader awaits `requireAuthenticatedUser()` before any fetch (D2, §5.3). For each of
  the six routes there is an anonymous test (login modal with `login.reason.notAuthenticated`, no
  `/databases/` request) and an `outsider` test showing the screen opens: the spec requires only
  authentication here, so there is no signed-in user to refuse (Q-sprints-tasks-2). Mutation M37
  (fetch before the guard) is caught by the "fetches nothing" assertion.
- **D6 fixed:** task save and remove go to `/projects/:projectId/sprints/:sprintId/tasks`.
- **D12 preserved:** Status is the literal `ACTIVE`; dates are free-text `required` fields; capacity is
  stored (`numberFields`) and never used.
- **D13 fixed:** `estimationInTotal` counts an unknown backlog id as 0 and the row renders blank and
  removable; a loaded sprint without `sprintBacklog` gets `[]` in the form only (`sprintFormInitial`,
  §5.6); the task loader's `teamMembers` uses `project.teamMembers ?? []` (Legacy Cleanup) and the
  backlog lookup uses `sprint.sprintBacklog ?? []`.
- **D14 fixed:** save/remove errors notify-current `crud.sprint.*.error` / `crud.task.*.error`. Legacy
  had no success message for sprints or tasks and remove fell back to onSave, so both just return to
  the list (same as cluster 3's backlog form).
- **S13:** the task "Assigned to" select has `-- unassigned --`; choosing it sets `undefined`, which
  `useCrudForm` drops from the payload, so the PUT omits `assignedUserId`. "Product Backlog item" has
  `-- choose --`. State has no blank option: every route starts with a state (draft `TODO`, or the
  loaded one), as legacy's `ng-options` select did.
- **P1:** every form label has `htmlFor` and its control an `id` equal to the model field (`name`,
  `capacity`, `start`, `end`; `name`, `productBacklogItemId`, `desc`, `estimation`, `remaining`, `state`,
  `assignedUserId`). The legacy `name` quirks stay: three sprint inputs named `name`, capacity named
  `description`, the backlog select named `productBacklog`, both task selects named `state`. The two
  picker labels caption tables and have no control, so they stay plain (Q-sprints-tasks-1).
- **P4:** both forms have `onSubmit={e => e.preventDefault()}`; every button is `type="button"`
  (asserted for the whole sprint form, including picker buttons). Unit tests: Enter in Name sends no
  request and keeps the edits, and `form.requestSubmit()` reaches window with `defaultPrevented`.
- **Picker links** are anchors with an `onClick` and no `href`, as in legacy and as cluster 3's
  `ProjectsTable` does.
- **Picker helpers live in `features/sprints/sprintBacklog.ts`**, not `domain/`: they were controller
  scope functions in legacy (not resource prototype methods), and `domain/` belongs to cluster 0.
- Reused: `crudRoutes`, `useCrudForm`, `CrudButtons`, `useListNav`, `required`, `TASK_STATES`,
  `fullName`, `api/collections` (`sprints.forProject`, `tasks.forSprint`, `getByIds`). Nothing
  duplicated; no dependency added; nothing outside the owned paths edited.
- Known, unchanged legacy edge: a task whose backlog item was removed from the sprint (or whose
  assignee left the team) shows the blank option while the stored id is kept and saved; AngularJS
  showed an unknown `?` option and also kept the id.

### Legacy test table (spec §9)
Cluster 4 has **no legacy cases**: §9 assigns none, and inventory ("Untested") lists
`Sprints{List,Edit}Ctrl` (including the backlog picker and estimation total) and `Tasks{List,Edit}Ctrl`
as having no legacy tests. Every test here is new (spec §9: "New tests are required for every §12 AC").

| Legacy file | Case | Status (ported / adapted / dead / n/a) | New test | Note |
|---|---|---|---|---|
| — | — | — | — | no sprints/tasks spec exists in `legacy/client/test` (0 of 133) |

### AC coverage (named tests)
| AC | Tests (file) |
|---|---|
| AC-SPR-01 | `SprintsList.test.tsx` (guard, class parity/columns, ACTIVE, 4 cells → edit, Tasks, New sprint, empty state); e2e |
| AC-SPR-02 | `SprintEdit.test.tsx` (guards ×2 routes ×2 personas, draft, new, required, numberFields POST, edit load, unknown id); e2e |
| AC-SPR-03 | `SprintEdit.test.tsx` (tables, add, remove + revert, links both tables, all `type="button"`), `sprintBacklog.test.ts`; e2e |
| AC-SPR-04 / D13 | `SprintEdit.test.tsx` (blank row counted 0, removable + saved without it, `sprintFormInitial`), `sprintBacklog.test.ts` |
| AC-SPR-05 / D14 | `SprintEdit.test.tsx` (save PUT → list, remove → list, save/remove errors notify-current, cleared on next navigation) |
| AC-TSK-01 | `TasksList.test.tsx` (guard, columns/classes, rows + `sprintId` query, only Name opens edit, New task, empty state); e2e |
| AC-TSK-02 / S13 / D13 | `TaskEdit.test.tsx` (guards, draft, options and their `getByIds` queries, State order, team D13, required, edit load, unassign) |
| AC-TSK-03 / D6 / D14 | `TaskEdit.test.tsx` (POST/PUT/DELETE → task list, errors notify-current); e2e |
| AC-E2E-FULL | `e2e/full-path.spec.ts` |
| P4 | `SprintEdit.test.tsx`, `TaskEdit.test.tsx` (Enter, `requestSubmit`); `e2e/sprints-tasks.spec.ts` |

### Mutation testing (own work)
A scratch script (outside the repo) applied each mutation, ran `vitest run src/features/sprints
src/features/tasks`, and restored the file; `git status` was clean afterwards. **36/37 caught.**

| # | Mutation | Result |
|---|---|---|
| M01–M06 | drop the guard in each of the 6 loaders | each 1 failed (the anonymous "fetches nothing" test) |
| M07 | Status cell not `ACTIVE` (D12) | 1 failed |
| M08 | Status cell does not open edit | 1 failed |
| M09 | "Tasks" goes to the edit page | 1 failed |
| M10 | empty text "No sprints" | 1 failed |
| M11 / M12 | capacity / end date not required | 1 failed each |
| M13 | capacity not a `numberField` | 1 failed |
| M14 | D13: total reads `.estimation` of a missing item (throws) | 15 failed |
| M15 | "Add to sprint" does nothing | 2 failed |
| M16 | right table not filtered | 3 failed |
| M17 | picker link drops the item id | 1 failed |
| M18 | remove error uses the save key | 1 failed |
| M19 | sprint remove does not navigate | 1 failed |
| M20 | sprint errors notify-next instead of current | 4 failed |
| M21 | `sprintFormInitial` without `?? []` | 1 failed |
| M22 | sprint form without `preventDefault` (P4) | 1 failed |
| M23 | task save → `/admin/users` (legacy D6) | 4 failed; also e2e: 2 failed (`full-path`, task flow), rebuilt and reverted |
| M24 | task remove does not navigate | 1 failed |
| M25 | task remove error uses the save key | 1 failed |
| M26 | unassign saves `''` (S13) | 1 failed |
| M27 | backlog item not required | 1 failed |
| M28 | remaining not a `numberField` | 2 failed |
| **M29** | **State not `required`** | **survived (0 failed, 73 passed)** |
| M30 | draft without `state:'TODO'` | 4 failed |
| M31 | team loader without `?? []` (D13) | 1 failed |
| M32 | assignee labelled by e-mail, not `fullName` | 3 failed |
| M33 | task form without `preventDefault` (P4) | 1 failed |
| M34 | whole task row opens edit | 1 failed |
| M35 | empty text "No tasks" | 1 failed |
| M36 | backlog options from the whole project backlog | 1 failed |
| M37 | task edit fetches before the guard | 1 failed |

M29 is an equivalent mutant: the State select has no blank option and every route starts with a
valid state, so the UI cannot make it empty. `required` stays for parity with the legacy attribute.

### Mistakes and wrong turns
- Node setup: `source ~/.nvm/nvm.sh` was refused by the worktree sandbox; used Node 24's `bin` on `PATH`.
  A compound `prettier && git diff` command was refused too; ran them separately.
- First run of `SprintEdit.test.tsx`: 3 failures. `getByRole('button', {name: 'Remove'})` was ambiguous,
  because the picker rows have "Remove" buttons too. Fixed in the test with a `crudRemove()` helper
  scoped to the CRUD buttons; no source change.
- `full-path.spec.ts` first draft queried "Log in" and "Admin" as links; reading `LoginToolbar.tsx` and
  `Header.tsx` showed a button and a `role="button"` anchor. Fixed before the first run.
- The mutation script's summary regex printed the "Failed Tests N" count rather than the full Vitest
  summary line; the counts above are those failure counts plus the failing test names it printed.

### Gates run this session
Ports `STUB_PORT=3401 PREVIEW_PORT=4573 PAGES_PORT=4574`. `pnpm verify`, unpiped, exit 0:
```
All matched files use Prettier code style!
 Test Files  39 passed (39)
      Tests  362 passed (362)
✓ built in 334ms            (vite build)
✓ built in 363ms            (vite build --mode pages)
  30 passed (10.9s)         (playwright: 26 chromium + 4 pages; 5 of them are this cluster's)
```
`pnpm typecheck` passed (no output) inside the same run.

### Questions
- Q-sprints-tasks-1 (picker labels stay plain): implemented as recommended (a); not blocking.
- Q-sprints-tasks-2 (authentication-only guards, outsider allowed): implemented per spec (a); not blocking.

## 2026-11-21: review follow-up (P5, DEV-sprints-tasks-01/02, owner answers)

Pulled the reviewer's commits (`git pull --ff-only`); `migration` not merged. Owner rulings applied:
§0.2 P5 (stale select values start unset) and the DEV-sprints-tasks-02 hardening.

### Changes
- `features/tasks/TaskEdit.tsx`: new `taskFormInitial(task, sprintBacklogItems, teamMembers)`, used as the
  edit route's `initial`. It derives from the same lists the selects render (no effect, no extra fetch):
  a `productBacklogItemId` not in the sprint's items, an `assignedUserId` not on the team, and a `state`
  outside `TASK_STATES` are left out of `initial`. Commented with P5 / DEV-sprints-tasks-01.
- Sprint form: checked; it has no `<select>` (the picker is two tables of buttons; legacy
  `sprints-edit.tpl.html` has none either), so P5 does not apply there.
- `features/tasks/TaskEdit.test.tsx`: three tests, each changing the stub store after `resetStub()`
  through `stubContext.store` + `findById` (a test-local `patchStub` helper):
  - `AC-TSK-02 / P5: a task whose backlog item left the sprint must be re-chosen before Save`
    ("Product catalogue" removed from Sprint 1: select reads `-- choose --` and is `:invalid`, the
    form's required error since the legacy markup has no message; Save disabled after an edit; no PUT;
    choosing "Shopping cart" enables Save and the PUT carries it);
  - `AC-TSK-02 / P5: a task whose assignee left the team shows unassigned and saving unassigns`
    (dev1 removed from Webshop's team: reads `-- unassigned --`; after a Name edit the PUT body
    has no `assignedUserId`, the S13 convention);
  - `AC-TSK-02 / P5: a task with a malformed state must have a state chosen before Save`
    (`state: 'WAITING'`: Save disabled, no PUT, until IN_DEV is chosen).
- `e2e/full-path.spec.ts`: after saving the task, reopens it and asserts Name, "Product Backlog item"
  and "Assigned to" (`option:checked`).
- `spec/questions/sprints-tasks.md`: owner answers under Q-1 and Q-2; new **Q-sprints-tasks-3** (not
  blocking): the State select has no blank option, so a malformed state reads `TODO` while unset, and
  `TODO` cannot be re-chosen in a real browser without picking another state first. Recommended a
  `-- choose --` option shown only while unset; not implemented, since that is markup the spec doesn't cover.

### Mutation results (each reverted; `diff` against a saved copy confirmed the restore)
| # | Mutation | Result |
|---|---|---|
| M38 | backlog item kept even when not in the sprint | 1 failed (backlog-item P5 test) |
| M39 | assignee kept even when not on the team | 1 failed (assignee P5 test) |
| M40 | state kept even when not in `TASK_STATES` | 1 failed (malformed-state P5 test) |
| M41 | `initial = task` (P5 off entirely) | 3 failed (all three P5 tests) |
| M29 (re-run) | State not `required` | **1 failed** (malformed-state test). No longer an equivalent mutant: P5 can leave `state` unset, so the earlier worklog note on M29 is out of date |
| E2E-M | task save sends `assignedUserId: undefined` | `full-path.spec.ts` red: `Expected: "Developer Dana (dev1@ascrum.test)"`, `Received: "-- unassigned --"` (chromium project, after `pnpm build`) |

### Wrong turns
- None in the code. One process note: the first plan was to ask before touching the State select at
  all. P5's text covers any select, so the data rule went in, and only the display question
  (Q-sprints-tasks-3) was raised.

### Gates run this session
Ports `STUB_PORT=3401 PREVIEW_PORT=4573 PAGES_PORT=4574`. `pnpm verify`, unpiped (output redirected to a
file, not piped), exit 0:
```
All matched files use Prettier code style!
 Test Files  39 passed (39)
      Tests  365 passed (365)
✓ built in 338ms            (vite build)
✓ built in 371ms            (vite build --mode pages)
  30 passed (10.8s)         (playwright)
```
`pnpm typecheck` passed inside the same run.

## 2026-11-21: Q-sprints-tasks-3 answered (b): `-- choose --` on the State select while unset

### Changes
- Owner answer (b) and the AC-TSK-02 spec line came in through the orchestrator's first commit on
  `fix/task-state-choose`. Implemented as one conditional option in `TaskEdit.tsx`:
  `{values.state === undefined && <option value="">-- choose --</option>}` as the State select's first
  option. `values.state` can only be `undefined` through P5 (a stored state outside `TASK_STATES`), since the
  §5.6 draft is `TODO` and `fromSelect` maps the only blank value back to `undefined`. Once a state is
  chosen the option is gone, so the normal form is unchanged. Header comment and the inline comment on the
  State select updated (the old one said a malformed state "must be chosen again" with no blank option).
- Unit tests (`TaskEdit.test.tsx`):
  - `AC-TSK-02 / Q-sprints-tasks-3: an unset state shows -- choose -- first, and TODO can be chosen`:
    malformed stored state `WAITING` → options `['-- choose --', ...TASK_STATES]`, `-- choose --` selected,
    value `''`, Save disabled; choosing `TODO` enables Save and removes the option; Save PUTs `state: 'TODO'`.
  - `AC-TSK-02 / Q-sprints-tasks-3: a stored task with a state has no -- choose -- option in State` and
    `... the new-task form with a state ...`: options are exactly `TASK_STATES`.
- e2e (`sprints-tasks.spec.ts`): `AC-TSK-02 / P5 / Q-sprints-tasks-3: a malformed stored state shows
  -- choose --, and TODO can be picked`. The seed was cheap: after signing in as dev1, the test GETs
  "Design catalogue page" through the stub's own wire API and PUTs it back with `state: 'WAITING'` using
  the page's session (any session user may write `tasks`, §7.3). It then asserts the State select reads
  `''` / `-- choose --` with Save disabled, picks `TODO`, saves, and re-opens the task to see `TODO`. This is
  the real-browser case the question was about: without the option the browser already shows `TODO`.

### Mutation results (each reverted with `git checkout` or a saved copy; restore confirmed by a green re-run)
| # | Mutation | Result |
|---|---|---|
| M42 | delete the conditional `-- choose --` option | unit: **1 failed** (`an unset state shows -- choose -- first…`: `expected [ 'TODO', 'IN_DEV', 'BLOCKED', …(2) ] to deeply equal [ '-- choose --', 'TODO', …(4) ]`), 36 passed |
| M43 | render `-- choose --` always (drop the condition) | unit: **4 failed** (`State offers TASK_STATES in order`, the unset-state test, both "no -- choose --" tests), 33 passed |
| E2E-M42 | M42, then `pnpm e2e e2e/sprints-tasks.spec.ts --project chromium -g malformed` (rebuilds `dist/`) | **1 failed**: `expect(locator).toHaveValue(expected) failed`, `Expected: ""`, `Received: "TODO"`, the browser shows TODO for a form holding no state |

### Wrong turns
- The first e2e draft parsed the GET with `response.json()`, failing with `SyntaxError: Unexpected token ')'`:
  the stub keeps legacy's `)]}',` hijack prefix (AC-STUB-01). It now slices `JSON_PREFIX`.
- The second draft's PUT was refused (not ok): unsafe methods need the `x-xsrf-token` header matching the
  `XSRF-TOKEN` cookie (§7.2). It now reads that cookie from the browser context and sends the header.
  Both constants are imported from `stub/` rather than retyped.

### Gates run this session
Ports `STUB_PORT=3801 PREVIEW_PORT=4973 PAGES_PORT=4974`. First `pnpm verify` exit 1 (the e2e prefix bug
above: `1 failed`, `35 passed`). After the fixes, `pnpm verify`, unpiped (output redirected to a file), exit 0:
```
All matched files use Prettier code style!
 Test Files  41 passed (41)
      Tests  389 passed (389)
✓ built in 335ms            (vite build)
✓ built in 384ms            (vite build --mode pages)
  36 passed (12.5s)         (playwright)
```
`pnpm typecheck` passed inside the same run.
