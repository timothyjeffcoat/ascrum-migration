# Phase 2 review: harness (PR #1, `harness/phase-2` → `migration`)

- **Date:** 2026-11-20
- **Reviewer:** an independent reviewer session (did not write any of this code)
- **Reviewed commit:** `61e8f65` (PR head)
- **Checklist:** spec §13 (deliverables 1–9 and exit criteria), with §2, §3, §7, §11 and inventory §9 as the contract.

## Method
1. Read `CLAUDE.md`, spec §0–§4, §7, §8, §11, §12.6, §13, inventory §8–§9, `spec/questions/harness.md`, and the legacy server (`legacy/server/server.js`, `lib/security.js`, `lib/xsrf.js`, `lib/protectJSON.js`, `lib/mongo-strategy.js`).
2. Ran the gates from a clean install in a separate worktree: Node v24.22.3, pnpm 12.21.0, `rm -rf node_modules && pnpm install --frozen-lockfile` (exit 0), then `set -o pipefail; pnpm verify` (exit 0). Ports 3001, 4173 and 4174 were free before the run.
3. Checked CI with `gh pr checks 1` and `gh run view 44821324380`.
4. Read every stub module and test line by line against §7 and the legacy source, then ran a throwaway probe script (scratch directory, not committed) that calls `handle()` directly to test edge cases no test covers.
5. Fed known skip and focus patterns to `eslint --stdin` to test the "mechanical" gate claims. Nothing was written to the tree.
6. Diffed the vendored LESS and assets against `legacy/`, and spot-checked the compiled CSS in `web/dist/assets/*.css`.
7. Ran hygiene greps: the old MongoLab key, private-key headers, home-directory paths and usernames in files this PR adds.
8. Compared the README, MIGRATION.md, the journal's Phase 2 entry, the spec amendments and the PR description against what I measured.

### Gate results (this session)
```
$ eslint --max-warnings 0 . && prettier --check .
All matched files use Prettier code style!
$ tsc --noEmit -p tsconfig.json
 Test Files  2 passed (2)
      Tests  21 passed (21)
✓ built in 339ms            (vite build)
✓ built in 365ms            (vite build --mode pages)
  8 passed (2.4s)           (playwright: 4 chromium + 4 pages)
verify=0
```
The two builds print 268 `[lightningcss minify] Unexpected token Semicolon` messages (134 each). The offending line is an IE star hack in all 268 (see R2-05).

CI (`gh pr checks 1`): `build` pass 16s · `e2e` pass 40s · `lint` pass 14s · `test` pass 14s · `typecheck` pass 19s.

## §13 checklist

