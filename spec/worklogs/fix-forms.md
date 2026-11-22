# Worklog: fix-forms (DSC-1 / DSC-2, spec §0.2 P4)

Branch `fix/forms-enter-key`, from `origin/migration` at `ddb545c`. A cross-cluster fix (clusters 0, 2, 3)
run by the orchestrator under the owner's mandate. Owned paths for this task: `web/src/auth/LoginModal.tsx`
(+ test), `web/src/features/admin-projects/`, `web/src/features/admin-users/`,
`web/src/features/productbacklog/`, one e2e spec, this worklog (and the task's questions file).

Findings fixed: DSC-1 and DSC-2 from the independent legacy audit (`spec/reviews/legacy-audit-wave-a.md`,
PR #15). Rule implemented: P4 (spec §0.2, merging separately).

## 2026-11-22: session 1

### What was done
- **Reproduction first.** Wrote `web/e2e/forms-enter.spec.ts` and ran it against the unfixed build
  (`pnpm build && pnpm build:pages`, then `playwright test e2e/forms-enter.spec.ts --project chromium`).
  Both tests failed for the audited reasons:
  - DSC-1: `Expected: "Renamed but unsaved" / Received: "Webshop"`: Enter in Name reloaded the page.
  - DSC-2: `expect(modal).toHaveCount(0)`, `Received: 1`: Enter in Password did not sign in.
- **DSC-1 / P4:** `ProjectEdit.tsx` form gets `onSubmit={(event) => event.preventDefault()}`.
  `UserEdit.tsx` gets the same (Enter cannot submit it today: five text fields and no submit button, but
  P4 makes that not matter). `BacklogItemEdit.tsx` already had it (cluster 3); only the comment now cites P4.
  The project form keeps its legacy markup (no `noValidate` added), so the team buttons stay `type="button"`
  and legacy's "Enter clicks the first team Remove" bug is not ported.
- **DSC-2 / P4:** in `LoginModal.tsx`, "Sign in" is `type="submit"` again with no `onClick`; the form's
  `onSubmit` calls `preventDefault()` and then signs in only if the form is valid (the same `formInvalid`
  that disables the button, AC-AUTH-04). Clicking Sign in and pressing Enter now go through the same path,
  so login cannot run twice per click. Clear and Cancel stay `type="button"`.
- Replaced the test `every button in the login form is type="button" (CLAUDE.md)` with
  `P4: "Sign in" is the form's only submit button; Clear and Cancel are type="button"`: the old test
  asserted the convention that caused DSC-2.

### Tests added
| Test | File |
|---|---|
| `DSC-1 / P4: Enter in the project Name field keeps the edits and does not submit` | `admin-projects/ProjectEdit.test.tsx` |
| `P4: Enter in the Last name field keeps the edits and does not submit` | `admin-users/UserEdit.test.tsx` |
| `P4: Enter in the backlog item Name field keeps the edits and does not submit` | `productbacklog/BacklogItemEdit.test.tsx` |
| `P4: "Sign in" is the form's only submit button; Clear and Cancel are type="button"` | `auth/LoginModal.test.tsx` |
| `AC-AUTH-04 / DSC-2 / P4: Enter in the password field signs in` | `auth/LoginModal.test.tsx` |
| `AC-AUTH-04 / DSC-2 / P4: Enter with an invalid e-mail does not sign in` | `auth/LoginModal.test.tsx` |
| `AC-AUTH-04 / DSC-2 / P4: Enter in the password field signs in` (e2e) | `e2e/forms-enter.spec.ts` |
| `DSC-1 / P4: Enter in the project Name field keeps the edits and does not reload the page` (e2e) | `e2e/forms-enter.spec.ts` |

Each unit test asserts: the typed value stays, `recordRequests()` sees nothing (or, for login, exactly
one / zero `POST /login`), the router location is unchanged, and (project) the team rows are unchanged.

**How the unit tests see a native submission.** jsdom never navigates on a form submission, so "no reload"
cannot be observed directly in Vitest. Each test registers a `submit` listener on `window` (outside React's
root, so it runs after the form's `onSubmit`) and records `event.defaultPrevented`; the assertion is that
every submit reaching it was cancelled. For the project form, user-event performs the implicit submission
itself (Name is the only field that blocks it). For the user and backlog forms Enter does not submit at all
(several blocking fields, no submit button), so those tests also call `form.requestSubmit()` to prove the
form cancels a submission from any trigger. The real reload is covered by the e2e test.

### Mutation checks (each applied alone, matching tests run, then reverted)
| # | Mutation | Result |
|---|---|---|
| M1 | remove `onSubmit` from the project form | `DSC-1 / P4: Enter in the project Name field …` **red** |
| M2 | remove `onSubmit` from the user form | `P4: Enter in the Last name field …` **red** |
| M3 | remove `onSubmit` from the backlog item form | `P4: Enter in the backlog item Name field …` **red** |
| M4 | remove the login form's `onSubmit` | both `AC-AUTH-04 / DSC-2 / P4` tests **red** |
| M5 | remove only `event.preventDefault()` from the login `onSubmit` | both `AC-AUTH-04 / DSC-2 / P4` tests **red** |
| M6 | remove the `formInvalid` guard in the login `onSubmit` | `… Enter with an invalid e-mail does not sign in` **red** |
| M7 | "Sign in" back to `type="button"` | `P4: "Sign in" is the form's only submit button …` and `… Enter in the password field signs in` **red** |
| E2E | the unfixed app (before any source change) | both `e2e/forms-enter.spec.ts` tests **red** (see above) |

`git status` after the mutation script showed only the intended changes.

### Gates (run in this session, from `web/`, `STUB_PORT=3601 PREVIEW_PORT=4773 PAGES_PORT=4774 pnpm verify`)
```
$ eslint --max-warnings 0 . && prettier --check .
All matched files use Prettier code style!
$ tsc --noEmit -p tsconfig.json
 Test Files  34 passed (34)
      Tests  294 passed (294)
  27 passed (7.9s)
```

### Questions
- Q-fix-forms-1 (open at the time, not blocking; answered yes in session 2): the two `navbar-form` forms in `LoginToolbar.tsx` have no
  `onSubmit`. They cannot be submitted (no fields, no submit button), but P4 says *every* form. The file is
  outside this task's owned paths, so it was not edited.

### Mistakes and wrong turns
- The first version of the e2e login test expected the toolbar link `User Admin`; the toolbar shows
  `firstName lastName`, i.e. `Admin User`. Spotted by re-reading the seed before running `pnpm verify`.
  The pre-fix failure of that test was still for the right reason: it failed earlier, on the modal staying
  open.
- The obvious test for the user and backlog forms (press Enter, assert nothing happened) would have been
  worthless: under user-event's (and the HTML spec's) implicit-submission rules Enter cannot submit those
  forms, so it stays green with the `preventDefault` removed. Added the `requestSubmit()` step before
  running anything; M2 and M3 confirm the tests go red.
- The e2e DSC-1 test checks the value right after Enter. A reload could in principle land after that
  check; in practice the unfixed run failed reliably (the value was "Webshop" for the whole 5 s retry), and
  the URL / document-request assertions back it up.

## 2026-11-21: session 2 (Q-fix-forms-1 answered)

Owned paths for this session: `web/src/auth/LoginToolbar.tsx` (+ test), this worklog and the questions file.
(Session 1 above is dated 2026-11-22; that date was a slip, it ran before this session.)

### What was done
- The orchestrator answered Q-fix-forms-1 **yes** (under the owner's P4 rule). Both button-only
  `<form className="navbar-form">` elements in `LoginToolbar.tsx` (Log out, Log in) now have
  `onSubmit={(event) => event.preventDefault()}`, with a comment citing P4 / Q-fix-forms-1. Markup and
  classes are otherwise unchanged.
- Test `P4: the login toolbar forms cancel native submission` (`auth/LoginToolbar.test.tsx`): renders the
  shell anonymous, then as `po`, waiting with `waitForShell(router)` each time (via the file's
  `renderToolbar`). For each state it registers a `submit` listener on `window` recording
  `defaultPrevented` (the session 1 pattern), calls `form.requestSubmit()` on the form around "Log in" /
  "Log out", and asserts `[true]` and no request reaching the stub. The forms have no field or submit
  button, so `requestSubmit()` is the only way to reach the handler.

### Mutation checks (each applied alone, the P4 test run, then reverted)
| # | Mutation | Result |
|---|---|---|
| M8 | remove `onSubmit` from the "Log out" form | `P4: the login toolbar forms cancel native submission` **red** (`expected [ false ] to deeply equal [ true ]`) |
| M9 | remove `onSubmit` from the "Log in" form | same test **red** (same message) |

`git status` after restoring showed only the intended two files changed.

### Gates (run in this session, from `web/`, `STUB_PORT=3601 PREVIEW_PORT=4773 PAGES_PORT=4774 pnpm verify`, exit 0)
```
All matched files use Prettier code style!
$ tsc --noEmit -p tsconfig.json
 Test Files  34 passed (34)
      Tests  295 passed (295)
  27 passed (7.8s)
```

### Mistakes and wrong turns
- None of note. `pnpm verify` output went to a scratch file by redirect (not a pipe), so the exit code the
  metrics hook records is the real one.
