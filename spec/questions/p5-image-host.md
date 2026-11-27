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

## Owner answers (2026-11-26)

Relayed by the orchestrator; the owner said "yes" to the orchestrator's recommendations.

- **Q-p5-image-host-1: (b), in this cluster, now.** `docker/scan-images.sh` is added to p5-image-host's owned
  paths for this change only. Its two in-image reads (the `/lib/apk/db/installed` package count and the
  in-image `apk version -t` nginx-window decision) are replaced by host-side reads through
  `docker/image-fs.ts`, so it runs no binary from the image it scans. The duplicated window logic leaves
  `docker/check-scan-coverage.sh` (the window is decided in exactly one place); its set-equality coverage
  checks stay. Window semantics unchanged: it closes at nginx >= 1.30.7-r0 or after 2026-12-31 UTC, with the
  banner and `::warning::` on every run, and no ignore file. Done in session 2 (worklog).
- **Q-p5-image-host-2: (a), as implemented.** The residual is **accepted by the owner**: the content of the
  files inside the COPY roots (for example, edited JavaScript in `node_modules` from the `deps` stage, or
  static files from the `build` stage) is trusted as far as the lockfile, `--frozen-lockfile` and
  `--ignore-scripts` make it. (b), verifying `node_modules` against the lockfile's integrity hashes, is not
  wanted now.
- **Q-p5-image-host-3: (a), but not in this cluster.** The orchestrator runs it as a separate infra follow-up
  (`linuxParameters.capabilities.drop: ['ALL']`). This cluster does not touch `infra/`.

## Owner answer, round 2 of #90 (2026-11-26): DEV-p5-image-host-03

Relayed by the orchestrator. The build stage writes `/etc/nginx/ascrum/security-headers.conf`, which nginx
includes inside `server {}` (the security reviewer's WB2 appended a `location` that listed `/`). The owner
chose to **check the file, header lines only**, rather than widen the accepted residual of Q-2 to "server
config from the build stage". This narrows the Q-2 residual: it still covers the content of JavaScript and
static files inside the COPY roots, and no longer covers nginx config.

As implemented (session 3): `check-images.sh` reads the file from the image's layers on the host, and every
line must be blank, a comment, or exactly one directive the generator (`docker/web/security-headers.ts`)
writes. That is `add_header <name> "<value>" always;` or `proxy_hide_header <name>;`, with no `{`, `}`,
`include`, variable or escape, and nothing after the `;`. `proxy_hide_header` is allowed because the
generator writes one per header (it drops the API's copy so the header is never doubled), so its real output
could not pass without it. It opens no location and proxies nothing. If the owner meant `add_header` and
nothing else, the generator would have to change first, which is outside this cluster.

## Phase 5 follow-up (2026-11-27)

**Q-p5-image-host-4. Where do the reader's fail-closed tests live, and which CI job runs them (DEV-p5-image-host-07)?**
*(Blocks DEV-p5-image-host-07 only. The follow-up's other rows, -10 and -14 and DEV-p5-infra-50, are done
without it. Evidence: `spec/worklogs/p5-image-host.md`, session 5.)*

Context:
- `docker/image-fs.ts` fails closed (an error, exit 2, no model) on a whiteout that is not an empty file, an
  overlay metadata file it does not know, a hard link to nothing, a PAX key it does not understand, a global
  PAX header, nested or doubled extended headers, a tar type a layer may not use (FIFO, device), a malformed
  or mis-checksummed header, data after the end-of-archive marker, a blob whose SHA-256 or diff_id does not
  match, and a compression it does not know. Through `added`, an opaque directory or whiteout in a COPY layer
  is a finding (exit 1). The two clean images reach none of these branches, so CI never runs them. They ran
  once from a scratch generator outside the repo (#90, session 1), and the reviewer's crafted layers (a FIFO,
  a PAX `comment`, a tampered blob) exit 2 today. Nothing keeps them so.
- A test needs crafted `docker save` folders: `index.json`, `manifest.json`, a config blob, and layer
  tarballs with hand-built tar headers (ustar, PAX, GNU long names), gzipped with `node:zlib`. All of it is
  Node's standard library, so no new dependency. `image-fs.ts` is a CLI with no exports, so a test would
  spawn `node docker/image-fs.ts read <folder> <diff_ids> <model.json>` (and `added` for the COPY-layer
  cases), then assert the exit code and the message, with a clean control case that must exit 0. The reader
  itself would not change.
- `docker/` has no tests today. Its `.ts` files are already linted (web's `pnpm lint` covers `../docker`,
  with the rule that makes `.only`/`.skip`/`.todo` errors) and typechecked (`tsc -p ../docker/tsconfig.json`
  in `pnpm typecheck`), so a test file there gets both gates without a config change. Web's Vitest `unit`
  project includes only `src/**` and `stub/**`, under jsdom with the MSW setup file; `integration` includes
  only `../api/src/**` and needs PostgreSQL. infra/ is a separate package with its own Vitest.

Options:
- (a) **`node:test` under `docker/`, one new CI step.** `docker/image-fs.test.ts` plus its generator (for
  example `docker/image-fs-craft.ts`), using `node:test` and `node:assert`, run by `node --test docker/` as a
  new step in the existing `test` job of `.github/workflows/ci.yml` (setup-web already gives Node 24 there; no
  Docker needed). Touches `docker/` (new files) and `.github/workflows/ci.yml` (one step), so the PR gets the
  security second review. It is not in `pnpm verify` unless web's `verify` script also runs it, which would
  be a `web/package.json` edit too.
- (b) **Vitest, through web's config.** The same files under `docker/`, written for Vitest, and a third
  project `docker` (environment `node`, include `../docker/**/*.test.ts`) in `web/vitest.config.ts`, with
  `pnpm test` running it beside `unit` (`web/package.json`'s `test` script). Touches `docker/`,
  `web/vitest.config.ts` and `web/package.json`; no CI file change. It runs in `pnpm test`, `pnpm verify` and
  the `test` job. It edits the gate's config (an addition, not a loosening, but the reviewer has to check it
  is one). Adding `../docker/**` to the existing `unit` include instead would run node-only tests under jsdom
  and the MSW setup.
- (c) **A self-test inside `check-images.sh`.** Before reading the real images, run the reader on crafted
  folders and require the expected exit for each. Touches only `docker/`, and the existing e2e-compose step
  runs it. Cost: a test suite inside a gate, run only in the slowest job, and a failing case reads like an
  image finding.
- (d) **No test**: record the untested branches as an accepted residual in DEV-p5-image-host-07.

Recommendation: **(a)**. The tests are about the reader alone, so they belong next to it and need neither
Docker nor web's jsdom set-up; `node:test` is in the runtime the reader already requires, so there is no
new tool or dependency, and lint and typecheck already cover the folder. The `test` job is the fast one that
already runs on every push. The cost is one `.github/` line and the security second review. If the owner
also wants it in `pnpm verify`, (a) plus the one-line `verify` edit.
