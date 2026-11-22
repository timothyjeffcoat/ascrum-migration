# Worklog: cluster 1 (admin-users)

Branch `convert/admin-users`, from `origin/migration` at `def95fd`. Owned paths per spec §8.1 row 1:
`web/src/features/admin-users/**`, `web/src/components/**`, `web/e2e/admin-users.spec.ts`, plus this
worklog and `spec/questions/admin-users.md`.

## 2026-11-21: session 1, the whole cluster

### What was done
- **`components/md5.ts`**: port of the md5 factory from `gravatar.js`, module-scoped (D17: legacy
  leaked `txt` and `add32` as globals). The old-IE `add32` fallback is not ported.
- **`components/Gravatar.tsx`**: `<Gravatar email size? defaultImage? forceDefault? className?>` plus
  `gravatarUrl()`. https (D17), params `s`, `f`, `d` only when set, in the legacy watcher order.
- **`features/admin-users/uniqueEmail.ts`**: `AsyncValidator`; `users.query({email})`, a conflict
  only if a match's id ≠ `ctx.originalId` (D9). Empty value → no request.
- **`features/admin-users/UsersList.tsx`** (R16): loader = `requireAdminUser()` + `users.all()`;
  legacy table markup verbatim; row click → edit, `New User` → new (`useListNav`); `Remove` stops
  propagation, deletes, drops the row, and notifies current-route success/error (AC-USR-03).
- **`features/admin-users/UserEdit.tsx`** (R17/R18): `useCrudForm<User, {password, passwordRepeat}>`
  from the §5.6 draft; validators `required`/`email`/`equalsField` from `crud/validators.ts`, plus a
  conditional password-required rule (required on create; on edit only if either is filled);
  `toPayload` drops a blank password (AC-USR-06); notifications and navigation per AC-USR-07.
  `UserEditRoute` keys the form by user id.
- **`routes.tsx`**: `crudRoutes('/admin/users', …)` with the three loaders (placeholder replaced).
- Tests: `components/Gravatar.test.tsx` (11), `uniqueEmail.test.ts` (5), `UsersList.test.tsx` (7),
  `UserEdit.test.tsx` (20). E2E: `e2e/admin-users.spec.ts` (3 tests).

