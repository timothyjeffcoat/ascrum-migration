# Build Journal

A running, factual log of the migration, kept as we go so it can become the case-study README and the LinkedIn article.
Conventions: dated entries. Numbers come from measurement or are labelled as estimates. "Moments" are candidate article material. Mistakes are logged here as readily as wins (and formally in `deviations.md` from Phase 3 on).

---

## 2026-11-20 — Phase 0: Discovery

**What happened**
- The working directory was empty. I located the fork (`timothyjeffcoat/angular-app`) via `gh` and cloned it. The last real commit was 2016-04-11; the project is about a decade abandoned.
- Read every non-vendor source file: 40 JS files, 17 template files, the Grunt build, the Karma config, and the Express server. The server mattered as much as the client, because it *is* the API contract.
- Produced `spec/inventory.md` (18 routes, 13 controllers, 7 directives, 13 services/resources, 5 collections, 10 endpoints, 133 unit tests) and `spec/questions.md` (33 open questions). No design and no code, per the Phase 0 gate.

**Findings worth telling**
- **The backend can't run.** It proxies every database call to MongoLab, which shut down in 2020. Before any React is written, the migration already needs a contract-faithful API stub. Legacy migrations rarely fail on the framework; they fail on the dependencies nobody looked at.
- **The "reference app" has 20 defects** (inventory §13). Examples: saving a task sends you to the admin users page; the dashboard links build `/projects/[object Object]/…`; the "Projects info" page fetches every project and then renders only a heading; any anonymous visitor can GET the users collection, plaintext passwords included.
- **Some of the "magic" lives in the wire protocol, not the framework**: a `)]}',\n` JSON-hijack prefix and XSRF cookie/header handshake that AngularJS's `$http` handled invisibly. A naive `fetch()` port breaks on the first request, and on the first POST. Discovery made that an explicit spec item instead of a Phase 3 surprise.
- **Dead code**: about 9 units (a modal directive, an exception handler, a whole CRUD mixin) are never wired in, yet some are tested. "Has tests" ≠ "is used".
- **Test coverage is lopsided**: 133 tests, but zero for the backlog, sprint, and task screens, which are the core of the product.

**Decisions made**: none yet. Every fork in the road is a question for the human owner, by design.

**Moments (article candidates)**
- "The first useful output of an AI migration agent was a list of questions, not code."
- "Discovery found the app's database provider had been dead for six years."
- The empty `dashboard.spec.js`, a file that exists only to look tested.

**Metrics so far**
| Metric | Value | How measured |
|---|---|---|
| Source files read | 40 JS + 17 templates + build/test/server config | file listing |
| Unit tests in legacy app | 133 `it` blocks / 23 files (3 empty) | grep |
| Defects catalogued | 20 | inventory §13 |
| Open questions raised | 33 | questions.md |
| Agent sessions used | 1 (single session, no sub-agents) | — |

---

## 2026-11-20 — Tooling: machine-recorded metrics

**What happened**
- The user asked whether the CLI needed configuring to keep the journal updated. The answer: not for the journal. A hook can't write the narrative (decisions, mistakes, "why"); only the agent can, and that rule goes into CLAUDE.md in Phase 1. A hook **is** the right tool for the numbers, because agents are unreliable narrators of their own metrics.
- Added a project hook (`.claude/settings.json` → `.claude/hooks/metrics.sh`). It appends one JSON line per event to `spec/metrics.jsonl`: session start/end, every test/lint/typecheck/build/e2e/commit/PR command with pass or fail, and every sub-agent spawn. Each line is stamped with time, session, branch, commit, and worktree.
- Worktrees all write to the **main checkout's** log (resolved via git's common dir, with `flock` for concurrent appends), so parallel workers share one ledger and never merge-conflict on it.

**Mistakes caught while building it**
- The first classifier matched substrings: `git commit -m "fix build"` counted as a build, and `grep test` as a test run. Tightened it to real tool invocations and tested it against 13 sample commands.
- The live probe logged my own test harness as an "e2e" run, because the script text contained the word "playwright". That's a reminder that heuristic classification has false positives. The log keeps the raw command (first 300 chars) so any number can be audited.

**Moment**
- "The journal is the story; the metrics log is the evidence. The agent writes the first, a hook writes the second."

---

## 2026-11-20 — Phase 1: Spec