| Item | Verdict | Evidence |
|---|---|---|
| 1. Legacy move and secrets | **pass** | `git diff -M --stat` shows `{client => legacy/client}` with 0 changed lines, and `{server => legacy/server}` with changes only in `config.js` and 3 test files (key placeholder). `server/cert/privatekey.pem` deleted. `legacy/server/config.js:6,17` hold the placeholders `REMOVED_DEAD_MONGOLAB_KEY` and `REMOVED_SET_YOUR_OWN_SECRET`. `git grep` for the full original key at HEAD finds nothing, and `git grep 'PRIVATE KEY' HEAD` finds nothing. |
| 2. Scaffold per §3 | **pass** | `web/` contains `index.html` and every config named in §3. `public/` holds favicon, spinner and both glyph sprites, byte-identical to `legacy/client/src/assets` (`cmp`), plus `mockServiceWorker.js`. `src/styles/variables.less:135-136` rewrites `/static/img/…` to `/img/…`. `main.tsx` is a placeholder plus the MSW bootstrap. (`docs/article/` from §3 does not exist yet; it is Phase 4 material, so this is not a finding.) |
| 3. Scripts | **pass** | `web/package.json:10-22` has all ten scripts. `verify` = lint && typecheck && test && e2e, and `e2e` = build && build:pages && playwright, so `verify` covers build. |
| 4. Stub per §7 | **pass, with findings** | `stub/handlers.ts` follows the §7.1 shape and the §7.2 order (XSRF :84, auth :129-134, routing :137). All 15 AC-STUB ids have a named test in `stub/handlers.test.ts:62-319`, and each test asserts its rule non-vacuously (details below). Both adapters exist (`stub/server.ts`, `stub/msw.ts`). The seed matches §7.6 (6 Webshop, 3 Mobile and 0 Legacy backlog items; 2/1/0 sprints with one dangling id; 12 Webshop tasks in all 5 states, 4 unassigned; Mobile sprint 1 has 0 tasks; Legacy Cleanup has no `teamMembers`). Findings: R2-06, R2-08, R2-09. |
| 5. Test infrastructure | **pass** | `src/test/setup.ts` (jest-dom, `server.listen({onUnhandledFrame:'error'})`, `resetStub()` in `beforeEach`). `src/test/server.ts` (shared `setupServer` built from the real handlers). `src/test/stubControl.ts` (`resetStub()`, `failNext(method, pattern, status)` with `{once:true}`). All three are exercised by `stub/adapters.test.ts:180-216`. |
| 6. CI | **pass** | `.github/workflows/ci.yml` has five jobs named `lint`, `typecheck`, `test`, `build`, `e2e`. It triggers on `pull_request` and on push to `migration`. Node comes from `web/.nvmrc` (24) and pnpm from `packageManager`, via `.github/actions/setup-web`. Run 44821324380 is green on all five. Branch protection is not set yet (`gh api …/branches/migration/protection` → 404); per E4 the owner sets it after Phase 2. |
| 7. Pages workflow | **pass (file); deploy not yet run** | `.github/workflows/pages.yml` runs `build:pages` and deploys `web/dist-pages` on push to `migration`. Repo Pages is configured with `build_type: workflow`. The `github-pages` environment's branch policy allows `migration`. See R2-12. |
| 8. Docs | **pass** | `MIGRATION.md` lists all 6 clusters as `pending`, with the gates closed. `spec/deviations.md` has a header whose columns match the §8.4 format. `spec/worklogs/README.md` and `spec/questions/README.md` (+ `harness.md`) exist. The README has the WIP banner, credits, the secrets/history note, and demo credentials that match `stub/seed.ts:46-53`. |
| 9. Risk proofs §11-1, -2, -3, -5, -6 recorded in the journal | **fail (partial)** | §11-1: `e2e/harness.spec.ts:37`. §11-2: `e2e/pages/pages.spec.ts:22` plus `stub/adapters.test.ts:186`. §11-3: `pages.spec.ts:8`. §11-6: `harness.spec.ts:44` and `pages.spec.ts:14`. All are genuine (see below). **§11-5 is not recorded**: the journal metrics row says only "-5 is the CI timing", with no number (R2-02). The §11-1 proof misses the patched mixins (R2-07). |
| Exit: CI green on the Phase 2 PR | **pass** | `gh pr checks 1`: 5/5 pass. |
| Exit: Pages demo serves the placeholder at a deep link | **not yet verifiable** | Pages deploys only from `migration`. `curl` of `https://<owner>.github.io/ascrum-migration/projects/123` returns 404 today (nothing deployed yet). The local Pages mimic proves the mechanism (`pages.spec.ts:8`). Re-check after merge, before opening the cluster-0 gate. |
| Exit: no MongoLab key or private key outside git history | **pass, with a caveat** | The full key and any private key are absent from the tree. However, `spec/metrics.jsonl` row 22 (added by this PR) quotes the key's first 8 hex characters in a logged `git grep` command. That is harmless on its own (the key is dead and the full key is in public history), but it is cleaned up by the same fix as R2-01. |
| Exit: reviewer sign-off | **withheld** | Blocked on R2-01 and R2-02. |

