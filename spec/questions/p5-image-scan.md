# Questions raised by cluster p5-image-scan (Phase 5 follow-up: Trivy in CI, nginx floors, package sources)

Ids are `Q-p5-image-scan-<n>` (spec §8.5). The cluster's contract is the owner's answers to
Q-p5-image-cves-2 and -3 (`spec/questions/p5-image-cves.md`, "Owner answers (2026-11-25)"). Evidence for
every number below is in `spec/worklogs/p5-image-scan.md`, session 1.

**Q-p5-image-scan-1. Should apk-tools and busybox's ssl_client (and possibly busybox) leave the runtime
images?** *(Asked by the orchestrator's brief; question only, nothing implemented.)*

Context:
- **API image** (19 packages). Alpine's `libssl3`/`libcrypto3` are required only by `libapk`/`apk-tools`
  and `ssl_client`; `zlib` only by `libapk`/`apk-tools` (`apk info -r` in the built image). Node does not
  load any of them: it links only musl, libstdc++ and libgcc and bundles its own OpenSSL 3.5.9 and zlib
  (DEV-p5-image-cves-06). So without apk-tools and ssl_client, the three packages behind live run 3's six
  ECR findings and this cluster's floors would have no user and could go too. Nothing in the API runs apk
  or `wget https://…` at run time; its HEALTHCHECK uses Node's fetch.
- **Web image** (70 packages). nginx itself links `libssl.so.3`, `libcrypto.so.3` and `libz.so.1`, and
  `libcurl`, `ca-certificates` and the njs module need them too, so the libraries stay whatever happens
  to apk-tools. Removing apk-tools and ssl_client there removes two users, not the packages. Busybox is
  needed: nginx's `/docker-entrypoint.sh` is a shell script (it renders the config templates with
  envsubst), and the HEALTHCHECK is busybox `wget`.
- Trivy (0.76.2, this session) rates the five OpenSSL CVEs MEDIUM/LOW and CVE-2026-4738 MEDIUM; ECR rated
  them HIGH and CRITICAL. A package that is not in the image cannot be matched by either.

Options:
- (a) **API image: remove apk-tools, libapk, ssl_client, then libssl3, libcrypto3 and zlib** in the
  runtime stage (one `apk del` as the last apk step, or `rm` of their files plus the installed-db
  entries; `apk del` is cleaner because the scanners read the installed db). Keep busybox (the image's
  shell, used for debugging and by check-images.sh). Web image unchanged.
  Consequences: the API floor line and its check go away (nothing left to raise), and the image no longer
  carries the packages ECR flagged in run 3. check-images.sh's in-image checks that use `apk version -t`
  and `/etc/apk` (the floors and the package-source comparison) would apply to the web image only; for
  the API it would instead check that apk-tools, ssl_client, libssl3, libcrypto3 and zlib are *absent*
  (fail closed if any is present). Debugging: no `apk add` of a tool into a running container (it runs as
  `node` and could not anyway); `docker cp` or a debug sidecar instead. Scanners: an image without apk's
  installed db is harder to scan, so the db must stay (it does with `apk del`).
- (b) **(a) plus busybox removed from the API image** (a distroless-like runtime). Consequences: no shell
  for `docker exec`; check-images.sh's in-image checks (`id -u`, the floor and `/etc/apk` reads, the
  start-up probe) would have to run through `node -e` or from a sidecar; the gain is one more package with
  its own CVE history. More work and more change to the checks for a smaller gain than (a).
- (c) **Remove apk-tools and ssl_client from both images**, keeping the libraries in the web image
  (nginx needs them). Consequences for the web image: two fewer packages with a CVE history, but its
  check-images floor check would have to compare versions without apk in the image (read
  `/lib/apk/db/installed` and compare with `apk version -t` run in the pinned base image instead).
- (d) **Keep both images as they are** (the floors and the scans cover the known CVEs).

*Recommended: (a).* For the API it removes the packages at the root of run 3 instead of raising them,
which no floor list and no scanner disagreement can get wrong, and it keeps busybox for debugging. The
web image keeps apk for now: nginx needs the libraries, so removing apk there buys little, and its
blocking findings are elsewhere (Q-p5-image-scan-2). (a) changes `docker/api.Dockerfile` and
`check-images.sh` (owned by a docker cluster) and needs a reviewer's look at the new absence check.

