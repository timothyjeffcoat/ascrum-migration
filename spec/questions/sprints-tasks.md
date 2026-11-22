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

**Answer (owner, 2026-11-21): (a), accepted.**

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

**Answer (owner, 2026-11-21): (a), authentication only, accepted.**

**Q-sprints-tasks-3. P5 and the State select, which has no blank option (not blocking; data rule implemented, display unchanged).**
Context: §0.2 P5 makes a task whose stored `state` is not in `TASK_STATES` start with `state` unset,
so Save stays disabled until a state is chosen (implemented; test `AC-TSK-02 / P5: a task with a
malformed state must have a state chosen before Save`). The State select has no blank option (legacy
parity: every route starts with a state), so with the value unset the browser shows the first option,
`TODO`. Two consequences: the select reads `TODO` while the form holds no state, and in a real browser
choosing `TODO` (the option already shown) fires no `change` event, so the user must pick another state
first. The backlog item and "Assigned to" selects do not have this problem because they have S13 blank
options. Only malformed stored data reaches it; the UI cannot produce such a task.
Options: (a) leave the markup as is (data rule only; the display gap stays, limited to malformed data);
(b) render a `-- choose --` blank option in State only while `state` is unset (truthful label, and
`TODO` becomes choosable; new markup for that case only); (c) always render a blank option (changes the
normal form; not recommended).
*Recommended: (b).* Implemented: (a) until answered, since a new option is markup the spec does not
cover.
