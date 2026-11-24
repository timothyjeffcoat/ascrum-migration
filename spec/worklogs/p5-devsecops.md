# Worklog: p5-devsecops (Phase 5, wave A)

Branch `convert/p5-devsecops` from `migration` at bbf73a5. Owned paths: new workflows under
`.github/workflows/`, `.github/dependabot.yml`, `SECURITY.md`, this worklog and
`spec/questions/p5-devsecops.md`. Contract: Phase 5 spec §1 G6, §5.5 (AC-DSO-01/02), §6, §9 Q-p5-7.

## 2026-11-23: session 1

### What was done
- `.github/workflows/codeql.yml`: CodeQL advanced setup, languages `javascript-typescript` and `actions`
  (the latter checks the workflows themselves), `build-mode: none`, `security-extended` queries. Runs on
  PRs, pushes to `migration` and weekly. One job, `codeql`, with `security-events: write` set explicitly
  so Dependabot PRs can upload results. Default setup was `not-configured`, so there is no clash.
- `.github/workflows/deps.yml`: job `deps`, `pnpm audit --audit-level high` in `web/`, on PRs, pushes to
  `migration` and daily (advisories appear without repo changes). Threshold **high**: the same bar §6 sets
  for image-scan. No `--ignore-registry-errors`: an audit that could not run is not a pass.
- `.github/dependabot.yml`: npm (`/web`) and GitHub Actions (`/` plus the composite
  `.github/actions/setup-web`), weekly, `target-branch: migration`. Minor and patch npm updates are
  grouped; majors come one PR each. No auto-merge, so every update goes through the same required checks
  (AC-DSO-02).
- `SECURITY.md` not added (optional): private vulnerability reporting is off, so there is no channel to
  point to without a personal e-mail. See Q-p5-devsecops-3.

### Clean tree
- Local `pnpm audit` on the unchanged lockfile: `No known vulnerabilities found` (exit 0), at every level.
  Nothing to record or ask about.
- PR #41 (this branch), first push 5125c1a:
  - `deps` green: https://github.com/timothyjeffcoat/ascrum-migration/actions/runs/45305887144
  - `codeql` job green: https://github.com/timothyjeffcoat/ascrum-migration/actions/runs/45305886866
  - `CodeQL` check green, "No new alerts in code changed by this pull request":
    https://github.com/timothyjeffcoat/ascrum-migration/runs/138149867120 . The code-scanning alerts
    API returned no alerts at all for `refs/pull/41/merge`, so the existing tree is clean under
    `security-extended`, not only the diff.

### Planted findings (AC-DSO-01)
Each plant was a throwaway branch and draft PR into `migration`, closed unmerged with its branch deleted.

| Scan | Plant | PR | Result | Run |
|---|---|---|---|---|
| CodeQL | `web/stub/plantCodeql.ts`: `node:http` request URL concatenated into `child_process.exec` | #42 | **red**: check `CodeQL` failed, "1 new alert including 1 critical severity security vulnerability", rule `js/command-line-injection`. The `codeql` *job* stayed green (see below) | https://github.com/timothyjeffcoat/ascrum-migration/runs/138150160471 (job: https://github.com/timothyjeffcoat/ascrum-migration/actions/runs/45305914262) |
| deps | `lodash@4.17.20` added to `web/` (GHSA-35jh-r3h4-6jhm and GHSA-r5fr-rjxr-66jc, both high) | #43 | **red**: "4 vulnerabilities found / Severity: 2 moderate \| 2 high", exit code 1 | https://github.com/timothyjeffcoat/ascrum-migration/actions/runs/45305944666 |
| secrets (push protection) | AWS's documented example key pair (`AKIA...EXAMPLE` and its example secret) in a new `.ini` file, branch `plant/p5-devsecops-secrets` (commit 2c38288), no PR | none | **not red**: the push was accepted, and the secret-scanning alerts API showed 0 alerts a minute later. Branch deleted straight after | none (push protection makes no run). Q-p5-devsecops-1 |

### Findings, mistakes and wrong turns
- **The CodeQL job does not fail on findings.** `github/codeql-action/analyze` uploads SARIF and
  succeeds; the red signal is the separate `CodeQL` check run that GitHub posts. Requiring only the job
  would have let the plant merge. Which name(s) to require: Q-p5-devsecops-2.
- The CodeQL plant also failed `lint` on PR #42 (as any stray file would). That is not evidence for
  CodeQL and is not counted.
- **The secrets plant did not turn anything red.** I expected AWS's documentation example key to be a safe
  way to test push protection; GitHub (rightly) ignores known example values, so it proved nothing. A
  real-format but fake token was not tried: GitHub documents no test token, and inventing one that the
  provider pattern accepts edges towards committing credential-shaped material to a public repo. The
  branch existed on the remote for about two minutes. Raised Q-p5-devsecops-1 instead.
- **Threshold semantics only half-checked.** `--audit-level high` failed the job when highs were present
  (plant above). I tried to confirm that a tree with only *moderate* advisories passes, but each old
  package I tried (`nanoid@3.1.30`, `postcss@8.4.30`, in a throwaway project in the session scratch dir)
  now also carries high advisories, so that half is untested. pnpm's help says the flag limits what is
  printed; with highs present the exit code was 1 either way.
- A first `gh pr checks` call ran from the scratch dir instead of the worktree and failed ("not a git
  repository"); rerun from the worktree.
- AC-DSO-02 can only be shown after merge: Dependabot reads `dependabot.yml` from the default branch
  (`migration`). The first Dependabot PRs and their checks are the reviewer's/orchestrator's evidence.

### Checks to make required on `migration` (orchestrator applies, with the owner's OK)
- `deps` (workflow Deps, job `deps`)
- `CodeQL` (code-scanning check run, app `github-advanced-security`; the one that goes red on findings)
- `codeql` (workflow CodeQL, job `codeql`; red if the analysis itself fails). See Q-p5-devsecops-2.
- `secrets`: none exists yet; Q-p5-devsecops-1.

### Questions
- Q-p5-devsecops-1 (blocking for the secrets part of AC-DSO-01).
- Q-p5-devsecops-2, Q-p5-devsecops-3 (not blocking).

### Gates (run in this session, from `web/`, ports 3701/4873/4874)
No app code changed. `pnpm verify`, exit 0:
```
All matched files use Prettier code style!
 Test Files  41 passed (41)
      Tests  406 passed (406)
✓ built in 346ms
✓ built in 368ms
  37 passed (13.1s)
```
(`tsc --noEmit` printed nothing, i.e. no errors.)