### AC-STUB tests: do they genuinely assert the rule?
| AC | Verdict | Note |
|---|---|---|
| 01 | genuine | checks the prefix string, Content-Type and parse (`handlers.test.ts:62-67`); the `body()` helper re-checks the prefix on every response used elsewhere |
| 02 | genuine | same token on GET/POST/404 within a session; a different token for another session. It does not check the 401/403/400 paths, but the code sets the cookie on them (`handlers.ts:81`) |
| 03 | genuine | `/login` without the header → 403 `Forbidden` text/plain; anonymous POST gets 403 rather than 401 (proves XSRF precedes auth); a wrong token → 403; GET is unaffected |
| 04 | genuine | bad password → 200 `{user:null}`; unknown email → `{user:null}`; success returns the exact `filterUser` shape and the session persists |
| 05, 06 | genuine | |
| 07 | genuine | `{}`, no q, single and ANDed equality, `$in` with a dangling id, empty `$in` → `[]`, and 8 rejected shapes, each 400 with `{message}` |
| 08, 09, 13 | genuine | 09 proves replace semantics (dropped fields are gone) and 404 on GET/PUT/DELETE of a deleted id |
| 10 | genuine | 3 anonymous write methods → 401 `{user:null}`; PO → 401 `{user}` on users and projects; PO can write tasks (D15); admin can write projects |
| 11 | genuine | scans 8 responses (list, by-id, query, POST, PUT, DELETE, login, current-user) for `password`, `changeme`, `"demo"` and `secret` |
| 12 | genuine | proven through login: an omitted password keeps the old one, and an explicit one replaces it |
| 14 | genuine | handler level (`handlers.test.ts:288`) and in the real Pages bundle (`pages.spec.ts:44`), where a registered route would have returned 204 |
| 15 | genuine | two full runs compare equal; the first generated id is pinned; a fresh store equals a reset store |

### Risk proofs: could any pass while the risk is still real?
- **§11-1:** not for division. Without `math:'always'`, `margin: 0 0 20px / 2` is invalid, so the test would read 14px instead of 10px. **However**, nothing tests the three syntax patches (span/offset interpolation, the `.box-shadow` overloads, the navbar width). A regression there would pass every gate (R2-07). Also, `errorRecovery` would hide a newly broken declaration (R2-05).
- **§11-2:** no. In the Pages build the adapter's fallback is off (`main.tsx:295`), so the XSRF token can only reach `document.cookie` through MSW itself. Without it, the second `/login` would be 403 and `JSON.parse('Forbidden')` would throw. The `sid` round-trip is proven by `/current-user` returning the user.
- **§11-3:** proven against `scripts/pages-server.ts`, a faithful local mimic (404 status + `404.html`, `/ascrum-migration/` base). It also covers service-worker control of a page that was served with a 404 status. Real GitHub Pages is the remaining unverified part (exit criterion above).
- **§11-6:** no. Both bases assert the resolved sprite path *and* a 200 fetch of it.

## Findings

