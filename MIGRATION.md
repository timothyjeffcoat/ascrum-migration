# Migration status

Only reviewers change this file, and only through PRs (spec §8.2, §8.3, S10).
Statuses: `pending` → `converted` (reviewer started) → `verified` (review passed) → `merged`.

## Gates

| Gate | Opens when | State |
|---|---|---|
| Phase 2 exit (spec §13) | harness PR merged, CI green, Pages demo live, no secrets in the tree, reviewer sign-off | **open** (2026-11-21): PR #1 squash-merged as `29e69b4`, CI green on `migration`, Pages deep link verified live, reviewer signed off (`spec/reviews/phase-2-review.md`) |
| Cluster 0 may start | Phase 2 exit | **open**; the 5 CI checks are required on `migration` (branch protection, E4, 2026-11-21) |
| Wave A (clusters 1, 2, 3) | cluster 0 `merged` **and** spec §11-4 proven by cluster 0's tests | **open** (2026-11-21): cluster 0 merged as `b04ff4d`; §11-4 proven by `web/src/app/routerDataMode.test.tsx` (reviewer-verified) |
| Wave B (clusters 4, 5) | clusters 1, 2, 3 all `merged` | closed |

## Clusters

| # | Cluster | Wave | Status | PR | Reviewer notes |
|---|---|---|---|---|---|
| 0 | foundation | first | merged | [#4](https://github.com/timothyjeffcoat/ascrum-migration/pull/4) | 46/46 ACs; DEV-foundation-01 fixed in c31036b; owner answered Q-foundation-1/2 and accepted DEV-foundation-02 (2026-11-21) |
| 1 | admin-users | A | pending | | |
| 2 | admin-projects | A | verified | [#8](https://github.com/timothyjeffcoat/ascrum-migration/pull/8) | 6/6 ACs; 17 mutations, 14 killed; DEV-admin-projects-01..05 non-blocking; Q-admin-projects-1/2 open; orchestrator holds the merge |
| 3 | projects + productbacklog | A | pending | | |
| 4 | sprints + tasks | B | pending | | |
| 5 | dashboard + projectsinfo | B | pending | | |
