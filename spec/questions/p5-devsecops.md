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
