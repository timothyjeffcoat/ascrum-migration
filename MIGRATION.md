# Migration status

Only reviewers change this file, and only through PRs (spec §8.2, §8.3, S10).
Statuses: `pending` → `converted` (reviewer started) → `verified` (review passed) → `merged`.

## Gates
| Gate | Opens when | State |
|---|---|---|
| Phase 2 exit (spec §13) | harness PR merged, CI green, Pages demo live, no secrets in the tree, reviewer sign-off | **open** (2026-11-21): PR #1 squash-merged as `29e69b4`, CI green on `migration`, Pages deep link verified live, reviewer signed off (`spec/reviews/phase-2-review.md`) |
| Cluster 0 may start | Phase 2 exit | **open** (owner still to make the 5 CI checks required on `migration`, E4) |
| Wave A (clusters 1, 2, 3) | cluster 0 `merged` **and** spec §11-4 proven by cluster 0's tests | closed |
| Wave B (clusters 4, 5) | clusters 1, 2, 3 all `merged` | closed |

## Clusters
| # | Cluster | Wave | Status | PR | Reviewer notes |
|---|---|---|---|---|---|
| 0 | foundation | first | verified | [#4](https://github.com/timothyjeffcoat/ascrum-migration/pull/4) | 46/46 ACs; DEV-foundation-01 fixed in c31036b; merge held by the orchestrator pending Q-foundation-1/2 and DEV-foundation-02 |
| 1 | admin-users | A | pending | | |
| 2 | admin-projects | A | pending | | |
| 3 | projects + productbacklog | A | pending | | |
| 4 | sprints + tasks | B | pending | | |
| 5 | dashboard + projectsinfo | B | pending | | |