| Id | Severity | Finding | Evidence | Suggested fix |
|---|---|---|---|---|
| R2-01 | **blocking** | **Privacy leak in a tracked file added by this PR.** `spec/metrics.jsonl` rows 9 and 23 record raw shell commands containing absolute home-directory paths, which include the local OS username and the project folder name. That breaks CLAUDE.md "never write absolute local paths, usernames… into tracked files". Row 22 also quotes the first 8 hex characters of the old MongoLab key. The hook (`.claude/hooks/metrics.sh:60`) logs `.tool_input.command` verbatim with no redaction, so every future session (workers and reviewers included) will keep leaking. | `grep -c` for the home prefix on `spec/metrics.jsonl` → 2, and both rows were added in commit `61e8f65`. The same grep on `origin/migration:spec/metrics.jsonl` → 0. Hook line 60: `command:(.tool_input.command|.[0:300])`. | Make the hook redact before writing (replace `$HOME`, `$CLAUDE_PROJECT_DIR` and the temp-dir prefix with placeholders; or drop `command` and keep only `category`/`status`). Then, as an owner-approved one-off (CLAUDE.md forbids hand edits of the ledger, so record the exception in the journal), scrub rows 9, 22 and 23 on this branch. History on a PR branch squashes away, so no rewrite of `migration` is needed. |
| R2-02 | **blocking** | **§13 item 9 not met for §11-5.** The spec requires §11-5 (Playwright in CI: browser install time) to be *recorded in the journal*. The journal has no number. It also says "Every risk the spec flagged for Phase 2 now has a test that proves it", but §11-4 is deferred to cluster 0 and §11-5 is a measurement, not a test. | `spec/journal.md` Phase 2 metrics row: "(§11-1, -2, -3, -6; -5 is the CI timing)". The measurement exists: run 44821324380, e2e job, step "Install Chromium (spec §11-5 measures this step)" 21:33:21→21:33:43 = **22 s**; whole e2e job 40 s; `pnpm e2e` step 5 s. | Add the §11-5 measurement with its run id to the journal. Reword the "every risk" sentence to name §11-4 (cluster 0) and §11-5 (measured, not tested). |
| R2-03 | important | **The approved contract was amended on unanswered questions.** §2 (version pins, citing Q-harness-1/-2), §7.3 (reset skips XSRF, Q-harness-4) and §11-1 (patches + `errorRecovery`, Q-harness-3) now cite questions whose **Answer:** lines are empty. §8.5.2 has the spec amended through the PR that commits the owner's answer. Workers will treat these amendments as signed-off contract. | `spec/questions/harness.md`: four empty `**Answer:**` lines; `git diff origin/migration...HEAD -- spec/conversion-spec.md` hunks at §2, §7.3, §11. | Get the four answers and commit them (on this PR or a small follow-up) before the Phase 2 exit gate opens; add "Q-harness-1..4 answered" to the MIGRATION.md Phase 2 exit row. |
| R2-04 | important | **The "mechanical" skip ban has holes.** CLAUDE.md (amended in this PR) says "`.only/.skip/.todo` … are lint errors". The `no-restricted-syntax` selector (`eslint.config.js:30-33`) only matches `it/test/describe.<x>(` called directly on an identifier. All of these pass lint and still skip at run time: `it.skipIf(…)`, `it.runIf(…)`, `it.concurrent.skip`, Playwright `test.describe.skip` and `test.describe.fixme`. Vitest `allowOnly:false` and Playwright `forbidOnly` cover only `.only`. | `eslint --stdin --stdin-filename src/probe.test.ts` over those patterns flagged only `describe.skip`, `it.todo`, the inline-disable warning and `as any`. The other 5 skip forms (plus `xit`/`xdescribe`, which would fail typecheck instead) produced no error. | Broaden the selector to any member chain on `it/test/describe` whose property is `only|skip|todo|fixme|skipIf|runIf`, at any depth (e.g. `MemberExpression[property.name=/^(only|skip|todo|fixme|skipIf|runIf)$/]` under a callee rooted at those identifiers). Add a fixture test for the lint rule, or keep the claim in CLAUDE.md exact. |
| R2-05 | important | **`lightningcss.errorRecovery: true` turns every CSS syntax error into a warning**, not just the IE star hacks it was meant for. Today all 268 recovered errors are star hacks, so nothing is hidden, but a future broken declaration would pass `build` silently. That is a loosened gate by CLAUDE.md's definition, and its only approval is the unanswered Q-harness-3. | `vite.config.ts:26`; the verify log has 268 × `Unexpected token Semicolon`, and the offending line contains `*` in all 268. | Prefer removing the star hacks from the vendored copy (another commented patch, like Q-harness-3's) and dropping `errorRecovery`. Otherwise, assert the recovered-error count in a build check so a new error fails. |
| R2-06 | important | **Login matches a missing or blank password**, unlike legacy. The stub compares `u.password === creds.password` (`handlers.ts:108-110`). A user created without a password logs in with `{email}` alone, and a user whose password is `""` logs in with `""`. Legacy authenticates through a passport-local `LocalStrategy` (`legacy/server/lib/mongo-strategy.js:15`, verify at :61-64). Upstream passport-local fails a request with a missing or empty username or password before it calls verify, and the custom callback then answers `{user:null}`. S8 merges the stored password only when `password === undefined` (`handlers.ts:172`), so a users PUT that sends `password: ""` (a plausible "blank = unchanged" bug in cluster 1) stores a blank password that then works. No test pins credential presence. | Probe against `handle()`: create `{email:'nopw@x',…}` then `POST /login {email:'nopw@x'}` → 200 `{user:{…}}`; `PUT users/<dev1> {password:''}` → stored; `POST /login {email,password:''}` for a blank-password user → 200 `{user:{…}}`. | Require non-empty string email and password in `/login` (fail → `{user:null}`, as legacy does), and add those cases to AC-STUB-04. Optionally record in a question whether S8 should also treat `""` as "unchanged". |
| R2-07 | important | **A Q-harness-3 claim is not true, and the LESS patches are untested.** Q-harness-3 says "Spot checks … `.span12` = 940px, `.offset1` = 100px, multi-shadows keep their commas. **Playwright asserts the computed styles.**" No test asserts any of these. `probeStyles` reads only `p` margin, `.close` opacity and the icon URL. I checked the compiled CSS by hand and the values *are* correct today (`.span12{width:940px}`, `.offset1{margin-left:100px}`, `box-shadow:inset 0 1px 1px #00000013,0 0 8px #52a8ec99`, navbar container 940px). | `e2e/support.ts:12-26`; `grep -rn 'span12\|offset1\|box-shadow' web/e2e web/src web/stub` → no test hits. | Add `.span12`, `.offset1`, a two-shadow element (e.g. `input:focus` or `.btn-group.open .dropdown-toggle`) and `.navbar-fixed-top .container` to `probeStyles` and assert them in the §11-1 test; or correct the sentence in `spec/questions/harness.md`. |
| R2-08 | minor | **Non-GET auth is narrower than legacy.** Legacy requires a session for any data-path method other than GET (`legacy/server/server.js:45`), so HEAD, PATCH and OPTIONS are covered too. The stub treats only POST/PUT/DELETE as writes (`handlers.ts:128`): an anonymous PATCH with a valid token → 404 `Document not found` (legacy: 401 `{user:null}`), and HEAD on a collection → 404 (legacy: 401). The client never sends these, so the impact is nil today. | Probe: `PATCH …/tasks/x` → 404; `HEAD …/users` → 404. | Either mirror legacy (`method !== 'GET'` → auth), or state in §7.3 that methods other than GET/POST/PUT/DELETE get 404. |
| R2-09 | minor | **Password oracle through `q`.** Responses are stripped (AC-STUB-11 holds), but `GET users?q={"password":"changeme"}` returns the admin document, so the query confirms a password. That runs against the intent of the D7 fix. | Probe: `q={"password":"changeme"}` → `[admin]`; `q={"password":"wrong"}` → `[]`. | Reject `password` as a query field on `users` (400 `{message}`; no live legacy query uses it per inventory §9.3), and add it to AC-STUB-07's or -11's bad list. |
| R2-10 | minor | **Small numeric mismatches in the journal and PR.** "Gate runs recorded by the hook 16 / 1": the committed ledger has 15 gate-category rows (lint 1, typecheck 1, test 3, build 4, e2e 6), 1 of them failed. "1,382 lines": the TS/TSX in `web/{src,stub,scripts,e2e}` is 1,388. "4 Playwright tests" for risk proofs: there are 5 §-labelled Playwright tests (§11-1, §11-6 ×2, §11-3, §11-2). "7.4 s" for `pnpm verify` was not reproduced; I did not time my run. | `python3` tally of `spec/metrics.jsonl`; `git ls-files … \| xargs wc -l` → 1388; the Playwright list output above. | Correct the numbers, or label them "at time of writing". |
| R2-11 | minor | **`e2e/pages/pages.spec.ts` does not start with `POST /__stub/reset`**, contrary to spec §2 and CLAUDE.md ("Each e2e file starts with POST /__stub/reset"). The omission is correct, because the route is absent from the Pages build and each test gets a fresh in-browser store, but the exception is undocumented, so a later reviewer will flag it. | `pages.spec.ts` has no `beforeEach`; `harness.spec.ts:33-35` does reset. | Add a one-line comment in the file and an exception note in CLAUDE.md's e2e rule. |
| R2-12 | minor | **Pages deploys on any push to `migration` without waiting for CI.** Until the owner enables branch protection (currently none), a red commit could be published as the demo. | `pages.yml:4-7` (`on: push`); `gh api …/branches/migration/protection` → 404 "Branch not protected". | Trigger on `workflow_run` of CI with `conclusion == success`, or make enabling branch protection an explicit item on the Phase 2 exit gate in MIGRATION.md. |
| R2-13 | minor | **Local e2e may reuse a stale stub.** `reuseExistingServer: !CI` means a `pnpm dev` or `pnpm stub` already listening on 3001 (possibly older code) is reused, so local e2e and `pnpm verify` would test that process instead of the branch's stub. CI is unaffected. | `playwright.config.ts:31-37`. | Use `reuseExistingServer: false` for the stub (it starts in under a second), or document it next to the `pnpm verify` row in CLAUDE.md. |

