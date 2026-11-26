# Worklog: cluster p5-image-scan (Phase 5 follow-up: Trivy in CI, nginx floors, package sources)

## 2026-11-26, session 1 (worker)

**Preconditions checked:** `spec/phase5-spec.md` reads `APPROVED rev 2`; the owner approved this cluster
today (orchestrator's brief). The contract is the owner's answers to Q-p5-image-cves-2 and -3
(`spec/questions/p5-image-cves.md`, "Owner answers (2026-11-25)") and the open rows DEV-p5-image-cves-02
and -07. Branch `convert/p5-image-scan` from `origin/migration` at `99f943c` (#87; #78 is in as `11da34b`).

**Ports and names:** e2e 4801/5973/5974; PostgreSQL for the integration run in a throwaway container on
55580 (the compose `db` image, stopped afterwards); compose project `ascrum-p5scan`, `IMAGE_TAG=p5scan`,
host ports `WEB_PORT=56530 API_PORT=56531 PROD_WEB_PORT=56532 PROD_API_PORT=56533 DB_PORT=56536`
(p5-image-cves used 56430–56436). AWS: never called; `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE`
pointed at `/dev/null` for every gate run.

**Outcome in one paragraph.** Items 1 and 3 are done and green. Item 2 is built and proven locally (the
pinned binary, fail-closed DB and scan, no ignore list), and its CI step is in the PR, but **it blocks**:
the web image has 19 HIGH/CRITICAL findings the floors do not cover, 6 of them in nginx itself, for which
no `nginx-unprivileged` image exists yet (Q-p5-image-scan-2). D03 is caught on the web image but **not on
the API image**, because Trivy rates CVE-2026-4738 MEDIUM where ECR rated it CRITICAL
(Q-p5-image-scan-3). Item 4 is a question (Q-p5-image-scan-1).

### Item 2a. Which Trivy, and how the pin was checked

**Primary sources:**
- Aqua's GitHub security advisory **GHSA-69fq-xp46-6x23**, "Trivy ecosystem supply chain temporarily
  compromised" (published 2026-03-21, updated 2026-03-30), read through the GitHub API
  (`repos/aquasecurity/trivy/security-advisories`). It says:
  - on 2026-03-19, with stolen credentials, an attacker published a malicious **v0.69.4** release
    (binaries, deb/rpm, GHCR, ECR Public, Docker Hub, `get.trivy.dev`);
  - it force-pushed 76 of 77 tags of `aquasecurity/trivy-action` and all 7 of `aquasecurity/setup-trivy`;
  - on 2026-03-22 it pushed malicious **0.69.5 and 0.69.6 Docker Hub images** (no GitHub release);
  - it names v0.69.2 and v0.69.3 as known safe at the time, and v0.69.3 onwards as protected by GitHub's
    immutable releases (enabled 2026-03-03). A malicious v0.70.0 was attempted and stopped.
  - The affected range in the advisory's data: `github.com/aquasecurity/trivy` `=0.69.4`.
- The other advisories on the repository, all later: GHSA-q3fv-x8vg-qqm4 (Helm tar bomb, fixed in
  0.71.0), **GHSA-mcj4-mphf-j9ff** (path traversal from a crafted DB or other downloaded artifact when
  `--db-repository` or `TRIVY_DB_REPOSITORY` points at a hostile registry, fixed in 0.71.1),
  GHSA-8rc5-4fr6-64pw (plugin path traversal, fixed in 0.72.0). None lists a version after 0.72.0.
- The release list (`gh api repos/aquasecurity/trivy/releases`): every release from v0.69.3 to v0.76.2 is
  marked `immutable: true`, published by the release workflow. v0.69.4..v0.69.6 do not exist any more.

**Pick: Trivy v0.76.2**, the latest release (2026-11-05, three weeks old), immutable, after all four
advisories' fixes, and not in any affected range.

**SHA-256 of `trivy_0.76.2_Linux-64bit.tar.gz`: `bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf`.**
Checked four ways, each from the release itself (downloaded into an empty folder in the session's
scratchpad):
1. `sha256sum` of the tarball equals its line in `trivy_0.76.2_checksums.txt` from the same release.
2. GitHub's asset metadata (`digest` of the release asset) gives the same `sha256:bc0fc726…`; the checksums
   file's own digest is `sha256:802e4ac1…`, which matches the file downloaded.
3. The checksums file's **Sigstore bundle** (`trivy_0.76.2_checksums.txt.sigstore.json`): its certificate's
   SAN is `https://github.com/aquasecurity/trivy/.github/workflows/reusable-release.yaml@refs/tags/v0.76.2`,
   issued by `sigstore-intermediate`, valid 2026-11-05 12:47:43–12:57:43 UTC; the Rekor `integratedTime`
   is 2026-11-05T12:47:43Z; the bundle's message digest equals the file's SHA-256, and `openssl dgst
   -sha256 -verify` with the certificate's key over the file prints `Verified OK`. (This step checks the
   signature against the certificate; it does not walk the chain to Fulcio's root. Step 4 does.)
4. **`gh attestation verify trivy_0.76.2_Linux-64bit.tar.gz --repo aquasecurity/trivy`**: exit 0. The
   verified attestation's signer is the same `reusable-release.yaml@refs/tags/v0.76.2`, issuer
   `token.actions.githubusercontent.com`, source commit `3f6334d2…` (which is what the `v0.76.2` tag points
   to), Rekor timestamp 2026-11-05T12:50:28Z, run 42024690106.

No cosign: not installed, and installing it would be another tool. `gh attestation verify` is the full
Sigstore verification for the tarball, and it ran in the gh CLI already on the machine.

**How the pin is installed.** `.github/actions/setup-trivy/action.yml`, modelled on setup-gitleaks: the
release tarball from `github.com/aquasecurity/trivy/releases/download/v0.76.2/`, `sha256sum --check
--strict` before unpacking, only the `trivy` binary extracted, `--version` printed, `TRIVY` exported. The
version and hash live only there. The step's variables are `PINNED_VERSION`/`PINNED_SHA256`, not
`TRIVY_*`, because Trivy reads every `TRIVY_*` variable as a flag. Run locally as the runner would (bash
-e, `RUNNER_TEMP`, `GITHUB_ENV`, `GITHUB_OUTPUT`): pinned values exit 0 (`…tar.gz: OK`, `Version:
0.76.2`, `TRIVY=…/trivy`); a wrong SHA-256 exits 1 (`FAILED`, `computed checksum did NOT match`), and
nothing is written to `GITHUB_ENV`.

### Item 2b. The scan: `docker/scan-images.sh`

A script, not inline YAML, so the same thing runs locally and in CI and can be broken on purpose. It:
- downloads the DB **into an empty cache** (a fresh temporary folder), so there is never an older DB to
  fall back on; a failed download exits 1;
- requires the DB to have been downloaded by this run and built less than 3 days ago (Trivy's DB is
  rebuilt daily; this catches a mirror serving an old copy);
- scans each image with `--exit-code 0` and judges the JSON itself, so a Trivy error (rc ≠ 0) and a
  finding are told apart and both fail;
- requires the report to show Alpine and **exactly as many OS packages as `/lib/apk/db/installed`
  lists** in the image (Trivy did not silently skip packages);
- fails on any HIGH or CRITICAL finding (`--severity HIGH,CRITICAL`, no `--ignore-unfixed`, no
  `--ignore-status`, OS and language packages);
- **cannot take an ignore list:** every `TRIVY_*` variable is unset, Trivy runs in an empty folder with
  `--config ''` and `--ignorefile ''`, and no VEX or ignore policy is passed. This also refuses a
  `TRIVY_DB_REPOSITORY` override, the precondition of GHSA-mcj4-mphf-j9ff;
- writes the JSON reports to `$SCAN_REPORT_DIR`, which CI uploads on failure.

CI (`e2e-compose` only; nothing else in ci.yml changed, `git diff` shows only added lines): "Install
Trivy (pinned, checksum-verified)" with the new action, then "Image scan (Trivy), both images, HIGH and
CRITICAL fail", right after `check-images.sh` (where the owner's answer put it), then an upload of the
reports on failure (the job already uses `actions/upload-artifact@v7`; no new action).

**Fail-closed proofs** (each a separate run, this session):

| Case | Exit | Line |
|---|---|---|
| P1: DB unreachable (`HTTPS_PROXY`/`HTTP_PROXY` to a closed local port) | 1 | `FATAL … failed to download vulnerability DB … mirror.gcr.io/aquasec/trivy-db:2` then `scan-images FAIL: could not download Trivy's vulnerability DB (the scan never passes without it)` |
| P2: Trivy itself, empty cache, `--db-repository unreachable.invalid/aquasec/trivy-db:2` | 1 | `FATAL … failed to download artifact from unreachable.invalid/aquasec/trivy-db:2` |
| P3: an image that does not exist | 1 | `scan-images FAIL: ascrum-web:does-not-exist: Trivy could not scan it` |
| P4: no Trivy (`TRIVY=/nonexistent/trivy`) | 2 | `scan-images: Trivy not found` |
| P5: an ignore list offered every way at once: `.trivyignore` with all 19 CVEs in the repo root, `TRIVY_IGNOREFILE` to the same list, `TRIVY_SEVERITY=LOW`, `TRIVY_DB_REPOSITORY=unreachable.invalid/x` | 1 | all 19 findings still reported, DB still from `mirror.gcr.io/aquasec/trivy-db:2` |
| P6 (control): plain `trivy image` run in a folder holding that `.trivyignore` | 0 | 0 findings: Trivy honours `.trivyignore` by default, which is why the script disables it |

Not exercised: the "DB older than 3 days" branch (no way to get an old DB from the registry without a
test hook; the comparison is a plain integer test on `UpdatedAt`).

### Item 2c. What Trivy says about the current images (not suppressed)

DB built 2026-11-26T13:14Z.
- **API image (`ascrum-api`)**: Alpine 3.24.4, 19 OS packages, 15 language packages (pg and its
  dependencies): **no finding at any severity.** The base image's global npm (undici, brace-expansion…
  HIGH) is not seen because the Dockerfile removes `/usr/local/lib/node_modules`.
- **Node's bundled OpenSSL** (the unverified note in Q-p5-image-cves-2): Trivy 0.76.2 does **not** report
  it. Node 24.22.3 bundles OpenSSL 3.5.9, which has five Low CVEs, and Trivy reports nothing for the
  `node` binary. Whether ECR does is still unknown (run 3's findings were all Alpine packages).
- **Severity disagreement with ECR** (to be logged in deviations.md by the reviewer, per the owner's
  answer): on the unpatched node base, Trivy rates the five OpenSSL CVEs MEDIUM (-95691, -95692, -107496)
  and LOW (-88822, -88823), and CVE-2026-4738 MEDIUM. ECR rated them HIGH (4), MEDIUM (1) and CRITICAL.
  Trivy warns "Using severities from other vendors" (Alpine's secdb has none).
- **Web image (`ascrum-web`)**: Alpine 3.24.2, 70 OS packages: **19 HIGH/CRITICAL findings in 9
  packages** after the floors (20 before: the floors clear zlib's CVE-2026-85091). Table and options in
  Q-p5-image-scan-2. Six are in nginx 1.30.6-r1 (fixed in 1.30.7-r0). nginx.org's Alpine repository has
  1.30.7-r1 (2026-11-11) and 1.30.8-r1 (2026-11-19), but the newest `nginx-unprivileged:1.30.x-alpine3.24`
  image is still 1.30.6 (2026-10-19, the pinned digest; Docker Hub tag list, this session). The other 13
  have fixes in Alpine v3.24 main. **This blocks the gate.** Per the brief I stopped there: no ignore list,
  no new floors beyond the owner's three, no base change. The CI step is in the PR and will be red on the
  web image until Q-p5-image-scan-2 is answered. The ci.yml step is its own commit so it can be split off.

### Item 2d. D03 broken once (DEV-p5-image-cves-02)

`'zlib>=1.4-r0'` removed from the floor line in **both** Dockerfiles, both images built (exit 0), then
restored (`cmp` equal, `git diff` clean):

| | zlib in the image | check-images.sh | scan-images.sh (HIGH/CRITICAL) |
|---|---|---|---|
| web | 1.3.2-r0 | exit 0 (floors: libcrypto3, libssl3 only) | **red**: `HIGH CVE-2026-85091 zlib 1.3.2-r0 (fixed: 1.3.2-r1)`, 20 findings |
| API | 1.3.2-r1 | exit 0 | **passes**: only CVE-2026-4738 remains, which Trivy rates **MEDIUM** |

So D03 is closed for the web image and **still open for the API image**. That is the owner's condition
not met, and it is a question (Q-p5-image-scan-3), not something to fix by changing the severity on my
own. An all-severity run confirms the zlib findings: API `CVE-2026-4738 MEDIUM`, web `CVE-2026-85091
HIGH` and `CVE-2026-4738 MEDIUM`.

### Item 1. nginx floors (Q-p5-image-cves-3 (a))

**Versions, checked for the web image's release.** The nginx base is Alpine **3.24.2** (`/etc/alpine-release`)
with `libcrypto3`/`libssl3` 3.5.9-r0 and `zlib` 1.3.2-r0; its repositories are Alpine v3.24 main and
community, so the floors come from the same branch as the API's:
- secdb `https://secdb.alpinelinux.org/v3.24/main.json`: `openssl` 3.5.9-r1 fixes CVE-2026-88822,
  -88823, -95691, -95692, -107496; `zlib` 1.3.2-r1 fixes CVE-2026-85091 and 1.4-r0 fixes CVE-2026-4738.
- aports `3.24-stable` (`main/openssl/APKBUILD`: `pkgver=3.5.9`, `pkgrel=1`, secfixes `3.5.9-r1` with the
  five CVEs; `main/zlib/APKBUILD`: `pkgver=1.4`, `pkgrel=0`, secfixes `1.4-r0: CVE-2026-4738`,
  `1.3.2-r1: CVE-2026-85091`).
- The v3.24 main `APKINDEX` today: `libcrypto3`/`libssl3` 3.5.9-r1, `zlib` 1.4-r0.

**Change.** web.Dockerfile's runtime stage: `USER root`, the same `RUN apk add --no-cache
'libcrypto3>=3.5.9-r1' 'libssl3>=3.5.9-r1' 'zlib>=1.4-r0'` as the API, `USER 101` (the base's user), with
a comment that cites the sources. The build log: `Upgrading libcrypto3 (3.5.9-r0 -> 3.5.9-r1)`, `libssl3`
the same, `zlib (1.3.2-r0 -> 1.4-r0)`, `OK: 51.2 MiB in 70 packages`. nginx links all three
(`ldd /usr/sbin/nginx`: `libssl.so.3`, `libcrypto.so.3`, `libz.so.1`), unlike Node; the config uses
neither TLS nor gzip (`listen 8080`, base `nginx.conf` has `#gzip on;`).

**check-images.sh** now runs the floor check as a function, `check_apk`, for both images with the strict
parsing from `af7f597` unchanged (a valid apk version floor, only `--no-cache`, `>` or `=` from
`apk version -t` in the image, confirmed count = floor count, no list = fail). Output on the real images:
`ascrum-web:p5scan: OS packages at or above their floors: libcrypto3 3.5.9-r1 = 3.5.9-r1;libssl3 3.5.9-r1 = 3.5.9-r1;zlib 1.4-r0 = 1.4-r0;`
(the API line is the same).

### Item 3. The package-source bypasses (DEV-p5-image-cves-07)

**Text checks, per Dockerfile:** quotes stripped from every word of every instruction that mentions apk;
options matched by prefix (`--allow-u*`, `--keys-d*`, `--repositor*`, `-X*`); an exec-form RUN that
mentions apk fails; and, beyond the brief, the floor line is the **only** instruction allowed to mention
apk (or `APK_`), and a RUN heredoc mentioning apk fails. That last rule also closes reviewer N12 (zlib
moved to a second `apk add` line), a bare `RUN apk upgrade` (DEV-05's "by design" note) and any option
smuggled through a variable. **Image checks:** everything under `/etc/apk` except `world` (repositories,
keys, any config file), hashed as root, must equal the runtime base image's; `world` must be the base's
plus exactly the floors (a floor replaces the base's entry for the same package: the nginx base's world
names `libcrypto3`); no ENV name starts with `APK_`.

**Red/green.** Each breakage is one line inserted before the floor line of `docker/api.Dockerfile`, run
with the **old** `check-images.sh` (from `origin/migration`) and the new one, then the Dockerfile
restored (`cmp` equal and `git diff` clean, every case). Cases marked "built" rebuilt the API image so the
in-image comparison sees the change; the others are static and used the real images.

| Id | Breakage (DEV-07 list unless noted) | Old | New | New check's finding |
|---|---|---|---|---|
| B01 | `RUN apk --allow-unt upgrade` | 0 | 1 | `an apk step uses --allow-unt`; only one apk line |
| B02 | `RUN apk --keys-d /tmp/keys upgrade` | 0 | 1 | `uses --keys-d` |
| B03 | `RUN apk --repositori /tmp/repos upgrade` | 0 | 1 | `uses --repositori` |
| B04 | `RUN apk upgrade '--allow-untrusted'` (quoted, outside the add line) | 0 | 1 | `uses --allow-untrusted` |
| B05 | `RUN ["apk","--allow-untrusted","upgrade"]` (exec form) | 0 | 1 | `an exec-form RUN mentions apk` |
| B06 | `RUN o=--allow-untrusted && apk $o upgrade` (through a variable) | 0 | 1 | only one apk line |
| B07 | N08: `RUN echo https://example.invalid/alpine >> /etc/apk/repositories` (built) | 0 | 1 | only one apk line, and `/etc/apk … differs from its base: ./repositories` |
| B08 | N16: `RUN wget -q https://example.invalid/key.rsa.pub -O /etc/apk/keys/extra.rsa.pub` | 0 | 1 | only one apk line (static only, not built: the URL is a placeholder; B10 is the built key case) |
| B09 | B07 spelled `/etc/ap''k` so no text check sees it (built) | 0 | 1 | `/etc/apk … differs from its base: ./repositories` |
| B10 | a key copied to `/etc/ap''k/keys/extra.rsa.pub` (built) | 0 | 1 | `/etc/apk … differs: > ./keys/extra.rsa.pub` |
| B11 | N12: `RUN set -e && apk add --no-cache zlib` | 0 | 1 | only one apk line |
| B12 | `RUN apk upgrade` (DEV-05) | 0 | 1 | only one apk line |
| B13 | `ENV APK_CONFIG=/tmp/apk.conf` | 0 | 1 | only one line may mention `APK_` |
| B14 | `RUN a=ap''k && $a add --no-cache curl` (built; hidden from the text check) | – | 1 | `/etc/apk/world is not its base's plus exactly the floors: > curl` |
| green | the real Dockerfiles and images | – | 0 | both images: floors met; `/etc/apk` identical to the base; world = base + 3 floors |

What it still cannot see: a build that adds a repository, installs from it and restores `/etc/apk`
afterwards, with a spelling the text check misses. The installed package would show in `world` only if
it was added by name; an upgrade of an existing package would not. Trivy and ECR read versions, not
sources. Recorded, not fixed.

### Item 4. Question only

Q-p5-image-scan-1 (apk-tools, ssl_client, busybox in the runtime images), with context from the built
images: in the API image `libssl3`/`libcrypto3` are required only by `libapk`, `apk-tools` and
`ssl_client`, and `zlib` only by `libapk`/`apk-tools`; in the web image nginx, libcurl, ca-certificates
and the njs module need them too, and the entrypoint and HEALTHCHECK need busybox.

### Decisions

- **Trivy 0.76.2**, the newest immutable release, not the "known safe" 0.69.2/0.69.3 the March advisory
  named: those are older than three later advisories' fixes, including GHSA-mcj4-mphf-j9ff (DB path
  traversal).
- **No sigstore verification in CI**, only the SHA-256 pin (as for Gitleaks). The pin fixes the bytes, and
  those bytes were verified once against the release's signature and attestation (above). A move to a new
  version repeats that check (the action's comment says so).
- **`--severity HIGH,CRITICAL` only, as the owner answered**, although it misses D03 on the API image.
  Changing the threshold is the owner's call (Q-p5-image-scan-3).
- **The stricter apk rules** (only one apk line; `world` = base + floors; `APK_`) go a little beyond the
  brief's list. They tighten a gate inside the owned path and need no exception today; the reviewer
  should check them.

### Mistakes and refusals this session

- **Worktree guard, three times ("too complex to verify … split it into plain, separate commands").**
  Each time I did what the message said, as DEV-p5-image-cves-03 describes: (1) one command that made a
  folder, changed into it and downloaded the four Trivy release files: split into `mkdir` and one `curl`
  per file with absolute paths; (2) a command that ran check-images.sh with Gitleaks' path in an
  environment variable and piped the output: moved into a small runner script in the scratchpad that runs
  the same command; (3) `source ~/.nvm/nvm.sh && nvm use` before `pnpm install`: replaced with a runner
  script that puts Node 24 from `~/.nvm/versions/node/v24.22.3/bin` on the PATH. No permission classifier
  refusal; nothing retried in another spelling.
- **world comparison, first version wrong.** It expected the base's world plus the floors, but `apk add
  'libcrypto3>=…'` replaces the nginx base's existing `libcrypto3` entry, and the host's `sort` used a
  different locale than busybox's. The first green run failed on the web image (`> /bin/sh < /bin/sh <
  libcrypto3`). Fixed (a floor replaces its package's entry; both sides sorted with `LC_ALL=C`) and
  re-run. In the fix I first left a broken `grep -vxFf` fragment in the pipeline; removed it before any
  run.
- **First mutation batch did not run** (exit 1): the runner wrote to a folder it had not created. No
  Dockerfile was touched; re-run after `mkdir`.
- **setup-trivy's first draft** named its variables `TRIVY_VERSION`/`TRIVY_SHA256`, which Trivy would read
  as flags in that step (`trivy --version` with `TRIVY_VERSION` set). Renamed before anything ran.
- **I expected D03 to be caught on both images**, as the owner's answer did. It is not, on the API image.
  Recorded and asked (Q-p5-image-scan-3).

### Gates (this session, unpiped, exit codes from the commands)

- **web** (`STUB_PORT=4801 PREVIEW_PORT=5973 PAGES_PORT=5974`, `DATABASE_URL` → the throwaway PostgreSQL
  on 55580): `pnpm verify` exit 0. `All matched files use Prettier code style!`; unit `Test Files 42 passed
  (42)`, `Tests 443 passed (443)`; integration `Test Files 6 passed (6)`, `Tests 87 passed (87)`; e2e
  `42 passed (24.4s)`. Nothing under `web/` changed; run because the brief asks for it.
- **infra `pnpm verify`: not run.** Nothing it covers changed (`infra/` untouched; ci.yml's infra job
  untouched).
- **The e2e-compose job's steps, locally** (project `ascrum-p5scan`, `IMAGE_TAG=p5scan`, each step its
  own exit code):
  - `docker compose --profile prod-check build` exit 0
  - `docker/check-images.sh ascrum-api:p5scan ascrum-web:p5scan` exit 0, ending `check-images: AC-CTR-02
    (non-root, no dev dependencies, test files or .env), pins, no secrets in layers or config, the API
    loads and starts, OS package floors and package sources in both images`
  - `docker/scan-images.sh ascrum-api:p5scan ascrum-web:p5scan` **exit 1**: `Trivy 0.76.2, vulnerability
    DB built 2026-11-26T13:14:47Z`; `ascrum-api:p5scan: alpine 3.24.4, 19 OS packages (as apk lists them)
    and 15 language packages scanned; no HIGH or CRITICAL finding`; `scan-images FAIL: ascrum-web:p5scan:
    19 HIGH or CRITICAL finding(s)` (Q-p5-image-scan-2). In CI this stops the job here.
  - run anyway, to show the stack works with the floors: `up --wait --wait-timeout 180` exit 0;
    `pnpm e2e:compose` exit 0, `48 passed (41.4s)`; `docker/check-client-address.sh` exit 0;
    `docker/check-health.sh` exit 0 (`AC-CTR-03: probes create no session; unhealthy without the
    database; healthy again when it is back`); `down --volumes --remove-orphans` exit 0.
- **hadolint:** not used by this repo (no config, no CI step), so not run.
- **Gitleaks** (8.30.1, the tarball re-downloaded and checked against the SHA-256 in setup-gitleaks:
  `OK`) on the staged change (everything after the first commit, ~42 KB): exit 0, `no leaks found`; and
  on the branch's first commit (`--log-opts=origin/migration..HEAD`, 1 commit): exit 0, `no leaks found`.

## 2026-11-26, session 2 (worker): the owner's answers to Q-p5-image-scan-1..3

**Why.** The orchestrator relayed the owner's answer ("yes, go with the recommendations") right after
session 1's report. It is recorded in `spec/questions/p5-image-scan.md`, "Owner answers (2026-11-26)".
Same branch, same PR (#88), same ports and compose settings.

### Q-p5-image-scan-1 (a): Alpine's OpenSSL, zlib and apk leave the API image

- **docker/api.Dockerfile:** the floor line and its comment are replaced by
  `RUN apk del --no-cache apk-tools libapk ssl_client libssl3 libcrypto3 zlib`. The build log:
  `Purging apk-tools (3.0.9-r0)`, `ca-certificates-bundle (20261020-r0)`, `libapk`, `ssl_client`,
  `zlib (1.3.2-r1)`, `libssl3 (3.5.9-r0)`, `libcrypto3 (3.5.9-r0)`, `OK: 4544 KiB in 12 packages` (19
  before). Busybox and apk's installed database stay; Trivy still reads the database (12 packages).
- **ca-certificates-bundle goes too**, as a dependency of libapk. Nothing in the image needs it:
  - Node uses its own CA store;
  - the deployed API connects to RDS with `sslmode=no-verify` (`infra/src/demoStack.ts`, Q-p5-infra-3),
    which never reads a CA file;
  - the compose stack talks plain TCP to PostgreSQL;
  - ECS's start command (`export DATABASE_URL=… && exec node …`) needs only `sh`, which busybox keeps.
- **What `apk del` does with a shorter list** (tried on the pinned base before writing the check):
  - Leaving `zlib` (or any of the libraries) out of the list changes nothing: once apk-tools goes, its
    dependencies have no other user, and apk purges them anyway.
  - Leaving `apk-tools` out keeps **all six**, and apk exits 0. apk prints "not removed due to:
    apk-tools…", then *upgrades* libcrypto3, libssl3 and zlib from the live index, because apk-tools stays
    in `world`.
  - So the build step cannot be trusted to fail by itself. The absence check is what does.
- **check-images.sh, `check_apk … removed` for the API.** It reads `/lib/apk/db/installed`
  (`docker run … cat`) and fails if:
  - the read fails, or the database does not list busybox and musl (so is not the real one);
  - any of `apk-tools libapk ssl_client libssl3 libcrypto3 zlib` is listed;
  - a main file of any of them is present (`/sbin/apk`, `/usr/bin/ssl_client`, `/usr/lib/libssl.so.3`,
    `libcrypto.so.3`, `libz.so.1`), which also covers a database entry removed by hand.

  The text rule is now "exactly one `RUN apk del --no-cache <names>` line, and nothing else may mention
  apk". The web image keeps "exactly one `RUN apk add --no-cache <floors>` line".
- **The package-source comparison, adapted for the API.** `apk del apk-tools` removes apk-tools' own
  `/etc/apk/protected_paths.d`, and the unchanged comparison failed on it on the first run
  (`< dir ./protected_paths.d`). The rules now:
  - For the API, `/etc/apk` may only *lose* paths against the base, never gain or change one. With apk
    gone nothing reads `/etc/apk` any more, but an added repository or key would still show that a build
    step fetched from elsewhere before the del.
  - The API's `world` must be the base's minus exactly the removed names.
  - The web image's comparison stays exact.

  Output: `ascrum-api:p5scan: absent: apk-tools libapk ssl_client libssl3 libcrypto3 zlib (installed
  database and files)` and `/etc/apk adds or changes nothing against node:24.22.3-alpine3.24@… (gone with
  apk: dir ./protected_paths.d ); world is the base's minus the removed packages`.
- The API image still loads and starts (`main.ts loads exactly the 16 .ts files`; `starts with only
  DATABASE_URL and answers /healthz: 200 {"status":"ok"}`), and the compose e2e is green (gates below).

### Q-p5-image-scan-2 (a): eight more web floors

Sources as in session 1: secdb v3.24 main for the fixed version, the aports 3.24-stable APKBUILD's
`pkgver`/`pkgrel` and secfixes, and the v3.24 main index for what installs today.

| Floor | secdb v3.24 main (fixed in) | aports 3.24-stable | Index today = installed after |
|---|---|---|---|
| `brotli-libs>=1.2.1-r0` | brotli 1.2.1-r0: CVE-2026-111497 | 1.2.1-r0 (secfixes 1.2.1-r0) | 1.2.1-r0 |
| `libexpat>=2.10.0-r0` | expat 2.10.0-r0: CVE-2026-113351, -115506, -117610, -118370 | 2.11.0-r0 (secfixes 2.10.0-r0) | 2.11.0-r0 |
| `libxslt>=1.1.43-r4` | 1.1.43-r4: CVE-2025-10911, CVE-2026-9947, -87636, -125350 | 1.1.43-r4 | 1.1.43-r4 |
| `libxml2>=2.13.9-r3` | 2.13.9-r3: CVE-2026-86144 | 2.13.9-r5 (secfixes 2.13.9-r3) | 2.13.9-r5 |
| `curl>=8.23.0-r0`, `libcurl>=8.23.0-r0` | curl 8.23.0-r0: 24 CVEs incl. CVE-2026-92392 | 8.23.0-r0 | 8.23.0-r0 |
| `musl>=1.2.6-r3`, `musl-utils>=1.2.6-r3` | musl 1.2.6-r3: CVE-2026-107891 | 1.2.6-r3 | 1.2.6-r3 |

The floor is secdb's fixed version, not today's newest, the same rule as the first three; libexpat and
libxml2 install above their floor. The line now continues over three lines with `\`, which
check-images.sh's reader joins. check-images.sh prints `ascrum-web:p5scan: OS packages at or above their
floors:` for all 11 and `world is the base's plus the 11 floors`.

### Q-p5-image-scan-2 (c) and Q-p5-image-scan-3 (a): the nginx window and the second pass

`docker/scan-images.sh` now runs two passes per image:
- **Pass 1:** OS and language packages, HIGH/CRITICAL, fixed or not.
- **Pass 2:** OS packages only, every severity (`UNKNOWN…CRITICAL`), `--ignore-unfixed`. Every finding
  here has a fix by construction, and any finding fails.

The window:
- **Its settings are constants in the script:** `WINDOW_PACKAGE=nginx`,
  `WINDOW_CLOSES_AT_NGINX=1.30.7-r0`, `WINDOW_EXPIRES=2026-12-31`. Nothing from the environment can change
  them: `TRIVY_*` is unset as before, and no other variable is read.
- **Scope:** only the image in the **web** argument slot, and only findings with class `os-pkgs` whose
  package is exactly `nginx` (not `nginx-module-*`), in either pass.
- **It is open only if all three hold:**
  - today (UTC) is not after the expiry;
  - the image's installed `nginx` can be read from apk's database;
  - `apk version -t <installed> 1.30.7-r0`, run in the image, prints exactly `<`.

  Anything else closes it, including a missing apk or a missing package, and then nginx findings fail like
  any other.
- **Every run** prints a banner with the state, the exit conditions and every nginx finding it held (both
  passes), and under GitHub Actions a `::warning::` annotation.

**Results on today's images:**

| Image | Pass | Findings | Failing |
|---|---|---|---|
| API (12 OS + 15 language packages) | pass 1 | 0 | 0 |
| API | pass 2 | 0 | 0 |
| web | pass 1 | 6, all nginx | 0 (window) |
| web | pass 2 | 10, all nginx | 0 (window) |

The scan exits 0. Pass 2's 10 nginx findings are pass 1's 6 plus CVE-2026-120967, -123640, -125283
(MEDIUM, fixed in 1.30.7-r0) and CVE-2026-132779 (MEDIUM, fixed in **1.30.8-r0**). So when a 1.30.7 base
arrives, the window closes and the scan still fails on -132779 until 1.30.8. That is the owner's "then
fails on everything"; it is noted here so it is not a surprise. Every other web package has no fixed
finding at any severity after the eight new floors.

### Proofs

Each case is a planted break, then restored and `cmp`-checked against a saved copy.

| Id | Break | Result |
|---|---|---|
| A1 | `apk-tools` left out of the `apk del` list (all six stay, build exit 0) | check-images **exit 1**: each of the six `is installed; it must be removed`, the five files present, `world … > apk-tools`. scan-images exit 0, because apk upgraded the three libraries: only the absence check catches this |
| A2 | the `apk del` line removed | check-images **exit 1**, the same 12 findings |
| D03-web | `zlib>=1.4-r0` dropped from the web floor line (zlib stays 1.3.2-r0) | scan-images **exit 1**: pass 1 `HIGH CVE-2026-85091 zlib 1.3.2-r0`; pass 2 also `MEDIUM CVE-2026-4738` |
| D03-API | the original D03: the pre-Q-1 API Dockerfile (from `origin/migration`) with zlib dropped from its floors (zlib stays 1.3.2-r1) | scan-images **exit 1**: pass 2 `MEDIUM CVE-2026-4738 zlib 1.3.2-r1 (fixed: 1.4-r0)`. Pass 1 alone passed it in session 1. **D03 is now red on both images.** The API as it now is has no D03 (no zlib, no floors); A1 and A2 are its counterpart |
| W1 | a non-nginx finding in the web image inside the window: the `libexpat` floor dropped | scan-images **exit 1**: 4 HIGH libexpat findings in pass 1, 7 libexpat findings in pass 2; the nginx findings are still held |
| W2 | installed nginx at the closing version (`WINDOW_CLOSES_AT_NGINX` planted at 1.30.6-r1 in a copy of the script) | **exit 1**: `state: closed: installed nginx 1.30.6-r1 compared with 1.30.6-r1 gives '='`; 6 + 10 nginx findings fail |
| W3 | past the expiry (`WINDOW_EXPIRES` planted at 2026-11-25) | **exit 1**: `state: expired: today (2026-11-26) is after 2026-11-25`; 6 + 10 nginx findings fail |
| W4 | the web image passed in the API slot | **exit 1**: all nginx findings fail (the window is never evaluated for that slot) |
| DB | the "DB too old" branch, which session 1 left unexercised (`DB_MAX_AGE_SECONDS` planted at 60) | **exit 1**: `the downloaded DB was built at 2026-11-26T13:14:47Z, more than 0 hours ago`. The message rounds 60 s down to hours; that happens only in the planted copy |
| green | the real files | check-images exit 0; scan-images exit 0, window open |

Note on D03-web, A1 and A2: the runner restored the Dockerfiles *before* running check-images, so
check-images compared the broken image with the real list. For D03-web that made check-images red too
(`zlib 1.3.2-r0 is not shown at or above 1.4-r0`). A real D03, with the list and the image both missing
zlib, still passes check-images, as session 1 showed; the scan is what catches it.

### For the reviewer: the first Trivy/ECR disagreement entry (owner's answer to Q-p5-image-cves-2)

- **CVE-2026-4738** in Alpine's `zlib` 1.3.2-r1: Trivy 0.76.2 rates it **MEDIUM**, ECR rated it
  **CRITICAL** in live run 3. Trivy's vendor severities are bitnami 4, julia 4 and ubuntu 2, and it warns
  that it uses other vendors' severities for Alpine. Pass 2 now catches the finding whatever its severity,
  and the API image no longer has zlib.
- **Node's bundled OpenSSL 3.5.9** (five CVEs that OpenSSL rates Low, fixed in 3.5.10): **Trivy does not
  see it.** The API image's Node.js result lists 15 packages (pg and its dependencies) and nothing for the
  `node` binary, at any severity. Whether ECR sees it is unknown; run 3's six findings were all Alpine
  packages.
- **The five OpenSSL CVEs in `libssl3`/`libcrypto3` 3.5.9-r0:** Trivy rates them MEDIUM/LOW, ECR rated
  them HIGH/MEDIUM. This is now moot for both images: the API removes the packages and the web image
  floors them.

### Mistakes and refusals, session 2

- **The `/etc/apk` comparison failed on the API's first run.** I had not checked what `apk del
  apk-tools` does to `/etc/apk`: it removes apk-tools' `protected_paths.d`. Adapted as described above.
- **The proof runner's "restored" line printed "NO" for every case.** It tested `git diff --quiet HEAD`,
  which cannot be clean while the session's edits are uncommitted. The `cmp` checks against the saved
  originals were all equal, and I re-checked them separately (`all-equal`).
- **Worktree guard, three refusals, each a plain split, nothing retried in another form:**
  - a `for` loop over aports URLs: moved into a script file;
  - a `sed` rewrite of the mutation runner: I wrote the new runner with the Write tool;
  - a long heredoc append to this worklog: written to a scratch file and appended with `cat`.

### DEV-p5-image-cves-07 bypasses, re-run against session 2's check

The same 14 lines as session 1, each inserted before the API's new `RUN apk del` line. Every case was
restored and `cmp`-checked (`restored yes` for all 14), and **all 14 exit 1**:
- **B01–B06, B11–B13** are red on the text rules (option prefixes, quotes, exec form, "only the one
  `RUN apk del --no-cache …` line may mention apk or APK_").
- **B07, B09, B10** (built) are red on `/etc/apk … has paths its base … does not`, B07 also on the text
  rule.
- **B08** is red on the text rule.
- **B14** (built; a hidden `apk add curl` before the del) is red on `world … > curl`. Because curl needs
  them, apk kept ssl_client, libssl3, libcrypto3 and zlib, so the absence check flags those four too.

### Gates (session 2, unpiped, exit codes from the commands)

- **web** (`STUB_PORT=4801 PREVIEW_PORT=5973 PAGES_PORT=5974`, `DATABASE_URL` → a throwaway PostgreSQL
  on 55580, stopped afterwards): `pnpm verify` exit 0.
  - `All matched files use Prettier code style!`
  - unit: `Test Files 42 passed (42)`, `Tests 443 passed (443)`
  - integration: `Test Files 6 passed (6)`, `Tests 87 passed (87)`
  - e2e: `42 passed (24.1s)`
- **infra**: `pnpm verify` exit 0, with `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` pointed at
  `/dev/null`, `AWS_EC2_METADATA_DISABLED=true` and no AWS variables.
  - `All matched files use Prettier code style!`
  - `Test Files 12 passed (12)`, `Tests 236 passed (236)`
  - `Successfully synthesized`

  Run this time because `infra/scripts/workflows.test.ts` reads the workflow files and ci.yml changed.
- **The e2e-compose job's steps, locally** (project `ascrum-p5scan`, `IMAGE_TAG=p5scan`), each with its
  own exit code:
  - `docker compose --profile prod-check build`: exit 0.
  - `docker/check-images.sh ascrum-api:p5scan ascrum-web:p5scan`: exit 0, ending `… the API loads and
    starts, web OS package floors, API without apk/OpenSSL/zlib, package sources in both images`.
  - `docker/scan-images.sh ascrum-api:p5scan ascrum-web:p5scan`: **exit 0**. `Trivy 0.76.2, vulnerability
    DB built 2026-11-26T13:14:47Z`, then `scan-images: no failing finding in either image`, with the nginx
    window notice (open; 6 + 10 nginx findings reported, not failing).
  - `up --wait --wait-timeout 180`: exit 0 (db, api-prod and web-prod healthy).
  - `pnpm e2e:compose`: exit 0, `48 passed (42.0s)`.
  - `docker/check-client-address.sh`: exit 0.
  - `docker/check-health.sh`: exit 0 (`AC-CTR-03: probes create no session; unhealthy without the
    database; healthy again when it is back`).
  - `down --volumes --remove-orphans`: exit 0.
- **hadolint:** not used by this repo.
- **Gitleaks 8.30.1** (the SHA-256-checked copy from session 1): on the staged session 2 change (~37 KB),
  exit 0, `no leaks found`; on the branch's 4 commits so far (`--log-opts=origin/migration..HEAD`,
  ~53 KB), exit 0, `no leaks found`.

## 2026-11-26, session 3 (worker): PR #88 round 2 (DEV-p5-image-scan-05, -07 A/B, -04 (a))

The reviewer's commit (deviations, MIGRATION, journal) was pulled with `git pull --ff-only` first; this
session did not touch those files. Scope was exactly the round-2 brief: no other change.

### DEV-p5-image-scan-05 (sec-01): a runtime-stage RUN allowlist

The hole: `check_apk` chose which instructions to inspect with a grep for `apk`/`APK_` on the raw text, so
a name the shell joins later (`ap''k`, `"ap"k`, `a\pk`, `$(echo ap)k`) was never inspected. Two changes in
`docker/check-images.sh`:

1. **`check_runtime_runs`**, called from `check_apk` for each image. It takes the runtime stage (every
   instruction after the last FROM, continuation lines already joined by `instructions()`, whitespace
   collapsed) and requires every RUN in it to be one of the permitted forms:
   - web: `RUN apk add --no-cache` followed only by whole-word single-quoted floors matching `APK_FLOOR`;
   - API: `RUN apk del --no-cache` followed only by bare names matching `APK_NAME`, plus two fixed
     literals (`API_RUNTIME_RUN_LITERALS`): the `rm -rf` of npm/corepack/yarn and the
     `printf '{ "type": "module" }\n' > web/package.json` line, compared byte for byte.

   A RUN that is not one of the two literals first fails if it holds `$(`, a backtick, `${`, any backslash
   (continuations are joined before this, so any remaining backslash is not one) or a quote that splits a
   word (only a whole word may be quoted, `'zlib>=1.4-r0'` passes, `ap''k` and `"ap"k` do not). Any other
   RUN in the runtime stage fails, whatever it says.

   **The printf line.** It holds `\n` and quoted words with spaces, so the metacharacter rule would reject
   it. It is exempt only because its whole text is a fixed literal: change a byte and it is "not a
   permitted form". This is the one judgement call; recorded here for the reviewer rather than asked,
   because the brief said "anything else already there: list them", and listing it as an exact literal
   is stricter than a metacharacter rule could be.

   **Dependabot.** A base-image bump rewrites only the FROM line (tag and digest). The allowlist compares
   RUN instructions only, and the stage boundary is found by the FROM keyword, not its value, so a FROM
   bump needs no allowlist edit. What does need an edit is a new RUN in a runtime stage, which is the point.
   A floor that a bump makes unnecessary still passes the allowlist; removing it is the existing
   "if the base image now has the fixes, remove this check with the step" path.
2. **The apk/APK_ filter** (which still covers every stage, the build stages included) now runs on the
   text with `'`, `"` and `\` removed, so `ap''k`, `"ap"k` and `a\pk` are inspected as `apk` in any stage.
   Spellings through `$(…)`, backticks or `${…}` are not something a text filter can see; in the runtime
   stage the allowlist rejects them, in build stages nothing ships from them except through COPY.

**Red/green** (each line planted into the Dockerfile in a scratch copy run, restored afterwards and
`cmp`-checked: `restored yes` for all ten; "before" = the check as committed at f987dfb):

| id | planted (web unless marked) | before | after | caught by |
|---|---|---|---|---|
| C1 | `RUN ap''k --allow-untrusted -X https://dl-cdn.alpinelinux.org/alpine/edge/main add --no-cache 'zlib>=1.4-r0'` before the floor line; **image built** (exit 0) | **exit 0** | exit 1 | quote-split word; normalised filter: `--allow-untrusted`, `-X`, second apk line |
| C2 | `RUN a\pk --allow-untrusted add --no-cache 'zlib>=1.4-r0'` | **exit 0** | exit 1 | backslash; normalised filter |
| C3 | `RUN "ap"k --allow-untrusted add --no-cache 'zlib>=1.4-r0'` | **exit 0** | exit 1 | quote-split word; normalised filter |
| C4 | `RUN $(echo ap)k --allow-untrusted add --no-cache 'zlib>=1.4-r0'` | **exit 0** | exit 1 | `$(` (the allowlist alone: no text filter sees this one) |
| C5 | `RUN X=apk && ${X} --allow-untrusted add --no-cache 'zlib>=1.4-r0'` | exit 1 | exit 1 | `${` (before: only because the word `apk` appears in `X=apk`) |
| C6 | ``RUN `echo apk` --allow-untrusted add --no-cache 'zlib>=1.4-r0'`` | exit 1 | exit 1 | backtick |
| C7 | `RUN X=apk; $X --allow-untrusted add --no-cache curl` | exit 1 | exit 1 | not a permitted form |
| C8 | API: C1's line with `zlib`, before the `apk del` line | **exit 0** | exit 1 | quote-split word; normalised filter |
| C9 | the real floor line rewritten as `RUN a\pk add --no-cache …` (same eleven floors) | exit 1 | exit 1 | backslash (before: only the world/floors-missing side effects) |
| C10 | API: `RUN apk del --no-cache … libcrypto3 $(echo zlib)` | exit 1 | exit 1 | `$(`; not a package name |

C1 was built, as the reviewer did, to show the image really changes; C2–C10 are text cases, so they were
run against the real images. Green: the real Dockerfiles give
`docker/api.Dockerfile: the runtime stage's 3 RUN instruction(s) are all permitted forms` and
`docker/web.Dockerfile: the runtime stage's 1 RUN instruction(s) are all permitted forms`, check exit 0.

### DEV-p5-image-scan-07 note A: the warning annotation's data

`gha_data` in `docker/scan-images.sh` drops everything but printable ASCII, CR and LF, then escapes as the
Actions toolkit's `escapeData` does, `%` first (`%`→`%25`, CR→`%0D`, LF→`%0A`). The whole message goes
through it, not only `window_reason`. Test (the function extracted from the script, not a copy), with a
planted reason `nginx 1.30.6-r0 < 1.30.7-r0` + LF + `::error::planted second command %0A literal` + CR +
`\x01` + `é` + ` end`:
`::warning title=t::nginx 1.30.6-r0 < 1.30.7-r0%0A::error::planted second command %250A literal%0D end`:
no newline left (one line), the literal `%0A` became `%250A`, the LF became `%0A`, the CR `%0D`, and the
control byte and the non-ASCII bytes were dropped.

### DEV-p5-image-scan-07 note B: `--pull never`

Every `docker run` in both scripts now has `--pull never` (9 in check-images, 3 in scan-images; a grep for
`docker run ` without it finds none). The one image that was being pulled implicitly, the start-up check's
PostgreSQL (`services.db.image` from the compose file, pinned by digest and checked by the pin check), is
now pulled explicitly by that digest when it is not present, just before the check: a consequence of the
flag, not a new behaviour. Proof:

- `docker run --pull never --rm --network none --entrypoint sh ascrum-web:does-not-exist-p5scan -c true`:
  `Error response from daemon: No such image`, exit 125, and `docker events --filter type=image` over the
  run shows **0** image events (no pull attempted).
- `docker/scan-images.sh ascrum-api:p5scan ascrum-web:does-not-exist-p5scan`: the API scanned as usual,
  then `scan-images FAIL: ascrum-web:does-not-exist-p5scan: could not count the packages in
  /lib/apk/db/installed`, exit 1, with no pull.

### DEV-p5-image-scan-04 (a), optional, done because it was three lines

`scan-images.sh` now refuses any Trivy whose `--version` is not exactly `PINNED_TRIVY_VERSION=0.76.2`
(exit 2), and the action's comment says to move the two together. A fake `trivy` printing
`Version: 0.69.4`: `scan-images: … is Trivy '0.69.4', not the pinned 0.76.2`, exit 2. Part (b) (comparing
the Node package count) was not in the brief and was not done.

### Mistakes and wrong turns, session 3

- **Guard refusal.** My first edit to `scan-images.sh` was a single Bash call (a Python rewrite plus a
  test). The worktree guard refused it as too complex to verify. Following the standing rule, I did not
  re-spell it as another shell command; I made the edit with the Edit tool and ran the test from a
  scratch script.
- **The reviewer's list was short by one.** The deviation names `ap''k`, `a\pk` and `$(echo ap)k`.
  Running the old check showed `"ap"k` passing too (C3), and the same hole in the API Dockerfile (C8).
  Conversely `${X}` (C5) was already red before the fix, but only by luck: the planted line also held
  the word `apk` in `X=apk`.
- **Normalising alone would not have closed it.** C4 (`$(echo ap)k`) is caught only by the allowlist's
  metacharacter rule. A text filter cannot list every way a shell can build a command name, which is why
  the allowlist, not the filter, is the fix.

### Gates (session 3, unpiped, exit codes from the commands)

- **The e2e-compose job's steps, locally** (project `ascrum-p5scan`, `IMAGE_TAG=p5scan`), each with its
  own exit code:
  - `docker compose --profile prod-check build`: exit 0.
  - `docker/check-images.sh ascrum-api:p5scan ascrum-web:p5scan`: exit 0, with both "all permitted forms"
    lines above and ending `… web OS package floors, API without apk/OpenSSL/zlib, package sources in
    both images`.
  - `docker/scan-images.sh ascrum-api:p5scan ascrum-web:p5scan`: exit 0. `Trivy 0.76.2, vulnerability DB
    built 2026-11-26T13:14:47Z, downloaded 2026-11-26T18:40:04Z`, then `scan-images: no failing finding
    in either image`, with the nginx window notice (still open).
  - `up --wait`: exit 0. `pnpm e2e:compose`: exit 0, `48 passed (39.9s)`.
  - `docker/check-client-address.sh`: exit 0. `docker/check-health.sh`: exit 0. `down`: exit 0.
- **infra `pnpm verify`:** not run. `.github/workflows/ci.yml` did not change this session (only the
  setup-trivy action's comment did), and the brief asks for it only if ci.yml changes.
- **web `pnpm verify`:** not run; nothing under `web/` changed.
- **Gitleaks 8.30.1** (the SHA-256-checked copy from session 1): on the staged session 3 change (~16 KB),
  exit 0, `no leaks found`; on the branch's 8 commits (`--log-opts=origin/migration..HEAD`, ~118 KB),
  exit 0, `no leaks found`. A first run scanned **0 bytes** staged, because my combined `git add … &&
  git status … && grep …` had been refused by the worktree guard and nothing was staged; caught by
  reading the byte count, staged with separate commands, and re-run.
