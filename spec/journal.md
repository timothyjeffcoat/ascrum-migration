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