## Verdict
**Changes requested (2 blocking, 5 important, 6 minor).** The engineering is solid. All gates pass from a clean install and in CI. The stub matches §7 and the legacy server on every rule the spec names. All 15 AC-STUB tests genuinely assert their rules. The risk proofs for §11-1/-2/-3/-6 are non-vacuous.

The two blocking items are both cheap and touch no product code:
- **R2-01:** redact the metrics hook and scrub the three ledger rows.
- **R2-02:** record the §11-5 measurement (22 s Chromium install, run 44821324380).

I recommend resolving R2-03 (owner answers to Q-harness-1..4) before the Phase 2 exit gate opens, since workers will treat the amended spec as signed off. R2-04 to R2-07 should be fixed before cluster 0 starts, because they protect the gates Phase 3 depends on. After the blocking fixes, the remaining exit criterion is the live Pages deep link, which can only be checked after merge.

## Author disposition (orchestrator, 2026-11-20)
| Id | Disposition |
|---|---|
| R2-01 | **Fixed.** The hook rewrites `$HOME` to `~` in every logged string and, since the scrub, also masks Claude Code's temp dir as `<claude-tmp>` (its name encodes the home path, so the username leaked a second way). With the owner's approval (2026-11-20) the existing rows were scrubbed once by a script: home paths and temp dirs masked, the dead-key fragment replaced by `<redacted>`, and the fake probe row dropped (41 → 40 rows). The earlier PR commits still hold the old rows; the squash merge keeps them out of `migration`. |
| R2-02 | Fixed: the §11-5 timings are in the journal, and the "every risk" claim is reworded. |
| R2-03 | **Fixed.** Owner confirmed Q-harness-1..4 as implemented (2026-11-20). The stale `errorRecovery` sentence in Q-harness-3 now describes the PostCSS plugin. |
| R2-04 | Fixed: `eslint.config.js` bans the skip/only/todo/fixme/skipIf/runIf forms, including chained ones; probe catches 7 of 7. |
| R2-05 | Fixed: `errorRecovery` removed; a PostCSS plugin drops only `*`-prefixed declarations. |
| R2-06 | Fixed: an empty or missing email or password fails login; AC-STUB-04 extended. |
| R2-07 | Fixed: new e2e test `Q-harness-3` asserts `.span12`, `.offset1`, the navbar container width and the two-shadow `.btn`; mutation-checked. |
| R2-08 | Fixed: every non-GET data request needs a session user, as legacy `server.js` does; AC-STUB-10 covers PATCH and HEAD. |
| R2-09 | Fixed: `password` is rejected as a query field; AC-STUB-07 covers it. |
| R2-10 | Fixed: numbers corrected in the journal, originals noted. |
| R2-11 | Fixed: a comment in `pages.spec.ts` and a CLAUDE.md note. |
| R2-12 | Fixed: Pages deploys on `workflow_run` after CI succeeds on a push to `migration`. |
| R2-13 | Fixed: Playwright never reuses servers. |

