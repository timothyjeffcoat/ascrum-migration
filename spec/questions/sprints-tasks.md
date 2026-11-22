# Questions raised by cluster 4 (sprints + tasks)

Ids are `Q-sprints-tasks-<n>` (spec §8.5).

**Q-sprints-tasks-1. The sprint picker's two `<label>`s caption tables, not controls (not blocking; implemented as recommended).**
Context: P1 says each legacy `<label>` gets `htmlFor` and its control an `id`. In `sprints-edit.tpl.html`,
`<label>Currently in the sprint's backlog</label>` and `<label>Product backlog</label>` sit above the two
picker tables; there is no form control to link them to. Cluster 2 met the same case with
`<label>Development Team</label>` above the team table and left it unlinked.
Options: (a) keep both as plain `<label>`s, unchanged (markup verbatim, B4); (b) link each to its table
with `htmlFor`/`id` (invalid: a label can only label a labelable element); (c) turn them into
`<caption>`s or `aria-labelledby` targets (a markup change P1 does not ask for).
*Recommended and implemented: (a).* Tests find the tables as "the table after the caption". Cheap to
reverse.

**Q-sprints-tasks-2. Any signed-in user may open any project's sprints and tasks (not blocking; implemented as the spec says).**
Context: the brief asks for guard tests "as a signed-in user who is not allowed". For R7–R12 the spec
(§5.3, D2) only requires authentication, and legacy had no guard at all, so there is no signed-in
user who is refused: `outsider@ascrum.test`, a member of no project, can open Webshop's sprints and
tasks and edit them (the stub allows any session user to write `sprints`/`tasks`, §7.3).
Options: (a) keep the spec as written: authentication only, with tests pinning that `outsider` is let in;
(b) add a per-project membership guard (new behaviour, beyond legacy; a spec change and a `domain/`
helper from cluster 0).
*Recommended and implemented: (a).* Each guarded route has an anonymous test (login modal, nothing
fetched) and an `outsider` test (screen renders). Recorded so the absence of a "not authorized" case is
a decision, not a gap.