### AC and defect coverage
| Id | Test(s) |
|---|---|
| AC-USR-01 | `UsersList.test.tsx`: anonymous → modal "not authenticated"; dev1 → "not authorized"; columns, gravatar `?s=50&d=monsterid`, Remove, classes. E2E test 1 |
| AC-USR-02 | `UsersList.test.tsx` "a row click opens /admin/users/:id; New User…". E2E tests 1 and 2 |
| AC-USR-03 | `UsersList.test.tsx`: success (no row navigation, row gone, current-route notice, one DELETE) and failure (row kept, error notice). E2E test 2 |
| AC-USR-04 | `UserEdit.test.tsx`: markup/classes, required on create, invalid/taken e-mail, password match under both fields, edit-time password rule, names required + Admin checkbox |
| AC-USR-05 | `uniqueEmail.test.ts` (query sent, found/not found, empty skips, own id) and `UserEdit.test.tsx` (pending disables Save, empty not checked) |
| AC-USR-06 | `UserEdit.test.tsx`: blank passwords → no `password` in the PUT; new password → sent, repeat never |
| AC-USR-07 | `UserEdit.test.tsx`: create → notify-next + list; save error; remove from edit → notify-next + list; remove error (S12); revert |
| AC-GRAV-01 | `Gravatar.test.tsx` "AC-GRAV-01 / D17: https URL…", classes, empty e-mail |
| D8 | `UserEdit.test.tsx` "admin-users-edit.spec:26 → D8: the password fields always start empty on edit", "D8: … on create" |
| D9 | `uniqueEmail.test.ts` "D9 / AC-USR-05…", `UserEdit.test.tsx` "D9: editing a user, their own e-mail is not reported as taken…" and "D9: a stale uniqueness response … is discarded". E2E test 3 |
| D17 | `Gravatar.test.tsx`: https URLs; md5 digests (incl. 55/56/64-byte boundaries, checked against Node's crypto); "md5 is module-scoped and leaks no globals" |
| class parity | list: `table table-bordered table-condensed table-striped table-hover`, `well`, `btn btn-danger remove`; edit: `well`, `span6`, `img-polaroid pull-right` |

**Mutation checks** (by hand, files restored, not committed): removing `stopPropagation()` fails both
AC-USR-03 tests; comparing ids to `undefined` instead of `ctx.originalId` in `uniqueEmail` fails both
D9 tests that name the own-e-mail case; always copying `extra.password` into the payload fails the
AC-USR-06 blank-password test. The stale-response discard itself is cluster 0's code (`useCrudForm`),
so the D9 stale test exercises it rather than this cluster's code.

### Legacy test table (spec §9: admin/users + gravatar; validateEquals is cluster 0's and was ported there)
| Legacy file | Case | Status | New test | Note |
|---|---|---|---|---|
| admin-users-edit.spec:26 | should extract the password from the user object | n/a | `UserEdit.test.tsx` "admin-users-edit.spec:26 → D8: …" | pre-assigned n/a: contradicts D8; replaced by the D8 test |
| admin-users-edit.spec:33 | should call $location & i18nNotifications when onSave() is called | adapted | `UserEdit.test.tsx` "admin-users-edit.spec:33 / AC-USR-07: …" | spies → the real notification and the router location |
| admin-users-edit.spec:43 | should set updateError in onError | adapted | `UserEdit.test.tsx` "admin-users-edit.spec:43 / AC-USR-07: …" | a failed PUT (failNext) → current-route error notice |
| admin-users-list.spec:10 | should set up the scope correctly | adapted | `UsersList.test.tsx` "admin-users-list.spec:10: …" | scope + spy → the loaded users render and the list nav works |
| uniqueEmail.spec:29 | should be valid initially | ported | `UserEdit.test.tsx` "uniqueEmail.spec:29: …" | |
| uniqueEmail.spec:32 | should not call Users.query when the model changes | ported | `UserEdit.test.tsx` "uniqueEmail.spec:32: …" | loading a user = model change; no `q={email}` request recorded |
| uniqueEmail.spec:36 | should call Users.query when the view changes | ported | `uniqueEmail.test.ts` "uniqueEmail.spec:36 / AC-USR-05: …" | recorded request instead of a spy; also in `UserEdit.test.tsx` (typing) |
| uniqueEmail.spec:40 | should set model to invalid if the Users callback contains users | ported | `uniqueEmail.test.ts` "uniqueEmail.spec:40 / AC-USR-05: …" | stub data instead of a fake callback |
| uniqueEmail.spec:47 | should set model to valid if the Users callback contains no users | ported | `uniqueEmail.test.ts` "uniqueEmail.spec:47 / AC-USR-05: …" | |
| gravatar.spec:9 | should create an img tag with a valid gravatar url | adapted | `Gravatar.test.tsx` "gravatar.spec:9 / D17: …" | expected URL is https (D17) |
| gravatar.spec:13 | should append an s GET parameter if size is set | adapted | `Gravatar.test.tsx` "gravatar.spec:13: …" | https |
| gravatar.spec:18 | should append a d GET parameter if default is set | adapted | `Gravatar.test.tsx` "gravatar.spec:18: …" | https |
| gravatar.spec:23 | should append a f=y GET parameter if force-default is set to true | adapted | `Gravatar.test.tsx` "gravatar.spec:23: …" | https |
| gravatar.spec:28 | should work with combinations of options | adapted | `Gravatar.test.tsx` "gravatar.spec:28: …" | https prefix in the first `toContain` |

Counts for this cluster's 14 cases: **ported 5, adapted 8, n/a 1, dead 0** (13/14 carried over).
The 4 validateEquals cases of the same §9 row are cluster 0's (`crud/validators.test.ts`, all ported).

### Decisions (spec silent or needing interpretation)
- **Removed rows are tracked as ids**, not as a copy of the loaded list, so a revalidated loader
  result is still shown minus what was removed (legacy spliced its local array).
- **The edit form is keyed by user id** (`UserEditRoute`), per the note in `useCrudForm.ts`.
- **uniqueEmail queries for any non-empty value**, including a syntactically invalid one, as AC-USR-05
  says ("an empty value skips the check"). Legacy did not query an invalid address, because the email
  parser ran first and passed `undefined` on. The result is harmless: the `email` error shows anyway.
- **Password inputs keep the plain `required` attribute** of the legacy template. The form is
  `noValidate`, so the attribute is markup only; the real rule is the conditional validator.
- **Gravatar `<img>` has no `alt`**, as in legacy (B4).
- The list buttons (`Remove`, `New User`) have no `type`, as in legacy: they are not inside a form.
  Every button inside the edit form is `type="button"` (CrudButtons).

### Blocked / questions
- **Q-admin-users-1** (blocking one behaviour): on edit, a password-only change cannot be saved,
  because `extra` is never dirty. **Blocked: "save a password-only change on edit".** Implemented
  the spec as written; recommendation (b) in the questions file.
- **Q-admin-users-2** (non-blocking): Gravatar after the e-mail is cleared. Implemented stateless.

### Mistakes and wrong turns
- First UsersList run: the "not authorized" test failed because Testing Library collapses the legacy
  message's double space. Fixed with the same non-collapsing normalizer cluster 0 uses.
- First UserEdit run: `getByText('Admin')` matched the header's Admin dropdown too. Scoped the
  queries to the form.
- An early draft of the md5 multi-block test compared `md5(x)` to itself (a no-op assertion). Caught
  before committing; replaced with digests computed by Node's `crypto`.
- First `pnpm verify`: 2 of my 3 e2e tests failed. (1) After an edit-save and a list remove, two
  `.alert-success` notices are present (the save notice is current-route on the list), so a strict
  locator matched 2. (2) `getByText('Outsider')` also matched `outsider@ascrum.test`
  (case-insensitive substring). Fixed both; unit tests had not caught either, since they are
  e2e-locator issues.
- Setup: `source ~/.nvm/nvm.sh` was refused by the worktree sandbox, so Node 24 was put first on
  PATH instead (as the brief allows).

### Gates run this session (ports STUB 3101, PREVIEW 4273, PAGES 4274)
- `pnpm verify` #1: exit 1. Lint, typecheck, unit (27 files / 224 tests) and build green; e2e
  `2 failed, 19 passed` (the two locator issues above).
- `pnpm exec playwright test e2e/admin-users.spec.ts`: `3 passed`.
- `pnpm verify` #2: **exit 0**. Summary lines:
  ```
  All matched files use Prettier code style!
   Test Files  27 passed (27)
        Tests  224 passed (224)
  ✓ built in 326ms
  ✓ built in 370ms
    21 passed (5.4s)
  ```
