# Migration status

Only reviewers change this file, and only through PRs (spec §8.2, §8.3, S10).
Statuses: `pending` → `converted` (reviewer started) → `verified` (review passed) → `merged`.

## Gates

| Gate | Opens when | State |
|---|---|---|
| Phase 2 exit (spec §13) | harness PR merged, CI green, Pages demo live, no secrets in the tree, reviewer sign-off | **open** (2026-11-21): PR #1 squash-merged as `29e69b4`, CI green on `migration`, Pages deep link verified live, reviewer signed off (`spec/reviews/phase-2-review.md`) |
| Cluster 0 may start | Phase 2 exit | **open**; the 5 CI checks are required on `migration` (branch protection, E4, 2026-11-21) |
| Wave A (clusters 1, 2, 3) | cluster 0 `merged` **and** spec §11-4 proven by cluster 0's tests | **open** (2026-11-21): cluster 0 merged as `b04ff4d`; §11-4 proven by `web/src/app/routerDataMode.test.tsx` (reviewer-verified) |
| Wave B (clusters 4, 5) | clusters 1, 2, 3 all `merged` | **open** (2026-11-21): cluster 3 merged as `a66bf3f`, cluster 2 as `bdc4150`, cluster 1 as `65e42c2` |
| Phase 3 complete | every cluster `merged` | **done** (2026-11-21): cluster 5 merged as `eb33b23`, cluster 4 as `b9d1e3c`. Next: Phase 4 (case study README, `deviations.md` wrap-up) |

## Clusters

| # | Cluster | Wave | Status | PR | Reviewer notes |
|---|---|---|---|---|---|
| 0 | foundation | first | merged | [#4](https://github.com/timothyjeffcoat/ascrum-migration/pull/4) | 46/46 ACs; DEV-foundation-01 fixed in c31036b; owner answered Q-foundation-1/2 and accepted DEV-foundation-02 (2026-11-21) |
| 1 | admin-users | A | merged | [#9](https://github.com/timothyjeffcoat/ascrum-migration/pull/9) | 8/8 ACs; DEV-admin-users-01 fixed (guard tests); Q-admin-users-1 answered (b), spec P2, implemented; Q-admin-users-2 accepted; re-reviewed; merged as 65e42c2 |
| 2 | admin-projects | A | merged | [#8](https://github.com/timothyjeffcoat/ascrum-migration/pull/8) | 6/6 ACs; DEV-admin-projects-01 fixed (guard tests); Q-admin-projects-1 answered (b), spec P3, DEV-admin-projects-06; Q-admin-projects-2 accepted; re-reviewed; merged as bdc4150 |
| 3 | projects + productbacklog | A | merged | [#7](https://github.com/timothyjeffcoat/ascrum-migration/pull/7) | 5/5 ACs; 14/14 reviewer mutations caught; DEV-projects-01 (Q-projects-1, answered (a)) and -02 (CI flake, fixed in #10) non-blocking; merged as a66bf3f |
| 4 | sprints + tasks | B | merged | [#19](https://github.com/timothyjeffcoat/ascrum-migration/pull/19) | 9/9 ACs; 34/34 reviewer unit mutations caught (e2e 4/5); DEV-sprints-tasks-01 (stale ids, owner question recommended), -02, -03 non-blocking; Q-sprints-tasks-1/2 recommended as implemented; P5 implemented and re-reviewed; merged as b9d1e3c |
| 5 | dashboard + projectsinfo | B | merged | [#18](https://github.com/timothyjeffcoat/ascrum-migration/pull/18) | 2/2 ACs; 25/27 reviewer mutations caught (DEV-dashboard-01/02, test gaps, non-blocking); Q-dashboard-1 awaits the owner (reviewer recommends (a)); DEV-dashboard-01/02 fixed; merged as eb33b23 |
