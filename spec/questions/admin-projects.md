# Questions raised by cluster 2 (admin-projects)

Ids are `Q-admin-projects-<n>` (spec §8.5). Neither question blocks the cluster: each is implemented
as recommended (legacy parity) and is cheap to change.

**Q-admin-projects-1. A team selection that stops being a candidate stays selected (legacy quirk).**
Context: `extra.selTeamMember` holds the user chosen in the "add" row of the Development Team table.
If that same user is then chosen as Product Owner, they drop out of `teamMemberCandidates` (a PO
can't be a developer), but the selection is not cleared. The select shows `-- choose --` (no option
matches), yet `Add` stays enabled, and clicking it adds the PO to the team. Legacy did exactly this:
`TeamMembersController` only cleared `selTeamMember` on add and on removing the selected member, and
`ng-options` showed the blank option for an unmatched model. AC-APR-04 lists only those two clearing
rules, and spec §1 asks for parity outside the listed deviations.
Options: (a) keep parity (implemented); (b) clear `selTeamMember` whenever it is no longer in
`teamMemberCandidates`, as a new logged deviation.
*Recommended and implemented: (a).* It is reachable only by choosing the same person twice in a
specific order; (b) is a one-line change in `TeamMembers.tsx` plus a named test if the owner wants it.

**Q-admin-projects-2. `<crud-buttons class="span12">` becomes `div.span12 > CrudButtons`.**
Context: `projects-edit.tpl.html` is the only legacy template that puts a class on `<crud-buttons>`.
The directive used `replace: true`, so legacy rendered a single `<div class="span12">` holding the
three buttons. Cluster 0's `CrudButtons` takes no `className`, and `crud/` is outside this cluster's
paths, so the port wraps it: `<div class="span12"><div>…buttons…</div></div>`. Classes and strings are
unchanged; the extra plain `div` adds no Bootstrap styling.
Options: (a) keep the wrapper (implemented); (b) cluster 0 adds an optional `className` prop to
`CrudButtons`, and this screen passes `span12`.
*Recommended: (a)*, unless a reviewer reads B4 as requiring identical nesting.