## Re-review (sign-off), 2026-11-20
- **Reviewer:** a second independent reviewer session (did not write the code or the first review).
- **Reviewed commit:** `98fcf89` (PR head). Each disposition above was checked against the code, docs and commands, not against its description.

| Id | Status | Evidence |
|---|---|---|
| R2-01 | verified fixed | Committed `spec/metrics.jsonl` (40 rows): 0 hits for the home prefix, the local username, `-home-`, any ≥6-char substring of the old key, or `session:"probe"`; every row parses as JSON. `.claude/hooks/metrics.sh:76` was run on synthetic strings (not through the hook): `$HOME/...` → `~/...`, `/tmp/claude-<uid>/-home-<user>-…/x` → `<claude-tmp>/x`, nested strings included. Residual gaps: R2-14. |
| R2-02 | verified fixed | `spec/journal.md` metrics row "§11-5 … 22 s / 5 s / 40 s, CI run 44821324380" matches `gh run view` (Install Chromium 21:33:21→21:33:43). The "every risk" sentence now excludes §11-5. |
| R2-03 | verified fixed | `spec/questions/harness.md`: all four **Answer:** lines filled (owner, 2026-11-20); the Q-harness-3 text describes the PostCSS plugin. |
| R2-04 | verified fixed | Throwaway lint probe (deleted): `it.only`, `it.skip`, `it.todo`, `describe.skip/only/skipIf`, `test.skipIf`, `test.runIf`, `it.concurrent.only/skip`, `describe.concurrent.skip`, `suite.skip` all error. Residual gaps: R2-15. |
| R2-05 | verified fixed | `vite.config.ts` has no `errorRecovery`; `dropIeStarHacks()` removes only `*`-prefixed declarations. This verify run: 0 `Unexpected token` messages, 0 star hacks in `dist/assets/*.css`. |
| R2-06 | verified fixed | `stub/handlers.ts:108-113` requires non-empty string email and password; `handlers.test.ts:114-119` covers `''`, a missing password, `{}` and no body for a blank-password user. |
| R2-07 | verified fixed | `e2e/harness.spec.ts:17` asserts `.span12` 940px, `.offset1` 100px, navbar container 940px and the two-shadow `.btn`; passes in this run. |
| R2-08 | verified fixed | `handlers.ts:132` `isWrite = method !== 'GET'`; AC-STUB-10 adds PATCH and HEAD → 401. |
| R2-09 | verified fixed | `stub/query.ts:46-48` rejects `password` for every collection; AC-STUB-07 bad list includes it. |
| R2-10 | verified fixed | Journal: 1,431 lines (`wc -l` over tracked TS/TSX in those dirs = 1431); 6 Playwright risk tests (matches the list below); 15 / 1 gate rows, original value noted. |
| R2-11 | verified fixed | Comment at `e2e/pages/pages.spec.ts:4-5`; CLAUDE.md e2e rule names the `e2e/pages/` exception. |
| R2-12 | verified fixed | `pages.yml` triggers on `workflow_run` of `CI` (the name in `ci.yml`), branch `migration`, and the job runs only for `conclusion == success` and `event == push` (or manual dispatch), checking out `head_sha`. The repo default branch is `migration`, so `workflow_run` will fire. |
| R2-13 | verified fixed | `playwright.config.ts`: no `reuseExistingServer` on any of the three servers (default false). |

