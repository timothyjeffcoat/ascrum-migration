# Questions raised by cluster 3 (projects + productbacklog)

Ids are `Q-projects-<n>` (spec §8.5).

**Q-projects-1. The backlog item form's labels gained `for`/`id` (not blocking; implemented as recommended).**
Context: legacy `productbacklog-edit.tpl.html` has `<label>Name</label>`, `<label>User story</label>`,
`<label>Priority</label>` and `<label>Estimation</label>` with no `for`, so the fields have no
accessible name. B4 says keep the markup verbatim; CLAUDE.md says tests query by role, label or text,
and a number input or textarea can only be told apart by its label. The owner answered the same
question for the login modal with "add `for`/`id`" (Q-foundation-1), but that answer named only the
login form.
Options: (a) add `htmlFor`/`id` (`name`, `desc`, `priority`, `estimation`, the field names, as
`users-edit.tpl.html` does); (b) keep the markup exactly and query the fields by position or `name`
(priority and estimation have no `name` in legacy, an inventory §markup quirk this port keeps).
*Recommended and implemented: (a).* Classes, strings and the missing `name` attributes are unchanged.
Cheap to reverse; the sprint and task forms (cluster 4) will meet the same choice.
**Answer (owner, 2026-11-21): (a).** The owner made it a standing rule for every legacy form: add
`htmlFor`/`id` to labels, change nothing else in the markup (classes, strings, missing `name`s). The
rule goes into the spec and CLAUDE.md in the amendment PR.
