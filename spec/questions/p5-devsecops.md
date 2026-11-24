# Questions raised by cluster p5-devsecops (Phase 5, wave A)

Ids are `Q-p5-devsecops-<n>` (Phase 5 spec §8). Each gives context, options and a recommendation.

**Q-p5-devsecops-1. The `secrets` gate cannot be a required check as specified, and push protection could not be shown to block a plant.** (blocks AC-DSO-01 for secrets)
Context: spec §6 lists "secrets: GitHub secret scanning with push protection" among the gates, and
AC-DSO-01 says each scan is a required check that a planted finding turns red. Secret scanning and push
protection are enabled on the repo, but neither produces a status check: push protection rejects the
`git push` itself, and secret scanning raises alerts after the fact. So there is nothing to mark required.
Proving the block also failed: GitHub does not document a test token for push protection, and AWS's
documented example key pair (`AKIA...EXAMPLE`, an intentionally fake credential) was **accepted** on a
throwaway branch, with no secret-scanning alert after a minute (provider patterns skip known example
values). Committing a real credential to prove the block is ruled out.
Options:
(a) Rely on push protection and alerts as they are. Record in `spec/deviations.md` that the `secrets`
    gate is a repository setting, not a required check, and that its block was not demonstrated.
(b) Add a CI job `secrets` that scans the PR's commits with an open-source scanner (for example the
    Gitleaks CLI, MIT, run as a pinned release binary with a checksum, not the licensed `gitleaks-action`),
    make it required, and prove it red with a format-valid fake token on a throwaway PR. Push protection
    stays on as the first line. This is a new tool, so it needs an answer.
(c) A home-grown `grep` job for key-shaped strings. No new tool, but weak and easy to miss things.
*Recommended: (b)*, because it is the only option that meets AC-DSO-01 as written (required, and shown red).

**Answer: (b).** Add a CI job `secrets` running Gitleaks, make it required, and prove it red on a realistic fake key. Follow-up worker work after the review; the secrets part of AC-DSO-01 is "answered, pending implementation" (DEV-p5-devsecops-01). Answer: owner, relayed by the orchestrator, 2026-11-23; recorded by the reviewer.

