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

**Answer (2026-11-23, owner, relayed by the orchestrator): (a), accepted** ("approve all"). No foreign
keys between documents; DEV-p5-store-01 stands as implemented.

## Owner decisions on the wave A review (2026-11-23, owner, relayed by the orchestrator: "approve all")
- **DEV-p5-store-01** (no foreign keys between documents): accepted. Same as Q-p5-store-1 above.
- **DEV-p5-store-04** (400 for a NUL character or a lone surrogate): accepted.
- **DEV-p5-store-05, -06, -07, -08** (test gaps): close all four before merge. Done in session 2 of the
  worklog (tests only, no app behaviour changed).
- **DEV-p5-store-09** (`integration` as a required check): becomes required at merge. The orchestrator
  does this; nothing for this cluster.
- **Q-p5-devsecops-5** (Dependabot for `/api`): the entry lands with `api/`. `.github/dependabot.yml`
  arrives with PR #41, which was still open (not merged into `migration`) when session 2 finished, so the
  `/api` entry is pending; see the worklog.

No new question: legacy pins e-mail matching unambiguously (DEV-p5-store-08, see the worklog), so
`Q-p5-store-2` was not needed.
