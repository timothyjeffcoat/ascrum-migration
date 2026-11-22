# Worklog: fix/trim-text (spec §0.2 P6, audit DSC-B-1)

Branch `fix/trim-text`, from `migration` with the orchestrator's spec commit d4ef8be (P6 and
DEV-audit-05..07). Allowed paths for this fix: `web/src/crud/**`, `web/src/auth/**`,
`web/src/features/**`, `web/e2e/**` and this worklog.

## 2026-11-22: session 1

### Legacy behaviour checked first
- `vendor/angular/angular.js` `textInputType`: the input listener trims the DOM value and calls
  `$setViewValue` only if it differs from the current `$viewValue`. So typing a trailing space neither
  re-parses, re-validates nor changes the model.
- The model → view `$watch` re-renders the input only when the model value changes
  (`ctrl.$modelValue !== value`). The input therefore keeps showing what was typed, spaces included.
- `crudEdit` (`directives/crud/edit.js`): `canSave`/`canRevert` = `!angular.equals(resource, original)`,
  so dirty compares trimmed model values. A trailing space is not a change.
- `revertChanges` assigns a fresh copy of `original`. A field whose trimmed text already equals the
  original keeps its typed spaces (its model value did not change, so the watch does not fire). Any other
  field shows the original value.
- `validate-equals` (user form) runs as a parser on the trimmed value, so `"pw "` and `"pw"` match.
- The login form (`user.email`, `user.password`) is trimmed as well; `password` is a text-like type.

### Design
`useCrudForm` mirrors AngularJS's view/model split. `values`/`extra` hold the trimmed text, so
`required`, dirty and the payload all see it. A small `typed` map remembers the untrimmed text, and the
new `viewValue(name)` returns it for the input to show. `viewValue` returns the typed text while it
still trims to the held value; otherwise (first render, a revert to another value) it returns the held
value. That is the same rule as AngularJS's model watch.
- Trimming happens in `setField`/`setExtra` for string values. `numberFields` are parsed as before
  (`parseNumber` already ignores blanks). Arrays, booleans and `undefined` pass through. Select values
  are ids and enum names, so trimming leaves them unchanged.
- If the trimmed value equals the held one, `setField`/`setExtra` record the typed text and return.
  They don't re-set the value or restart an async check (legacy's `$viewValue !==` guard). This matters
  for `uniqueEmail`: a trailing space no longer re-queries.
- The forms bind text inputs and textareas with `value={form.viewValue('…')}`. That covers project
  (name, desc), user (email, lastName, firstName, password, passwordRepeat), backlog item (name, desc),
  sprint (name, start, end) and task (name, desc). Selects, number inputs and the Admin checkbox are
  unchanged.
- Login modal: it has its own two `useState`s, not `useCrudForm`. It now keeps the typed text in state
  and derives `email`/`password` with `.trim()`. Validity and the `/login` body use the derived values;
  Clear empties the typed text.
- User form passwords: `password` and `passwordRepeat` are both trimmed, so the `equal` rule compares
  trimmed values, as legacy did. On edit, a spaces-only password is `''`, which means "blank =
  unchanged": it is optional, not dirty, and left out of the PUT (AC-USR-06 still holds).
- **Contract note for the reviewer:** `viewValue(name)` is an addition to the §4.2 return type. It is
  additive, and nothing else in the contract changed. P6 requires the input to show the typed text while
  the form holds the trimmed text, and the hook is the only owner of both. Trimming the controlled
  input's own value was rejected: it eats a trailing space on every keystroke, so "a b" can't be typed.

### Tests (all named `P6 / DSC-B-1: …`)
- `crud/useCrudForm.test.tsx`, 5 tests:
  - spaces-only required is invalid, `"  x  "` saves as `"x"`, and `viewValue` shows the raw text;
  - "a b" keeps its inner space, and a trailing space is not dirty;
  - revert parity;
  - `extra` is trimmed, `equalsField` compares trimmed values, and numbers and arrays are untouched;
  - a trailing space doesn't restart an async check.
- One test per form, through the real app (`renderRoute` + stub): `ProjectEdit`, `BacklogItemEdit`,
  `SprintEdit`, `TaskEdit` (textarea with a newline) and `LoginModal`. `UserEdit` has 2 tests, the
  second for a spaces-only password on edit. Each checks that spaces-only keeps Save/Sign in disabled,
  that the input shows the typed text, and that the request body is trimmed.
- e2e `sprints-tasks.spec.ts`: a new sprint, typed key by key, against the built app and the Node stub.
  A spaces-only Name keeps Save disabled. The POST carries `name: 'Sprint  3'` (inner double space kept),
  `start: '2026-01-05'` and `end: '2026-01-16'`.

### Mutations (tests bite)
| # | Mutation | Result |
|---|---|---|
| M1 | `useCrudForm` `trimText` returns `raw` instead of `raw.trim()` | unit: `Tests  10 failed \| 391 passed (401)` (4 hook tests, 6 form tests); e2e P6 (rebuilt): `1 failed`, "Expected: disabled / Received: enabled" |
| M2 | `LoginModal` uses the typed text untrimmed | unit: `Tests  1 failed \| 400 passed (401)` (the login P6 test) |
| M3 | `viewValue` always returns the held (trimmed) value, i.e. a controlled input trimmed per keystroke | unit: `Tests  22 failed \| 379 passed (401)`; e2e P6: `1 failed`, "Expected: \"   \" / Received: \"\"" |

Each mutation was reverted with `git checkout <file>`, and the tree was clean before the final gate run.

### Wrong turns
- The first e2e run failed: the Name field held `"Sprint  3    "` instead of `"   Sprint  3 "`. I
  suspected the new view-value logic. A throwaway Playwright probe on a plain uncontrolled `<input>`
  (not committed) gave the same result: `pressSequentially` re-focuses the field with the caret at the
  start, so it isn't the app. The test now presses `End` first.
- My first attempt to run only the new e2e (`pnpm e2e -- --project chromium -g P6`) ran all 37 tests,
  because the `e2e` script chains builds and doesn't forward the filter. Focused runs then used
  `pnpm build` plus `pnpm exec playwright test … -g P6`.
- Removing the `values`/`extra` destructures that became unused in `ProjectEdit`/`UserEdit` was caught by
  `tsc` and eslint before the first commit.

### Gates (this session, from `web/`, ports 3901/5073/5074)
`pnpm install --frozen-lockfile`: exit 0. `pnpm verify`: exit 0.
```
$ eslint --max-warnings 0 . && prettier --check .
All matched files use Prettier code style!
$ tsc --noEmit -p tsconfig.json
 Test Files  41 passed (41)
      Tests  401 passed (401)
  37 passed (13.1s)
```