**What happened**
- The owner answered all 33 questions: 29 with "follow recommendation" (two with a refinement: Node 24; "generate the data we need to demonstrate fully"), and 4 in their own words (fix bugs = option b; one article at the end; aimed at managers; disclose agent authorship = yes). One owner choice changed the governance model: **the reviewer agent, not the human, merges** once CI is green and no blocking deviations are open.
- Wrote `spec/conversion-spec.md` (494 lines) and `CLAUDE.md` (83 lines).
  - **Stack:** React 19 (pushback on the brief's React 18, accepted), React Router v7 loaders as the 1:1 mapping for AngularJS route resolves, Vite, TypeScript strict, pnpm/Node 24.
  - **Acceptance criteria:** 69 numbered, plus a stub contract-test set. Each must be covered by a test that names its id.
  - **Defects:** of the 21 found (20 in discovery, 1 found while writing the spec), 16 will be fixed and 5 deliberately preserved. Each fix must have a test named after its defect id.
  - **Test parity:** 113 of the 133 legacy tests are portable; 20 test dead code.
- Designed the parallel phase to avoid conflicts *by construction*. The foundation cluster pre-registers every feature's route file and message key, so parallel workers never touch a shared file. Only the reviewer edits the status table, which also stops agents grading their own work.
- The spec lists 10 decisions it made **beyond** the owner's answers, for explicit sign-off, instead of slipping them in.

**Mistakes caught**
- Phase 0 docs referred twice to a question "Q-T1" that was never written: a dangling reference produced by the agent itself, caught while re-reading the answers. Fixed. The owner's answer to Q-A5 covered the intent (no executed legacy test baseline).
- While writing the acceptance criteria, found a 21st legacy defect: removing a project shows "saved successfully", because the remove handler silently falls back to the save handler. Discovery had missed it.

**Moments (article candidates)**
- "29 of 33 answers were 'follow recommendation'. That's the point: a good discovery phase turns a migration into a short list of real decisions."
- "The riskiest owner decision — letting an agent merge — is exactly what the gates exist for: green CI plus an independent reviewer that is not the author."
- "We pushed back on the brief: React 18 in late 2026 would have dated the piece on day one."

**Metrics**
| Metric | Value | Source |
|---|---|---|
| Questions answered | 33 / 33 (29 accepted recommendations) | questions.md |
| Acceptance criteria | 69 + stub contract set | conversion-spec §12 |
| Defects: fix / preserve | 16 / 5 (21 total) | conversion-spec §6 |
| Portable legacy test cases | 113 of 133 | conversion-spec §9 |
| Decisions awaiting owner sign-off | 10 | conversion-spec §0.1 |

---

## 2026-11-20 — Going public: `ascrum-migration`

**What happened**
- The owner decided to make the work public. The existing fork was already public but nothing had been pushed to it. Chose a **standalone** public repo, `ascrum-migration`, over the fork: a descriptive name and demo URL, and commits that count on the owner's profile. The full upstream history, MIT license and author credit are kept; the fork is left untouched.
- **Pre-publication privacy pass:** the metrics hook had been recording absolute local paths (machine username and folder layout) into a file that is committed. The hook now records a worktree *label*; the logged lines and one path in `questions.md` were scrubbed.
- The dead MongoLab key and TLS key already in upstream history stay visible (history is not rewritten, so the upstream lineage stays intact). The README will say so, per Q-A3.
- `migration` becomes the default branch so visitors land on the spec; `master` stays as the untouched legacy snapshot.

**Moment**
- "Before going public, the first thing to audit was our own telemetry: the metrics log built for honesty was quietly leaking local paths."

---

## 2026-11-20 — Independent review of the spec (AI reviews AI)

**What happened**
- At the owner's request, a **fresh sub-agent** reviewed the spec as a team lead about to hand it to three parallel workers. It had none of the authoring session's context: it was told *where* to look (spec, CLAUDE.md, inventory, answers, legacy source), not what the author thought. It was read-only and not allowed to reopen owner decisions. Effort: 29 tool calls, about 9 minutes (from the agent's completion notice).
- It returned **25 findings: 9 blocking, 11 important, 5 minor**, plus 19 groups of claims it had checked and found correct. The full report with a disposition per finding is in `spec/reviews/spec-review-1.md`.
- The authoring session re-verified every factual claim against the legacy source before acting. **All 25 held; none were rejected.** Spec rev 2 (710 lines) and CLAUDE.md rev 2 fix all of them.

**What it caught**
- **Mostly coordination, not React:**
  - files every worker must write that no cluster owned;
  - a single shared questions file that can't work across isolated worktrees;
  - reviewer bookkeeping that contradicts the branch protection the owner asked for;
  - no owner for shared test infrastructure.
- **An architecture deadlock:** with the login modal inside the router, reloading an admin URL while logged out would wait forever for a modal that never mounts.
- **Three places where the author misread the legacy code:**
  - "fetch all" actually sends `q={}`;
  - validation errors show without any "touched" state;
  - the current-user check repeats while anonymous.

  In each case the spec was written from memory of the code rather than the code itself.
- **A metric quietly redefined:** the owner agreed to "N of 133 tests carried over", but the spec had switched to N/113. Rev 2 restores 133 as the headline and pre-assigns 8 cases that test deliberately dropped behaviour.
- **The author's own line count was wrong:** 1,849 was JavaScript only; with templates it is 2,290.

**Decisions**
- Rev 2 adds 5 more spec-made decisions (S11–S15) to the 10 already awaiting owner sign-off. The spec status now says workers **must not start** until the owner approves §0.1. Before, it only said "awaiting review".

**Moments (article candidates)**
- "The spec's author called it ready. A second agent with a clean context found nine ways it would have failed, and most were about how agents coordinate, not about code."
- "Every factual finding was checked against the source before it was accepted. Trust the reviewer's direction, verify its evidence."
- "The review cost about nine minutes of agent time. Finding the modal deadlock after three workers had built on it would have cost a wave."

**Metrics**
| Metric | Value | Source |
|---|---|---|
| Review findings (blocking / important / minor) | 9 / 11 / 5 | spec-review-1.md |
| Findings confirmed / rejected | 25 / 0 | spec-review-1.md |
| Acceptance criteria (rev 1 → rev 2) | 69 → 76, plus 15 stub contract ACs | conversion-spec §12 |
| Spec-made decisions awaiting sign-off | 15 | conversion-spec §0.1 |
| Legacy tests pre-assigned n/a | 8 | conversion-spec §9 |
