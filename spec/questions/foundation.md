# Questions raised by cluster 0 (foundation)

Ids are `Q-foundation-<n>` (spec §8.5). Neither question blocks the cluster: each is implemented as
recommended and is cheap to reverse.

**Q-foundation-1. The login modal's labels gained `for`/`id` (a small addition to the legacy markup).**
Context: legacy `security/login/form.tpl.html` has `<label>E-mail</label>` and `<label>Password</label>`
with no `for`, so the inputs have no accessible name. B4 says keep the markup, classes and strings
verbatim; CLAUDE.md says tests query by role, label or text, and a password input has no role, so
it can only be found by label. Classes and strings are unchanged.
Options: (a) add `htmlFor`/`id` (`login-email`, `login-pass`); (b) keep the markup exactly and query
the password field by its `name` attribute in tests.
*Recommended and implemented: (a).* Other legacy forms (for example `users-edit.tpl.html`) already use
`for`/`id`, so this brings the login form in line rather than inventing a pattern.
**Answer:**

**Q-foundation-2. `renderRoute()` is async; CLAUDE.md's example reads as if it were synchronous.**
Context: `renderRoute(path, {as: 'admin'})` logs the persona in on the stub before rendering, which
needs network round trips, so it returns a promise: `const { user, router } = await renderRoute(...)`.
CLAUDE.md (Conventions → Tests) shows `renderRoute(path, {as: ...})` with no `await`. Workers in waves
A and B will copy that line.
Options: (a) amend CLAUDE.md to show `await renderRoute(...)`; (b) leave it, since TypeScript flags
an un-awaited promise used as a result object.
*Recommended: (a).* CLAUDE.md is outside cluster 0's owned paths, so this is a question, not an edit.
**Answer:**