**Q-p5-devsecops-2. Which CodeQL check name to require.** (does not block the PR; the orchestrator applies it)
Context: the `codeql` workflow job runs the analysis and uploads results; it stays green even when it finds
something. GitHub then posts a separate check run named `CodeQL` (app `github-advanced-security`), which is
the one that fails on a new alert at or above the repo's threshold (default: errors and high/critical
security alerts). The plant (PR #42) showed exactly this: job `codeql` green, check `CodeQL` red.
Options: (a) require both `CodeQL` (fails on findings) and `codeql` (fails if the analysis itself
breaks); (b) require `CodeQL` only (it never appears if the analysis did not upload, which also blocks
the merge, but with a "waiting" state rather than a red one); (c) rename the job (for example
`codeql-analyze`) so the two names do not differ only by case, then (a).
*Recommended: (a)*; (c) is a cosmetic follow-up if the owner prefers it.

**Answer: (a).** Require both `CodeQL` (the result check) and `codeql` (the job). Reviewer note: pin `CodeQL` to its app (`github-advanced-security`, id 57789) when requiring it (DEV-p5-devsecops-02). Answer: owner, relayed by the orchestrator, 2026-11-23; recorded by the reviewer.

**Q-p5-devsecops-3. Three repo security settings are off.** (does not block; settings are the owner's)
Context, checked with `gh api` on 2026-11-23: Dependabot alerts are disabled (`vulnerability-alerts` 404),
Dependabot security updates are disabled, and private vulnerability reporting is disabled. Dependabot
*version* updates (`.github/dependabot.yml`, AC-DSO-02) work without them, and the `deps` job catches
advisories in CI. A `SECURITY.md` was not added, because the channel it should point to (private
vulnerability reporting) is off, and a personal e-mail is not allowed in the repo.
Options: (a) the owner enables all three, and a later PR adds `SECURITY.md` pointing to private reporting;
(b) leave them off and rely on the `deps` job and version updates.
*Recommended: (a)*. Alerts and security PRs are free on public repos and add a second, non-CI signal.

**Answer: (a), done.** The orchestrator enabled Dependabot alerts, Dependabot security updates and private vulnerability reporting through the GitHub API (the reviewer re-read all three as enabled). A `SECURITY.md` pointing to GitHub private vulnerability reporting is now possible and is follow-up worker work. Answer: owner, relayed by the orchestrator, 2026-11-23; recorded by the reviewer.

**Q-p5-devsecops-4. Gitleaks finds one false positive in the tree and one real (upstream) key in the history.** (blocks a green `secrets` run on the clean tree; does not block anything else)
Context: the new `secrets` job (Q-1 (b)) runs Gitleaks 8.30.1 with its default rules over the commits a PR adds and over the checked-out tree. On PR #41 the commit scan is green (5 commits, "no leaks found") but the tree scan is red on one line:
- **Tree:** `spec/worklogs/foundation.md` line 65, rule `generic-api-key`, match `accessible names: Q-foundation-1.` (the rule reads `names:` as a key name and `Q-foundation-1.` as its value). A false positive in prose. The file is outside this cluster's paths, so I did not touch it. Rewording it to `accessible names (Q-foundation-1).` or `accessible names; see Q-foundation-1.` clears it (checked locally with the same binary).
- **History** (full `git log --all`, run locally; CI does not scan full history): the same worklog line in commits 8df4797 and b04ff4d, and `server/cert/privatekey.pem` (rule `private-key`) added in upstream commit 5d8f8d0 (2013, the original angular-app's development HTTPS key) and deleted from the tree in #1 (29e69b4). It is reachable from `master`, `migration` and every branch, and has been public in the upstream project for 13 years. It is not a credential of this project. GitHub's secret-scanning alerts API lists no alerts.
Options for the tree finding:
(a) The orchestrator rewords line 65 in a one-line PR into `migration` (no ignore anywhere), then PR #41 merges `migration` and `secrets` goes green.
(b) A `.gitleaksignore` with that one fingerprint (`spec/worklogs/foundation.md:generic-api-key:65`), recorded as a deviation, and the workflow's allowlist guard changed to accept exactly that file. More machinery, and the fingerprint is line-number based, so it breaks when the file changes.
(c) Drop the tree scan and keep only the commit scan. Weaker: new Gitleaks rules would never be applied to existing content.
*Recommended: (a).*
For the history: (a) accept and record it as a deviation row (rewriting `master` is forbidden, and the key is upstream and long public); (b) nothing. *Recommended: (a).*

**Q-p5-devsecops-5. Dependabot for `/api`: not added, because the effect of a missing directory is undocumented and the right directory depends on p5-store's layout.** (does not block; needed before `api/` lands)
Context: DEV-p5-devsecops-03 asks to add `/api` to Dependabot's npm entry in a way that does not fail while `api/` does not exist. GitHub's options reference documents globbing for `directories` but says nothing about a listed directory that does not exist or a glob that matches nothing; I could not test it either, because Dependabot reads `dependabot.yml` only from the default branch (`migration`), so nothing on PR #41 exercises it. From dependabot-core's behaviour (unverified here), a missing directory makes that update job fail with "dependency file not found", which shows as an error on the repo's Dependabot page rather than as a CI failure. There is a second reason to wait: if p5-store adds a root `pnpm-workspace.yaml` with one root `pnpm-lock.yaml` (the shape plant #51 used), Dependabot must point at `/` (the workspace root), and `/web` may stop working if `web/pnpm-lock.yaml` goes away. No single entry fits both today's and that shape. (The `deps` job does not have this problem: it finds lockfiles itself, shown by plants #50 and #51.)
Options: (a) whoever lands `api/` (p5-store, or a p5-devsecops follow-up in the same wave) updates the npm entry in the same PR, to `/` for a root workspace or `directories: [/web, /api]` for separate lockfiles; the reviewer checks it. (b) Add `directories: [/web, /api]` now and accept an error on the Dependabot page until `api/` exists. (c) Add a glob now (for example `/*`) and accept that it also matches `legacy/`'s parent and other folders.
*Recommended: (a).*

**Q-p5-devsecops-6. Dependabot security updates opened a PR that edits `legacy/`.** (does not block; `legacy/` must never be modified)
Context: since Q-3 enabled Dependabot alerts and security updates, Dependabot raised 15 alerts, all in `legacy/client/package.json` and `legacy/server/package.json` (2 critical, 4 high, 8 moderate, 1 low on push of 2aae665), and opened PR #47 "bump open from 0.0.3 to 6.0.0 in /legacy/server" into `migration`. `legacy/` is the frozen reference app (CLAUDE.md: never modify it), so these PRs must never merge. I did not touch #47 or the alerts.
Options: (a) the owner closes #47 and dismisses the `legacy/` alerts as "not used in production / frozen reference", and turns off automatic security PRs (alerts stay on); the `deps` job and version updates already cover `web/` (and `api/` once it lands). (b) Keep security updates on and add `legacy/client` and `legacy/server` npm entries with `ignore: [{dependency-name: "*"}]` and `open-pull-requests-limit: 0`. GitHub's "Configuring Dependabot security updates" page says a `dependabot.yml` entry can "override the default behavior of Dependabot security updates" and shows an `ignore` rule in that role, but it does not state the effect, and it says `open-pull-requests-limit: 0` stops *version* updates only. So this needs checking after merge, with a new legacy security PR as the test. (c) Leave as is and close each PR by hand.
*Recommended: (b)* if the owner wants security PRs for `web/`/`api/`; otherwise (a).