### New findings (non-blocking)
| Id | Severity | Finding | Suggested fix |
|---|---|---|---|
| R2-14 | important | The hook's redaction misses two username paths. (1) `~/.claude/projects/-home-<user>-<project>/…`: after `$HOME` → `~`, the encoded `-home-<user>-` segment survives (synthetic test). (2) The command is cut to 300 characters *before* redaction, so a home path straddling character 300 leaves a partial path that no longer matches `$HOME`. No row in the ledger is affected today. | Redact before truncating, and also mask any `-home-[^/\s"]*` and `/home/[^/\s"]+` segment. Fix before cluster 0 starts. |
| R2-15 | minor | The lint ban is still bypassable: chains 3 deep (`test.describe.serial.skip`, `it.sequential.concurrent.skip`), computed access (`it['skip']`), aliases and fixtures (`const t = test.extend({}); t.skip`, `import {test as pw}`), runtime skips (`ctx.skip()`, `testInfo.skip()`), and `it.fails`. CLAUDE.md already says "most of these", so the claim is accurate. | Optional: match any member chain rooted at a test function, at any depth. Meanwhile, cluster reviewers should grep for these forms (§8.2 "no gate weakened"). |

### Gates (this session)
Ports 3001/4173/4174/5173 were free. Node v24.22.3, pnpm 12.21.0, `pnpm verify` unpiped, exit 0:
```
All matched files use Prettier code style!
 Test Files  2 passed (2)
      Tests  21 passed (21)
✓ built in 296ms            (vite build)
✓ built in 338ms            (vite build --mode pages)
  9 passed (2.5s)           (playwright: 5 chromium + 4 pages)
verify exit=0
```
CI on `98fcf89` (`gh pr checks 1`): build, e2e, lint, test, typecheck all pass (run 44867860934).
Hygiene: `git grep` at HEAD finds no home paths, local username, Claude temp dirs (apart from the hook's own pattern), private keys, tokens or key fragments. The only emails are the legacy demo credentials (`admin@abc.com`) and the seed's `*.test` addresses.

### §13 checklist
Items 1–8 still pass. Item 9 now passes (§11-5 recorded). The remaining exit criteria are unchanged: the live Pages deep link can only be checked after the merge, and branch protection is the owner's step (E4).

**Verdict: signed off.** R2-01..R2-13 are verified fixed. R2-14 and R2-15 do not block the merge; R2-14 should be fixed before cluster 0 starts.
