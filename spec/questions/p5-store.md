# Questions raised by cluster p5-store (Phase 5, wave A)

Ids are `Q-p5-store-<n>` (spec §8, `conversion-spec.md` §8.5).

**Q-p5-store-1. Foreign keys between documents (not blocking; implemented as recommended).**
Context: spec §3.2 names one place without a foreign key, `sprint_backlog_items.backlog_item_id`
(D13). It does not say whether the other references get one: `projectId` on backlog items, sprints and
tasks; `sprintId`, `productBacklogItemId` and `assignedUserId` on tasks; `productOwner`, `scrumMaster`
and the team members on projects. The legacy MongoDB never enforced any of them, the stub does not, and
the front end can delete a user, project, backlog item or sprint that other documents still point at
(the edit screens all have Remove). A foreign key would turn those deletes into errors (`RESTRICT`) or
into deletes of other documents (`CASCADE`), which changes the wire contract (N1). It would also refuse a
POST or PUT that names an id that does not exist, which the stub accepts.
Options: (a) no foreign keys between documents; only the join tables reference the document that owns
the list (`ON DELETE CASCADE`, since the rows are part of that document); (b) foreign keys with
`RESTRICT`; (c) foreign keys with `CASCADE`.
*Recommended and implemented: (a)*, proposed as DEV-p5-store-01, pinned by the contract test "D13:
deletes never cascade or refuse" (both stores) and by AC-PG-02's foreign-key listing. (b) or (c) would
be a behaviour change that needs its own decision and front-end work.
