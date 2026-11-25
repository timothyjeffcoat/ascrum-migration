# Questions raised by cluster p5-image-cves (Phase 5, after live deploy run 3)

Ids are `Q-p5-image-cves-<n>` (spec §8.5). None blocks the fix in this cluster's PR: option 1 (pick up
Alpine's patched packages) clears all six findings of run 45664652733 (worklog, 2026-11-25).

**Q-p5-image-cves-1 (CVE-2026-4738 as a false match): not needed.** The brief reserved this id for the
CRITICAL finding in case option 1 could not clear it. It can: Alpine's secdb for v3.24 main lists
CVE-2026-4738 as fixed in `zlib` 1.4-r0, and the image now holds 1.4-r0. The finding was a match against
Alpine's own advisory data, not a bare NVD match on GDAL. In substance it did not apply to the image
(Alpine's libz does not build or ship zlib's `contrib/infback9`; the worklog has the evidence), but no
suppression is needed, so nothing for the owner to decide.

**Q-p5-image-cves-2. A check of the images' OS packages before AWS.**
Context: CI scans dependencies (Dependabot, `pnpm audit`), code (CodeQL) and secrets (Gitleaks), but
nothing scans the OS packages inside the built images. Q-p5-7 chose ECR scan-on-push and no extra tool,
with Trivy in CI only if there were no deploy. So run 3 found six OS-package CVEs only after a full build,
push and scan on AWS, and the deploy failed there instead of on the PR. CI's e2e-compose job already
builds both images (`ascrum-api:ci`, `ascrum-web:ci`), so a scanner would only need to read them. The web
image is not scanned anywhere today; its nginx base carries the same unpatched `libssl3`/`libcrypto3`
3.5.9-r0 and `zlib` 1.3.2-r0 (Q-p5-image-cves-3).
Options:
- (a) **Trivy in the e2e-compose job**, run as a pinned, checksum-verified release binary (the way
  `.github/actions/setup-gitleaks` installs Gitleaks), on both images, failing on HIGH/CRITICAL with
  `--ignore-unfixed` off, so it fails on the same things the ECR gate does. Adds: the failure on the PR,
  before any AWS run; both images; the package, installed and fixed version in the log. Costs: a new
  tool and its vulnerability DB download on every run (not measured here; the DB comes from a registry,
  so it is one more thing that can be down); Trivy's DB (Alpine secdb plus NVD and GitHub advisories) is
  not the same data as ECR's, so the two can disagree in either direction. A scanner is itself supply
  chain: pin a release by checksum, never `latest` or a floating action tag.
- (b) **Grype** (Anchore), the same way. Adds and costs about the same as (a); its Alpine matching also
  uses secdb. No measured difference for this repo; one tool for SBOM plus scan if Syft is ever wanted.
- (c) **`docker scout cves`**: no install on GitHub runners (the Docker CLI plugin), but it needs a
  Docker Hub login (a secret, which this repo's CI has avoided so far) and is rate-limited on free plans.
- (d) **No scanner; a package-version check only.** `docker/check-images.sh` now fails when the API
  image holds a package below a listed fixed version. That only re-checks the CVEs already known; it
  finds nothing new. No cost.
- (e) Keep it as is: the ECR gate is the only image scan. No cost, and every new base CVE costs an AWS
  run to learn about.
*Recommended: (a)*, as a step in e2e-compose after check-images.sh, failing on HIGH/CRITICAL with fixes
available in both images, and its JSON report uploaded on failure. It is the option Q-p5-7 already
named for CI, it catches what run 3 caught one AWS run earlier, and it covers the web image, which ECR
never sees. ECR's gate stays as the final check on the exact image that is deployed. It needs the owner's
answer because it is a new tool in CI (CLAUDE.md: no new dependencies or actions without an answered
question).

**Q-p5-image-cves-3. The web image's nginx base has the same unpatched packages.**
Context: `docker/web.Dockerfile` builds on `node:24.22.3-alpine3.24` (the same digest as the API) but only
in its build stage, which ships nothing; its runtime stage is
`nginxinc/nginx-unprivileged:1.30.6-alpine3.24`, a different base, so this cluster did not change it (its
owned paths cover web.Dockerfile only for the same base and the same fix). That base holds `libcrypto3`
and `libssl3` 3.5.9-r0 and `zlib` 1.3.2-r0 (checked with `apk info -v` in the pinned image): the five
OpenSSL CVEs above, CVE-2026-4738, and CVE-2026-85091 (fixed in zlib 1.3.2-r1). The web image is used by
compose and CI only; the AWS demo serves the static build from S3 and CloudFront, so ECR never scans it.
nginx links Alpine's OpenSSL for TLS, but the image serves plain HTTP behind the load balancer or
compose, and uses zlib for gzip.
Options: (a) the same `apk upgrade` step and minimum-version list in web.Dockerfile's runtime stage, with
check-images.sh checking both images; (b) wait for the next `nginx-unprivileged` release on Alpine 3.24
(Dependabot bumps it); (c) decide together with Q-p5-image-cves-2, whose scanner would flag it.
*Recommended: (a)* as a small follow-up (a few lines, the same pattern as the API), whatever Q-2 decides.