**Q-p5-image-scan-2. The web image fails the Trivy gate on 19 HIGH/CRITICAL findings the floors do not
cover. Blocks item 2 (the scan in e2e-compose).**

Context: with this cluster's floors, `docker/scan-images.sh` passes the API image (19 OS packages and 15
language packages, no finding at any severity) and fails the web image with 19 findings in 9 packages
(Trivy 0.76.2, DB built 2026-11-26T13:14Z):

| Package (installed) | Fixed in | Findings | Where the fix is |
|---|---|---|---|
| nginx 1.30.6-r1 | 1.30.7-r0 | CVE-2026-113425, -121810, -123007, -123633 (CRITICAL); -118899, -123634 (HIGH) | nginx.org's own Alpine repository (1.30.7-r1 on 2026-11-11, 1.30.8-r1 on 2026-11-19); **no** `nginx-unprivileged` image has it: the newest `1.30.x-alpine3.24` tag is 1.30.6 (2026-10-19, the pinned digest) |
| brotli-libs 1.2.0-r1 | 1.2.1-r0 | CVE-2026-111497 (CRITICAL) | Alpine v3.24 main |
| libexpat 2.9.0-r0 | 2.10.0-r0 | CVE-2026-113351, -115506, -117610, -118370 | Alpine v3.24 main |
| libxslt 1.1.43-r3 | 1.1.43-r4 | CVE-2026-125350, -87636, -9947 | Alpine v3.24 main |
| libxml2 2.13.9-r2 | 2.13.9-r3 | CVE-2026-86144 | Alpine v3.24 main |
| curl, libcurl 8.22.0-r0 | 8.23.0-r0 | CVE-2026-92392 | Alpine v3.24 main |
| musl, musl-utils 1.2.6-r2 | 1.2.6-r3 | CVE-2026-107891 | Alpine v3.24 main |

The nginx findings are in the mail proxy, HTTP/3, HTTP/2, the resolver and TLS; this config listens on
plain HTTP/1.1 on 8080 and uses none of them. That is reachability, which the gate does not weigh and
which I did not prove. Not suppressed (the owner's condition); the CI step is in the PR and will be red on
the web image until this is answered. The `-slim` variant of the same nginx release has 21 packages and
only musl, nginx and zlib findings (1 + 6 + 1); it was not tested as a base for this image.
Options:
- (a) **Extend the web floor line** to every Alpine-fixable package above (brotli-libs, libexpat, libxslt,
  libxml2, curl, libcurl, musl, musl-utils), and **wait for an `nginx-unprivileged` 1.30.7+ image**
  (Dependabot bumps the FROM line) before the scan step can pass. Until then e2e-compose is red, so
  nothing merges. Not workable on its own unless the nginx image arrives soon.
- (b) **(a) plus nginx from nginx.org's Alpine repository** (`apk add` with that repository for the one
  package; its signing key is already in the base image's `/etc/apk/keys`). Clears all 19 now. Costs: a
  second package source, which this cluster's package-source check refuses by design (DEV-p5-image-cves-05,
  -07) and would have to allow for exactly that URL and key; nginx's version then floats with that repo.
- (c) **(a), and the scan fails on the API image but only reports on the web image until the nginx image
  exists**, with a dated exit condition (the first Dependabot bump to 1.30.7+). Clears the PR now. Costs:
  it weakens the owner's condition ("both images") for a time, which only the owner can allow.
- (d) **A dated ignore list for exactly the six nginx CVEs** (`--ignorefile` in the repo, each entry with
  an expiry and the reachability argument), plus (a) for the rest. Costs: the first ignore list, which
  the owner's answer forbids without a new answer.
- (e) **Switch the runtime base to `-slim`** plus (a) for musl: fewer packages, fewer future findings;
  the nginx findings stay, so it still needs (a)'s wait, (b), (c) or (d). Needs testing (the slim
  image's entrypoint and modules).

*Recommended: (a) with (c)*, the report-only window on the web image ending at the first nginx 1.30.7+
image, because it keeps the floors and both images in the report, adds no package source and no ignore
list, and the API image (the one that is deployed) is fully gated now. If the owner prefers the web image
gated now, (b) is the honest way to do it, with the package-source check widened for exactly nginx.org.

**Q-p5-image-scan-3. D03 is not caught on the API image: Trivy rates CVE-2026-4738 MEDIUM.**

