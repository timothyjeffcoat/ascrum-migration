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

## 2026-11-23: session 2 (follow-up after review)

Picked up the reviewer's commits (94f99e1, fd387e8, 8efb3ba). Follow-ups from the owner's answers
(Q-1 (b), Q-2 (a), Q-3 done) and DEV-p5-devsecops-01, -03, -04. The deviation rows and the
`MIGRATION.md` row are the reviewer's and were not edited.

### What was done
- **`.github/workflows/secrets.yml`, job `secrets` (Q-1 (b), DEV-01).** Gitleaks **8.30.1** (released
  2026-03-21), the release binary for linux x64, downloaded by URL and checked with `sha256sum --check`
  against the SHA-256 from the release's `checksums.txt` (551f6fc8…70eb, also verified locally). Two
  scans: the commits the change adds (`base..head` of the PR, `before..after` of a push; a merge from
  the base drops out because the base already has those commits) and the checked-out tree
  (`gitleaks dir`). The tree scan runs even when the commit scan fails, so one run reports both.
  `--redact` keeps secrets out of the log. Weekly schedule (tree only). Muting guard: a tracked
  `.gitleaks.toml` or `.gitleaksignore` fails the job with "needs an owner-approved deviation", and
  `--ignore-gitleaks-allow` disables inline `gitleaks:allow` comments.
  - **Licence:** the Gitleaks CLI is MIT (the `LICENSE` in the release tarball: "MIT License, Copyright
    (c) 2019 Zachary Rice"), so it is fine for a personal public repo. The `gitleaks/gitleaks-action`
    wrapper has its own terms: free for personal accounts, a licence key for organisation accounts. It
    is not used: the binary needs no token, no licence and no third-party action, and is pinned by hash.
- **`deps.yml` (DEV-03, DEV-04).** No longer runs in `web/` only, and no longer uses `setup-web` (the
  audit reads the lockfile; no install needed). Steps:
  1. *No audit ignores in any pnpm config*: every tracked `pnpm-workspace.yaml`, `package.json`, `.npmrc`
     and `.pnpmrc` outside `legacy/` is grepped (case-insensitive) for `auditConfig`/`audit-config` and
     `ignoreGhsas`/`ignoreCves`/`ignoreUnfixable` in any spelling. A match fails with: "Ignoring an
     advisory mutes the deps gate, so it needs an owner-approved deviation (an answered
     Q-<cluster>-<n> and a row in spec/deviations.md) and a reviewed change to this workflow, not a
     config entry."
  2. *Every pnpm project is covered by an audited lockfile*: fails if a `package-lock.json`,
     `npm-shrinkwrap.json`, `yarn.lock` or `bun.lock(b)` is tracked outside `legacy/`, if there is no
     `pnpm-lock.yaml`, or if any `package.json` outside `legacy/` is not an importer of the nearest
     tracked `pnpm-lock.yaml` at or above it (read from the lockfile's `importers:` keys).
  3. pnpm and Node versions come from the root `package.json`/`.nvmrc` once they exist, otherwise from
     `web/`. So nothing needs editing when the root workspace arrives.
  4. `pnpm audit --audit-level high` in every lockfile's directory; any failure fails the job.
- **`SECURITY.md` (Q-3).** Points to GitHub private vulnerability reporting (Security tab → "Report a
  vulnerability"), no e-mail. Re-read with `gh api …/private-vulnerability-reporting`: `{"enabled":true}`.
- **Dependabot `/api`: not added.** See Q-p5-devsecops-5.
- Local checks before pushing: each `deps` step script, extracted from the YAML, run against eight
  scratch clones: clean (pass, `dirs=web`); `api/` with its own lockfile and lodash 4.17.20 (audit
  fails in `api`); root workspace with `api/` importer (audit fails in `.`); `api/package.json` without
  a lockfile (coverage fails); a `package.json` that is not a workspace importer (coverage fails); a
  `package-lock.json` (coverage fails); `ignoreGhsas` in `web/pnpm-workspace.yaml` and `ignoreCves`
  in `web/package.json` (ignore step fails).

### Clean tree (PR #41, head 2aae665)
- `deps` **green**: https://github.com/timothyjeffcoat/ascrum-migration/actions/runs/45308425625
  (`web/package.json: importer '.' of web/pnpm-lock.yaml`, `No known vulnerabilities found`).
- `secrets` **red, not green**: https://github.com/timothyjeffcoat/ascrum-migration/actions/runs/45308425782 .
  The commit scan is green (range 4681be2..2aae665, "5 commits scanned", "no leaks found"); the tree
  scan finds one false positive, `spec/worklogs/foundation.md:65`, rule `generic-api-key` (prose: the words
  "accessible names", a colon, then the question id Q-foundation-1). The file is outside this cluster's paths and an ignore would be
  silencing, so it is raised as **Q-p5-devsecops-4** and left red. Rewording the line clears it
  (checked locally).
- `codeql`, `CodeQL`, `lint`, `typecheck`, `test`, `build`, `e2e` green on the same head.

### History scan (local only; `gitleaks git --log-opts=--all`, 516 commits)
Three findings, recorded and asked about in Q-p5-devsecops-4, nothing silenced: the same worklog line
in 8df4797 and b04ff4d, and `server/cert/privatekey.pem` (`private-key`) from upstream commit 5d8f8d0
(2013, the original angular-app's development HTTPS key), deleted from the tree in #1 (29e69b4).
GitHub's secret-scanning alerts API lists no alerts.

### Plants (all draft PRs into `migration`, closed unmerged, branches deleted)

| Gate | Plant | PR | Result | Run |
|---|---|---|---|---|
| secrets (push protection) | Random characters in AWS key format (`AKIA` + 16 base32, 40-char secret) in `infra/demo.env` | none | **Blocked by push protection**: `git push` rejected ("Amazon AWS Secret Access Key", commit 96ba831, never reached the remote). Unlike session 1's AWS *example* key, a format-valid random key is blocked. The unblock URLs were not used | none (push rejected) |
| secrets | A JWT (`HS256` header, plausible claims, random 256-bit signature) as `ASCRUM_API_TOKEN` in `infra/demo.env` | #49 | **red**: commit scan "6 commits scanned … leaks found: 1", rule `jwt`, `infra/demo.env`; tree scan also red (the JWT plus the worklog line) | https://github.com/timothyjeffcoat/ascrum-migration/actions/runs/45308493720 |
| secrets (muting) | `.gitleaksignore` with the worklog finding's fingerprint | #53 | **red** on the allowlist guard; the tree scan, which loaded the ignore file, was green, which shows what the guard prevents | https://github.com/timothyjeffcoat/ascrum-migration/actions/runs/45308562354 |
| deps (DEV-03, re-run of #45) | `lodash@4.17.20` in a top-level `api/` with its own `pnpm-lock.yaml` | #50 | **red**: "pnpm audit in api … 4 vulnerabilities found / Severity: 2 moderate \| 2 high" (web: none) | https://github.com/timothyjeffcoat/ascrum-migration/actions/runs/45308517284 |
| deps (DEV-03, future shape) | Root `pnpm-workspace.yaml` (`packages: [api]`), root `package.json` with `packageManager`, root `pnpm-lock.yaml`; `api/` importer with `lodash@4.17.20` | #51 | **red**: `api/package.json: importer 'api' of ./pnpm-lock.yaml`, "pnpm audit in . … 2 high"; pnpm taken from the root `package.json` | https://github.com/timothyjeffcoat/ascrum-migration/actions/runs/45308524067 |
| deps (DEV-04, re-run of #44) | `lodash@4.17.20` in `web/` plus `web/pnpm-workspace.yaml` `auditConfig.ignoreGhsas` for both highs | #52 | **red** on the ignore step: `web/pnpm-workspace.yaml:1:auditConfig:`, `:2:  ignoreGhsas:`, with the deviation message | https://github.com/timothyjeffcoat/ascrum-migration/actions/runs/45308532769 |

The `secrets` job was red on #50, #51 and #52 too, from the tree false positive only (Q-4). After
closing: `gh api …/git/matching-refs/heads/plant` → 0 branches; no local `plant/*` branches.

### Findings, mistakes and wrong turns
- **The tree is not clean for Gitleaks** (Q-4), so `secrets` cannot be shown green yet. Not silenced.
- **Push protection does block a format-valid fake AWS key.** Session 1's conclusion ("not
  demonstrated") was about AWS's *example* key; a random key in the same format was rejected at push.
  So I switched the Gitleaks plant to a JWT, which push protection does not cover.
- **Dependabot security updates now open PRs against `legacy/`** (PR #47, `open` 0.0.3 → 6.0.0 in
  `/legacy/server`), and all 15 Dependabot alerts are in `legacy/`. A side effect of Q-3 (a). Not
  touched; Q-p5-devsecops-6.
- **Scratch-dir collision.** My first `pnpm verify` wrote its log to a fixed name in the session
  scratch directory, and the file I read back was the p5-store worker's run (its paths, its
  `test:integration` step). My own exit code (0) was real, but the log was not mine. Re-ran with a
  unique `mktemp` log; that run is the one quoted below.
- `prettier --check` on the root `.github/` YAML reports style differences in all four YAML files,
  including session 1's `codeql.yml` and `dependabot.yml`. The `lint` gate only covers `web/`, so this
  is not a gate failure; recorded, not changed.
- I first wrote `rm -rf` of a scratch path built from a variable; the harness refused it, and the
  scenario runs used fresh `mktemp -d` directories instead.

### Checks to require on `migration` (orchestrator applies, with the owner's OK)
The five existing (`lint`, `typecheck`, `test`, `build`, `e2e`), plus `deps`, `codeql`, `CodeQL`
(pinned to app `github-advanced-security`, id 57789) and `secrets` (after Q-4 is resolved, or it will
block every PR).

### Questions
- Q-p5-devsecops-4 (blocks a green `secrets` on the clean tree), -5 (Dependabot `/api`), -6 (Dependabot
  security PRs on `legacy/`).

### Gates (run in this session, from `web/`, ports 3701/4873/4874)
No app code changed. `pnpm verify`, exit 0:
```
All matched files use Prettier code style!
 Test Files  41 passed (41)
      Tests  406 passed (406)
✓ built in 364ms
✓ built in 388ms
  37 passed (13.0s)
```

## 2026-11-23: session 3 (Dependabot and `legacy/`, owner answer to Q-6)

### Dependabot must stop proposing changes under `legacy/`
What GitHub's current docs say (read this session):
- Options reference, https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference :
  `exclude-paths` exists ("paths of directories and files that Dependabot should ignore when scanning
  for manifests", globs relative to the entry's `directory`), but its heading carries only the
  **"Version updates only"** icon. Options that also affect security updates carry the
  "Security updates" icon ("All options marked with a [Security updates] icon also change how
  Dependabot creates pull requests for security updates, except where `target-branch` is used").
  `ignore` and `directories` carry it; `open-pull-requests-limit`, `schedule` and `target-branch` are
  version-updates only. `target-branch`: "Options defined for this `package-ecosystem` no longer apply
  to security updates".
- Changelog that introduced `exclude-paths` (2025-08-26),
  https://github.blog/changelog/2025-08-26-dependabot-can-now-exclude-automatic-pull-requests-for-manifests-in-selected-subdirectories/ :
  says excluded paths are not listed, parsed or given PRs, but does not say whether that covers
  security updates. The reference is the more specific source, so I did not rely on it.
- Controlling dependencies,
  https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/manage-your-dependency-security/controlling-dependencies-updated :
  "you can configure Dependabot to ignore those dependencies when it opens pull requests for version
  updates and security updates", via `ignore` in `dependabot.yml`.
- Configuring security updates,
  https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-security-updates :
  "You can override the default behavior of Dependabot security updates by adding a `dependabot.yml`
  file"; `open-pull-requests-limit: 0` prevents version updates for that ecosystem. Security updates
  are otherwise switched on or off only per repository (or org); there is no per-directory switch.
- Customizing security PRs,
  https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/manage-your-dependency-security/customizing-dependabot-security-prs :
  same pattern (an entry with `open-pull-requests-limit: 0` so its customisation applies to security
  updates only).

So `exclude-paths` alone would not stop the security PRs that started this (#47). The supported way
is Q-6 option (b): a `legacy/` entry whose `ignore` matches every dependency.

**Change** (`.github/dependabot.yml`, a third entry, nothing else touched): `package-ecosystem: npm`,
`directories: [/legacy/client, /legacy/server]` (the only manifests under `legacy/`, checked with
`git ls-files`; both are npm), `schedule.interval: weekly` (a required key),
`open-pull-requests-limit: 0` (no version updates), `ignore: [{dependency-name: '*'}]` (no security
updates). No `target-branch`, on purpose (see the quote above). Alerts still appear for `legacy/`;
that is intended, and they are dismissed by the owner.

**What proves it, after merge** (Dependabot reads the config only from the default branch, so nothing
on this PR exercises it):
1. Repo Insights → Dependency graph → Dependabot: the `/legacy/client` and `/legacy/server` npm jobs
   run without a config error, and list no PRs.
2. The next new advisory against a `legacy/` dependency raises an alert but no Dependabot PR. Fastest
   check: on any dismissed `legacy/` alert, reopen it and watch for a security PR (none should appear;
   the alert page should say updates are ignored by the config), then dismiss it again.
3. `gh pr list --author app/dependabot --state all` shows no new PR touching `legacy/`.
If a security PR still appears, `ignore` does not cover this case, and the next step is a question
(the only remaining switch is repo-wide: turning security updates off).

### `secrets` on PR #41
- On a45156c (the orchestrator's reword of `spec/worklogs/foundation.md`) `secrets` was still **red**:
  https://github.com/timothyjeffcoat/ascrum-migration/actions/runs/45310849823 . The foundation line was
  gone, but **my own** Q-4 entry and session 2 of this worklog quoted the flagged phrase verbatim, and
  Gitleaks flagged those two lines (commit e8f2576). A mistake of mine: quoting a false positive in
  full reproduces it.
- 061365a rewords both quotes (meaning kept, exact text not repeated). Local tree scan with the same
  Gitleaks 8.30.1: "no leaks found", exit 0.
- On 061365a `secrets` is still **red**:
  https://github.com/timothyjeffcoat/ascrum-migration/actions/runs/45311238358 . Tree scan **green**
  ("no leaks found"); commit scan red ("8 commits scanned", "leaks found: 2", both in e8f2576). The
  commit scan reads the whole PR range, so e8f2576 keeps it red on #41 whatever later commits do.
  Not silenced, not force-pushed; raised as **Q-p5-devsecops-7**.

### Findings, mistakes and wrong turns
- Quoting the Gitleaks false positive in my own logs (above).
- `prettier --check` outside `web/` still wants double quotes in `.github/*.yml`; the new entry
  follows the file's existing single-quote style. Not a gate (the `lint` gate covers `web/` only).

### Questions
- Q-p5-devsecops-7 (`secrets` red on #41 from commit e8f2576).

### Gates (run in this session, from `web/`, ports 3701/4873/4874)
No app code changed. `pnpm verify`, exit 0 (log checked to be this worktree's run):
```
All matched files use Prettier code style!
 Test Files  41 passed (41)
      Tests  406 passed (406)
✓ built in 364ms
✓ built in 416ms
  37 passed (13.3s)
```
