# Questions raised by the fix-forms task (DSC-1 / DSC-2, P4)

Ids are `Q-fix-forms-<n>` (spec §8.5).

**Q-fix-forms-1. The two toolbar forms in `LoginToolbar.tsx` have no `onSubmit`.**
Context: P4 says *every* `<form>` has an `onSubmit` that calls `event.preventDefault()`.
`web/src/auth/LoginToolbar.tsx` renders `<form className="navbar-form">` around the "Log out" and
"Log in" buttons (legacy markup). Neither form has a text field or a submit button, so a browser
cannot submit them today and nothing user-visible is wrong. The file is outside this task's owned
paths (only `LoginModal.tsx` and its test are), so it was not edited.
Options: (a) add `onSubmit={(event) => event.preventDefault()}` to both, in a follow-up owned by
cluster 0, so P4 holds literally; (b) word P4 as "every form with a field that can submit it".
*Recommended: (a).* It is two attributes, keeps the rule mechanical (easy to check with a grep or a
lint rule), and does not depend on today's markup.
**Answer:** (open)
