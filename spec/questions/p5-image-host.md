# Questions raised by cluster p5-image-host (Phase 5 follow-up: checking the images from the host)

Ids are `Q-p5-image-host-<n>` (spec §8.5). The cluster's contract is the owner's approval of 2026-11-26
("yes, start the worker on the host-side image check") and the logged rows DEV-p5-image-scan-04 (b), -10,
-14 and -15. Evidence for every claim below is in `spec/worklogs/p5-image-host.md`, session 1. None of these
questions blocks the PR: each one is about work outside this cluster's owned paths, or about confirming a
policy that is already implemented with the recommended option.

**Q-p5-image-host-1. May `docker/scan-images.sh` read its two image facts on the host too?**
*(Not blocking; `docker/scan-images.sh` is outside this cluster's owned paths, so it is unchanged.)*

Context:
- `scan-images.sh` still runs two binaries from the images it scans: `sh` + `grep -c '^P:'` on
  `/lib/apk/db/installed` (the OS-package count Trivy's count must equal), and `sh` + `awk` + `apk version
  -t` in the web image (whether the nginx window is open). This is DEV-p5-image-scan-15's class: a wrapper
  copied in from an earlier stage could make the count agree, or make `apk version -t` print `<` and keep
  the window open after nginx 1.30.7 is installed.
- This PR adds `docker/check-scan-coverage.sh` (CI runs it right after the scan), which makes both
  decisions again on the host: Trivy's OS-package *set* must equal apk's database read from the layers
  (stronger than the count), and the window is re-decided from the host-read nginx version and
  `scan-images.sh`'s own constants; a closed window with nginx findings in the reports fails. So neither
  in-image read can make CI pass any more. They are redundant, not trusted.

Options:
- (a) Leave `scan-images.sh` as it is; the host-side backstop decides. Two places compute the window (one
  of them in-image), which a reader has to know about.
- (b) Let a follow-up (or this cluster, with `scan-images.sh` added to its owned paths) replace the two
  `docker run` reads with `node docker/image-fs.ts apk-installed` / `vercmp`, so `scan-images.sh` asks the
  image nothing, and drop the duplicated window logic from `check-scan-coverage.sh`.
- (c) Move the coverage check into `scan-images.sh` itself (one script, one report), deleting
  `check-scan-coverage.sh`.

Recommendation: **(b)**. It is a small, mechanical change (two reads), and afterwards every fact about the
images' files in CI comes from one reader. (a) is safe today because of the backstop. (c) mixes Trivy's
gate with the file reader, which the existing split (`check-images.sh` for file facts, `scan-images.sh`
for CVEs) keeps apart.

**Q-p5-image-host-2. Confirm the rule for what a runtime stage may add to its base (DEV-p5-image-scan-10).**
*(Not blocking; implemented as option (a), the recommendation.)*

Context: the text checks cover the runtime stage's lines only, so an earlier stage could build anything
and hand it over by COPY. The rule now enforced by `check-images.sh` (section "What the runtime stage adds
to its base"), read from the built image and its pinned base on the host:
- the image's layers start with the base's layers (by diff_id), its history starts with the base's, and
  its own RUN/COPY/WORKDIR history entries are exactly the runtime stage's lines;
- every path added or changed against the base is under the image's COPY roots (`/app`; `/srv/ascrum`,
  `/etc/nginx/ascrum`, `/etc/nginx/templates`), or one of apk's state files, or a file of a package the apk
  line names whose content matches apk's own recorded checksum; under the roots, no ELF file and no symlink
  out of the root; COPY and WORKDIR layers write only under the roots;
- no package is added; only the packages the apk line names change version or are removed (plus
  `ca-certificates-bundle`, which the API's `apk del` purges as an orphan);
- the base's ENV entries and ENTRYPOINT are unchanged, and the only new ENV names are the ones listed.

What it does **not** cover: the *content* of the files inside the roots. `/app/api/node_modules` comes from
the `deps` stage (`pnpm install --prod --frozen-lockfile --ignore-scripts`) and `/srv/ascrum` from the
`build` stage; a hostile edit there that stays JavaScript or static files, and is not ELF, passes. The
existing checks narrow it (the `/app` allowlist, the import graph equal to the .ts files, the installed
packages equal to the production tree, and now the scan coverage), but a modified `pg/lib/*.js` would pass.

Options:
- (a) Keep the rule as implemented, and accept the residual above: inside the roots, an earlier stage is
  trusted as far as the lockfile, `--frozen-lockfile` and `--ignore-scripts` make it.
- (b) (a), plus a follow-up that verifies `node_modules` against the lockfile: download each production
  package's tarball by its `integrity` (sha512) from the registry in CI, unpack it on the host and compare
  file by file with the image. Network in the check, and new code, but it closes the residual for the API.
- (c) Stricter roots: each COPY layer may write only under its own destination (not any root of the image),
  so for example `COPY api/migrations` could not write into `api/node_modules`. Small, but it does not
  touch the residual.

Recommendation: **(a)** now, with (b) as an optional follow-up if the article wants the build stages'
output covered too. (c) is cheap but adds little: every root is already data for the process, and the
residual is about content, not location.

**Q-p5-image-host-3. Also drop all Linux capabilities at run time (ECS task definition)?**
*(Not blocking; `infra/` is outside this cluster, and this cluster never touches AWS.)*

Context: DEV-p5-image-scan-14's suggested fix had a second half, `capabilities: { drop: ['ALL'] }` in the
ECS task definition's `linuxParameters` (today it sets only `initProcessEnabled`). With the bounding set
empty, a file capability or a setuid binary can no longer give a process root, whatever slips past an
image check. This PR does the image half (a file capability or any xattr fails `check-images.sh`). Whether
Fargate already sets `no_new_privs` or drops capabilities by default is unverified.

Options:
- (a) A small infra follow-up: `linuxParameters.capabilities.drop: ['ALL']` for both containers, with an
  assertion in the stack test; check on the next live deploy that nginx (port 8080, uid 101) and the API
  (port 3000, uid 1000) still start, since neither binds a privileged port.
- (b) Leave it to the image check.

Recommendation: **(a)**: defence in depth at the place the image actually runs, at the cost of one line and
a test, verified on the next deploy run that the infra cluster does anyway.
