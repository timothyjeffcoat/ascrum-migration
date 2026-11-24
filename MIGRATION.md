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
| Phase 4 complete | case-study README and `deviations.md` summary merged | **done** (2026-11-22): README rewritten as the case study, Summary added to `spec/deviations.md` (35 deviations, none open; the last, DEV-admin-users-02, closed in this PR), journal entry; [#25](https://github.com/timothyjeffcoat/ascrum-migration/pull/25) |

## Clusters

| # | Cluster | Wave | Status | PR | Reviewer notes |
|---|---|---|---|---|---|
| 0 | foundation | first | merged | [#4](https://github.com/timothyjeffcoat/ascrum-migration/pull/4) | 46/46 ACs; DEV-foundation-01 fixed in c31036b; owner answered Q-foundation-1/2 and accepted DEV-foundation-02 (2026-11-21) |
| 1 | admin-users | A | merged | [#9](https://github.com/timothyjeffcoat/ascrum-migration/pull/9) | 8/8 ACs; DEV-admin-users-01 fixed (guard tests); Q-admin-users-1 answered (b), spec P2, implemented; Q-admin-users-2 accepted; re-reviewed; merged as 65e42c2 |
| 2 | admin-projects | A | merged | [#8](https://github.com/timothyjeffcoat/ascrum-migration/pull/8) | 6/6 ACs; DEV-admin-projects-01 fixed (guard tests); Q-admin-projects-1 answered (b), spec P3, DEV-admin-projects-06; Q-admin-projects-2 accepted; re-reviewed; merged as bdc4150 |
| 3 | projects + productbacklog | A | merged | [#7](https://github.com/timothyjeffcoat/ascrum-migration/pull/7) | 5/5 ACs; 14/14 reviewer mutations caught; DEV-projects-01 (Q-projects-1, answered (a)) and -02 (CI flake, fixed in #10) non-blocking; merged as a66bf3f |
| 4 | sprints + tasks | B | merged | [#19](https://github.com/timothyjeffcoat/ascrum-migration/pull/19) | 9/9 ACs; 34/34 reviewer unit mutations caught (e2e 4/5); DEV-sprints-tasks-01 (stale ids, owner question recommended), -02, -03 non-blocking; Q-sprints-tasks-1/2 recommended as implemented; P5 implemented and re-reviewed; merged as b9d1e3c |
| 5 | dashboard + projectsinfo | B | merged | [#18](https://github.com/timothyjeffcoat/ascrum-migration/pull/18) | 2/2 ACs; 25/27 reviewer mutations caught (DEV-dashboard-01/02, test gaps, non-blocking); Q-dashboard-1 awaits the owner (reviewer recommends (a)); DEV-dashboard-01/02 fixed; merged as eb33b23 |

## Phase 5 (spec `spec/phase5-spec.md`, APPROVED rev 2)

| Gate | Opens when | State |
|---|---|---|
| Wave A (p5-store, p5-devsecops) | spec approved | **done** (2026-11-23): p5-devsecops merged as `f03f449` (#41), p5-store as `984a0e6` (#48); 10 required checks on `migration` |
| Wave B (p5-security, p5-containers) | wave A `merged` | **done** (2026-11-24): p5-security merged as `ae6405a` (#59), p5-containers as `9fd4f88` (#60); 11 required checks on `migration` (`e2e-compose` added) |
| Wave C (p5-infra) | wave B `merged` and the owner prerequisites in spec §11 | **open** (2026-11-24, owner): wave B and p5-hardening merged; AWS account and budget limit confirmed by the owner; the OIDC provider and deploy role are written by p5-infra and deployed once by the owner (spec §11, clarified). p5-infra merged as `472274a` (#69); the owner's one-time bootstrap and the first live runs are still due |

| Cluster | Wave | Ports (STUB/PREVIEW/PAGES) | Status | PR | Reviewer notes |
|---|---|---|---|---|---|
| p5-store | A | 3601/4773/4774, Postgres 55436 | merged | [#48](https://github.com/timothyjeffcoat/ascrum-migration/pull/48) | 6/6 AC-PG; `pnpm verify` + `test:integration` green (413 unit, 35 integration, 37 e2e); gates in `api/` proven by planting; owner O3 caught, O1 caught except per collection, O2 survived; DEV-p5-store-01..04 accepted (-01, -04 confirmed by the owner). Re-review after 7f7d486 (tests only; 416 unit, 38 integration, 37 e2e): -05..08 fixed, O1 per collection and every O2 variant now red; -09 `integration` required at merge (orchestrator); new -10, -11 (narrower test limits, non-blocking, open); merged as 984a0e6 |
| p5-devsecops | A | 3701/4873/4874 | merged | [#41](https://github.com/timothyjeffcoat/ascrum-migration/pull/41) | No blocking findings. AC-DSO-01: CodeQL and deps red on plants (#42, #43, reviewer #46); secrets answered Q-1 (b), pending a Gitleaks job (DEV-p5-devsecops-01); checks to require after merge per Q-2 (DEV-02). Reviewer plants #44 (audit ignore) and #45 (`api/` lockfile) passed every check: DEV-03/-04, follow-up before `api/` lands. AC-DSO-02 provable only after merge (first Dependabot PR). Q-3 done; `SECURITY.md` follow-up; merged as f03f449 |
| p5-security | B | 3801/4973/4974, Postgres 55438 | merged | [#59](https://github.com/timothyjeffcoat/ascrum-migration/pull/59) | Re-review 2026-11-23: **DEV-p5-security-08 fixed** (each sign-in counted atomically before its password check). Reviewer probe, production defaults, 100 wrong passwords for one account at once: 100 → 5 checked; 100 from one address over 100 accounts: 100 → 20; split over two API processes: 100 → 5. Test gaps -09..-12 fixed (R1, R8, R9, R10, R14, R15, R20 now red; 7 throttle mutations red; 8 new breakages, 7 red, 1 survived: -17, logged). Q-p5-security-1/2 answered (a) by the owner. Reviewer `pnpm verify` exit 0 (435 unit, 76 integration, 41 e2e). Open, non-blocking: -13 (IPv6, wave C), -15 (cap scrypt r/p), -16 (`startApi()` refusing production with reset); merged as ae6405a |
| p5-containers | B | 3901/5073/5074, Postgres 55439 | merged | [#60](https://github.com/timothyjeffcoat/ascrum-migration/pull/60) | Re-review 2026-11-23: **DEV-p5-containers-05 fixed** (API image built from Node's import graph of `main.ts`; `check-images.sh` re-runs the graph in the image and starts it with only `DATABASE_URL`; `APP_ENV: development` beside `ALLOW_RESET`; `TRUST_PROXY_HOPS: 1` behind nginx, proven by `check-client-address.sh`). Clean clone, `--no-cache`, the CI job's steps: images 0, `up --wait` 5/5, 47/47 Playwright, client-address 0, health 0; CI `e2e-compose` green on `aa49234`. Q-1 (b) done and its test still goes red without the listener. -04, -06..-09 fixed: 9 of the first review's 10 survivors re-run red, B13 an equivalent mutant (unreachable behind `try_files`). New non-blocking follow-ups DEV-11..14 (lazy import escapes the image check; lowercase `from` / `COPY --from` / `# syntax` unpinned; credential URL in `ENV` unseen; Gitleaks pinned twice). `pnpm verify` green (435 unit, 81 integration, 41 e2e); merged as 9fd4f88 |
| p5-hardening | B→C | 4001/5173/5174, Postgres 55460 | merged | [#65](https://github.com/timothyjeffcoat/ascrum-migration/pull/65) | Review 2026-11-24, no blocking findings: DEV-p5-security-13, -15, -16, -17 and DEV-p5-containers-11..14 fixed, each with a named test or check shown red by the reviewer's own breakages (45 tried: 41 red, 4 survived). New non-blocking DEV-p5-hardening-01..05 (two pin-check bypasses, a leaked volume per check run, `createRequire()` past the lint rule, an address with a port for wave C). `pnpm verify` green (443 unit, 87 integration, 41 e2e); e2e-compose steps green (47 Playwright); CI green. Not merged (owner); merged as 995693e |
| p5-infra | C | 4101/5273/5274, Postgres 55461 | merged | [#69](https://github.com/timothyjeffcoat/ascrum-migration/pull/69) | Review 2026-11-24 and two re-reviews. Blocking DEV-p5-infra-01, -02 (fixed in f2105d1) and -10 (fixed in 9a75996); -03..-06, -09 fixed; -07, -11 accepted; -08 logged. Breakages: 72 (53 red, 19 survived), then 56 (all red), then 26 (all red). Owner O4: 15 variants, all red offline; its live checks are due on the first AWS run (journal, wave C review). Gates green on 9a75996 (web 443/87/41, infra 120 tests and synth). Not merged: the owner merges; merged as 472274a |