Context: the owner's answer expected the scan to close DEV-p5-image-cves-02 / D03 (zlib dropped from both
the upgrade and the floor list). Broken once in this session, in both Dockerfiles:
- the **web** image keeps zlib 1.3.2-r0 and Trivy fails it on CVE-2026-85091 (HIGH). Caught.
- the **API** image keeps zlib 1.3.2-r1, which has only CVE-2026-4738 left. Trivy reports it as MEDIUM
  (its vendor severities: bitnami 4, julia 4, ubuntu 2; Trivy warns it uses "severities from other
  vendors" for Alpine), so the HIGH/CRITICAL scan passes it, and so does `check-images.sh`. ECR rated the
  same finding CRITICAL in live run 3. **Not caught.** The same disagreement covers the five OpenSSL CVEs:
  Trivy MEDIUM/LOW, ECR HIGH/MEDIUM. The owner's answer says disagreements are logged in
  `spec/deviations.md` (the reviewer's file); this is the first one.
- Separately (the unverified note in Q-p5-image-cves-2): Trivy 0.76.2 does **not** report Node's bundled
  OpenSSL 3.5.9. The API image's `Node.js` result has 15 language packages (pg and its dependencies) and
  no finding at any severity, although OpenSSL rates five CVEs in 3.5.9 Low.
Options:
- (a) **A second Trivy pass on OS packages at every severity, failing on any finding that has a fix**
  (`--pkg-types os --ignore-unfixed`, all severities), next to the HIGH/CRITICAL pass. It fails when an
  installed Alpine package is below a version Alpine has already fixed, whatever anyone's severity: a
  generalised floor check from Trivy's copy of secdb. Catches D03 on both images. Today it adds nothing
  on the API image (no findings at any severity); on the web image it adds whatever MEDIUM/LOW fixes are
  pending. Costs: stricter than ECR for low-severity fixes; one more scan (seconds, same DB).
- (b) **Fail on MEDIUM too** in the one pass. Catches D03 here; also fails on unfixed MEDIUMs, which
  nobody can act on.
- (c) **Remove zlib from the API image** (Q-p5-image-scan-1 (a)): D03 cannot happen there.
- (d) **Accept it**: D03 on the API stays a survivor offline, and ECR's gate (CRITICAL) catches it on the
  deploy run, one AWS run later, as in run 3.

*Recommended: (a)*, because it closes the class (any package left below an Alpine fix), not just zlib,
and it does not depend on two vendors agreeing on a severity. (c) is complementary if Q-p5-image-scan-1
(a) is accepted.

## Owner answers (2026-11-26)
The owner, relayed by the orchestrator: "yes, go with the recommendations". Implemented in the same PR
(#88); the worklog's session 2 has the evidence.

- **Q-p5-image-scan-1: (a).** In `docker/api.Dockerfile`'s runtime stage, `apk del` apk-tools, libapk,
  ssl_client, libssl3, libcrypto3 and zlib. Keep apk's installed database (the scanners read it) and
  busybox. The API floor line and its check go; `check-images.sh` checks that those six packages are
  absent from the API image, failing closed if any is present or the installed database cannot be read.
  The package-source comparison applies to the web image, and is adapted for the API.
- **Q-p5-image-scan-2: (a) + (c).**
  - (a): the web floor line gains brotli-libs, libexpat, libxslt, libxml2, curl, libcurl, musl and
    musl-utils at the Alpine v3.24 fixed versions, checked by `check-images.sh` like the others.
  - (c): the web image's Trivy result is report-only during a window whose exit is mechanical:
    - it covers only findings in the `nginx` package; any other finding in the web image still fails;
    - it ends by itself when the web image's installed nginx is >= 1.30.7 (the check reads the installed
      version and then fails on everything);
    - it has a hard expiry, 2026-12-31, after which the step fails regardless;
    - every run prints a loud notice naming the window, the CVEs reported and the exit conditions;
    - there is no ignore file: report-only is a scoped exit-code decision in the script, tested by
      planted breaks.
  - The API image stays fully gated.
- **Q-p5-image-scan-3: (a).** A second Trivy pass on OS packages at all severities with
  `--ignore-unfixed`, failing on any finding that has a fix, on both images. The nginx-only window
  applies to that pass's nginx findings in the web image and nothing else. D03 must be shown red on the
  API image and on the web image. The worklog notes Trivy not seeing Node's bundled OpenSSL, and
  CVE-2026-4738 (Trivy MEDIUM vs ECR CRITICAL), for the reviewer's first Trivy/ECR disagreement entry.
