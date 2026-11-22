# Questions raised by cluster 5 (dashboard + projectsinfo)

Ids are `Q-dashboard-<n>` (spec §8.5).

**Q-dashboard-1. Class parity on `/projectsinfo`, whose legacy template has no classes (not blocking; implemented as recommended).**
Context: spec §12 says every screen has at least one assertion on its legacy root classes. Legacy
`projectsinfo/list.tpl.html` is a single `<h3>Projects info</h3>` with no class at all (D1 preserved), so
there is no class to assert.
Options: (a) assert the legacy markup's shape instead: the heading is an `<h3>` without a `class`
attribute and is the only element in the shell's content area (`.container-fluid`); (b) add a class so
there is something to assert (changes the legacy markup, against B4); (c) exempt the screen.
*Recommended and implemented: (a)*, in `ProjectsInfo.test.tsx` ("class parity: the legacy template is a
bare <h3> (no classes) and nothing else"). Mutation M13 (adding a class) turns it red. Cheap to reverse:
test-only.

**Answer (owner, 2026-11-21): (a), accepted as implemented.**
