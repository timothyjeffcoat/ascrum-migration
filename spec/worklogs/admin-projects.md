# Worklog: cluster 2 (admin-projects)

Branch `convert/admin-projects`, from `origin/migration` at `def95fd`. Owned paths per spec §8.1 row 2:
`web/src/features/admin-projects/**`, `web/e2e/admin-projects.spec.ts`, plus this worklog and
`spec/questions/admin-projects.md`.

## 2026-11-21 (local; 2026-11-22 UTC): session 1, the whole cluster

### What was done
Mapping (spec §5.2) → files, all in `web/src/features/admin-projects/`:
| Legacy unit | React unit |
|---|---|
| admin-projects routes (`crudRouteProvider.routesFor('Projects','admin')`) | `routes.tsx`: `crudRoutes('/admin/projects')`, loaders await `requireAdminUser()` first |
| `ProjectsListCtrl` + `projects-list.tpl.html` | `ProjectsAdminList.tsx` (uses `useListNav`) |
| `ProjectsEditCtrl` + `projects-edit.tpl.html` | `ProjectEdit.tsx` (uses `useCrudForm` + `CrudButtons`), with `newProjectDraft()` (§5.6) and `projectFormInitial()` (D13) |
| `TeamMembersController` (template's right column) | `TeamMembers.tsx` (selects + team table) and `teamMembers.ts` (pure `addTeamMember`, `removeTeamMember`, `usersLookup`, `ProjectExtra`) |

- Loaders: list → `projects.all()`; new → `users.all()` + the §5.6 draft; edit → `projects.getById` and
  `users.all()` in parallel, then `teamMembers ?? []` in the form's `initial` only (§5.6 / D13).
- Candidate lists come only from `domain/projects.ts` (`productOwnerCandidates`, `scrumMasterCandidates`,
  `teamMemberCandidates`, AC-DOM-05), recomputed each render from the form values (AC-APR-05), and
  labelled with `domain/users.ts` `fullName`.
- `useCrudForm<Project, ProjectExtra>` with `extra: {selTeamMember: undefined}`; validators `required`
  on name, productOwner, scrumMaster. `onSave` → notify-next `crud.project.save.success {id}` →
  `/admin/projects`; `onRemove` → notify-next `crud.project.remove.success {id}` → list (D21/S4);
  `onError('save')` → notify-current `crud.project.save.error`; `onError('remove')` → notify-current
  `crud.project.remove.error {id}` (S12).
- Tests: `teamMembers.test.ts` (6), `ProjectsAdminList.test.tsx` (4), `ProjectEdit.test.tsx` (11);
  `web/e2e/admin-projects.spec.ts` (2 tests: guarded list → edit; create with team → edit → remove).

### AC and defect coverage
| Id | Test(s) |
|---|---|
| AC-APR-01 | `ProjectsAdminList.test.tsx`: 4 tests named `AC-APR-01…` (table + classes, row → edit / New Project, non-admin modal and no fetch, anonymous → login → list); e2e `AC-APR-01: …` |
| AC-APR-02 | `ProjectEdit.test.tsx` `AC-APR-02: name is required, description optional; …` |
| AC-APR-03 | `ProjectEdit.test.tsx` `AC-APR-03 / legacy :37 / legacy :115: …` (options = domain candidates, `fullName` labels, `-- choose --`) |
| AC-APR-04 | `ProjectEdit.test.tsx` `AC-APR-04: dev-team rows …`, `AC-APR-04: the team selection is a form-only field …`; `teamMembers.test.ts` `legacy :144 / AC-APR-04 …`, `AC-APR-04: removing the member that is currently selected …` |
| AC-APR-05 | `ProjectEdit.test.tsx` `AC-APR-05: the candidate lists recompute …` |
| AC-APR-06 | `ProjectEdit.test.tsx`: save new (POST), save existing (PUT), save error, remove (D21), remove error |
| D13 | `ProjectEdit.test.tsx` `D13 / legacy :104: a project without teamMembers …` (seed "Legacy Cleanup") |
| D21 | `ProjectEdit.test.tsx` `AC-APR-06 / D21: removing a project … says "removed" (not "saved")`; e2e `AC-APR-02..06 / D21` |

Class parity: list table `table table-bordered table-condensed table-striped table-hover` + `well`;
edit `well > form > legend`, two `row-fluid > span6` columns, dev-team table classes, `span12` selects,
`btn btn-small` row buttons, CrudButtons `btn btn-danger remove`.

### Legacy cases (spec §9: admin/projects/admin-projects.spec, 11 cases; no pre-assigned statuses)
| Legacy file | Case | Status | New test | Note |
|---|---|---|---|---|
| admin-projects.spec.js:6 | ProjectsListCtrl should call crudListMethods | adapted | `ProjectsAdminList.test.tsx` `AC-APR-01 / legacy :6: …` and `AC-APR-01: a row click …` | no controller/spy; asserts the rendered projects and the useListNav navigation |
| admin-projects.spec.js:37 | ProjectsEditCtrl sets up scope objects correctly | adapted | `ProjectEdit.test.tsx` `AC-APR-03 / legacy :37 / legacy :115: …` | the loaded project and users are what the form shows |
| admin-projects.spec.js:45 | onSave calls $location and a success message | adapted | `ProjectEdit.test.tsx` `AC-APR-06 / legacy :45: …` | asserts the rendered next-route `alert-success` and the URL instead of spies |
| admin-projects.spec.js:57 | onError displays an error message | adapted | `ProjectEdit.test.tsx` `AC-APR-06 / legacy :57: …` | real failed PUT via `failNext`; asserts `alert-error` text |
| admin-projects.spec.js:96 | TeamMembersController attaches a users lookup | ported | `teamMembers.test.ts` `legacy :96: …` | object → `Map` |
| admin-projects.spec.js:104 | attaches an empty team members array | adapted | `ProjectEdit.test.tsx` `D13 / legacy :104: …` | `[]` set in the form's `initial` (§5.6), never on the API object |
| admin-projects.spec.js:115 | calls filter when getting candidates | adapted | `ProjectEdit.test.tsx` `AC-APR-03 / legacy :37 / legacy :115: …` | asserts the options equal the domain candidate functions' output instead of spying on `filter` |
| admin-projects.spec.js:133 | addTeamMember: no push if nothing selected | ported | `teamMembers.test.ts` `legacy :133: …` | |
| admin-projects.spec.js:144 | addTeamMember pushes the selected item and clears it | ported | `teamMembers.test.ts` `legacy :144 / AC-APR-04: …` | |
| admin-projects.spec.js:163 | removeTeamMember removes a member in the array | ported | `teamMembers.test.ts` `legacy :163: …` | |
| admin-projects.spec.js:175 | removeTeamMember leaves the array if not a member | ported | `teamMembers.test.ts` `legacy :175: …` | |

Counts: 5 ported, 6 adapted, 0 n/a, 0 dead → **11/11 carried over**.

### Decisions (spec silent or needing interpretation)
- **Labels got `for`/`id`** (`project-name`, `project-desc`, `project-productOwner`,
  `project-scrumMaster`), following the owner's answer to Q-foundation-1. The add-row select and the
  "Development Team" label stay as in legacy (no `for`; the select is found inside its table).
- **Guard before fetch.** Legacy resolved the guard alongside `Projects.all()`/`Users.all()`; CLAUDE.md
  says await guards at the top of loaders, so a non-admin triggers no data request (tested).
- **Unknown team member id** renders an empty name cell with a working `Remove`, as legacy's
  `usersLookup[userId].getFullName()` evaluated to nothing. No seed data exercises it.
- **Edit route keyed by document id** (`key={initial.id ?? 'new'}`), since `useCrudForm` takes
  `initial` once.
- Every button in the form is `type="button"` (legacy's team-table buttons had no type).
- Q-admin-projects-1 (stale team selection after choosing that user as PO: parity kept) and
  Q-admin-projects-2 (`crud-buttons class="span12"` nesting): both non-blocking, implemented as
  recommended. Nothing is blocked.

### Mistakes and wrong turns
- Ran `pnpm typecheck` once **before** writing the tests, then not again until `pnpm verify`. The first
  `pnpm verify` failed at typecheck: `row.cells` on an `HTMLElement` (2 test files). Fixed by querying
  cells through Testing Library / `querySelector`; second `pnpm verify` green.
- The "not authorized" reason has a double space in the legacy string; `getByText` with the default
  normalizer collapses it, so my first exact-string match failed. Switched to a regex.
- e2e: Playwright `getByText('Webshop')` is a substring match and also hit "Companion app for the
  webshop" (strict-mode violation); same for "Intranet". Used `{ exact: true }`. Then my team-row
  locator included the trailing add row (its cell holds the select's option text); excluded it with
  `tr:not(:last-child)`. All test-side mistakes; no production code changed for them.
- Left a pointless `findByRole('group', …).catch(…)` in a test helper from a first draft; removed it
  before the first run.

### Gate results (this session; ports STUB_PORT=3201 PREVIEW_PORT=4373 PAGES_PORT=4374)
- `pnpm verify` run 1: **failed** at typecheck (above).
- `pnpm verify` run 2: **exit 0**.
  - lint: `All matched files use Prettier code style!` (eslint `--max-warnings 0` clean)
  - typecheck: clean
  - unit: `Test Files  27 passed (27)`, `Tests  215 passed (215)`
  - build: `✓ built in 363ms` (app), `✓ built in 399ms` (Pages)
  - e2e: `20 passed (6.4s)`

### Notes for other clusters
- Cluster 3/4/5: the not-authorized login reason contains a double space; match it with a regex or
  `getDefaultNormalizer({collapseWhitespace: false})`.
- A notification's text in the DOM starts with the close button's `x` (`x` + message); in Playwright
  match with `toContainText` or a regex.
