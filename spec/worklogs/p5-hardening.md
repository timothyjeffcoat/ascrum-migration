# Worklog: cluster p5-hardening (Phase 5, between waves B and C)

## 2026-11-24, session 1 (worker)

**Preconditions checked:** `spec/phase5-spec.md` reads `APPROVED rev 2`, and its §4 has the p5-hardening
row (owner: "start hardening"); `MIGRATION.md` lists the cluster as in progress. Branch
`convert/p5-hardening` in its own worktree, from the gate commit for PR #63 (`8726949`), which is not on
`migration` when I started. #63 was squash-merged during the session (`dd3cf81`), so before opening the
PR I merged `origin/migration` into the branch (no rebase, no force-push); after that,
`git diff --stat origin/migration...HEAD` lists 18 files, all owned paths plus this worklog. Ports: e2e 4001/5173/5174; PostgreSQL for the integration run in a throwaway container on
55460; compose project `ascrum-p5-hardening` (host ports 55461–55465, `IMAGE_TAG=p5h`).

Scope: the eight non-blocking rows from the wave B reviews, nothing else: DEV-p5-security-13, -15, -16,
-17 and DEV-p5-containers-11..14.

### What was done, item by item

1. **DEV-p5-security-13 (IPv6 /64).** `addressKey()` in `web/stub/throttle.ts` makes the per-IP key:
   IPv4 as is; IPv4-mapped IPv6 in any spelling (`::ffff:203.0.113.20`, `::ffff:cb00:7114`,
   `0:0:0:0:0:ffff:…`) as the IPv4 address; any other IPv6 address as its /64 (`2001:db8:0:1::/64`).
   It parses IPv6 itself (no `node:net`, because `throttle.ts` is also bundled for the browser stub):
   case, leading zeros, `::` anywhere, a dotted IPv4 tail, `[…]` brackets and a zone id (`%eth0`) all
   normalise. Something that is not an IP address is keyed as given (lower-cased), so it never merges
   with another client. `throttleKeys()` uses it, and both `succeeded()` implementations (memory and
   `PgLoginThrottle`) now release the address key `admit()` reserved (`reservedAddress()`) instead of
   rebuilding `ip:<address as sent>`, which would have missed the /64 key. CloudFront's IPv6 setting is
   not touched (wave C).
2. **DEV-p5-security-15 (scrypt `r`/`p`).** `verifyPassword()` rejects `r` > 32 or `p` > 16 as a failed
   verification, like the other corrupt rows. While writing the test I found that `derive()`'s
   `maxmem` (256·N·r) ignored the 128·r·p bytes of the p blocks, so an *in-range* row with a small N and
   a large p (`log2N 1, p 16`) made scrypt **throw** ("memory limit exceeded") instead of answering. Fixed
   in the same place (`+ 128·r·p`), with a case in the test. Production parameters (17/8/1) are unchanged.
3. **DEV-p5-security-16.** `startApi()` throws on `production` (default true) with `allowReset: true`,
   before it touches the database.
4. **DEV-p5-security-17.** A test pins the decoy's stored parameters to the store's own `scrypt`, for two
   stores: the test cost (10/8/1) and 11/4/2, which matches neither the test cost nor `PRODUCTION_SCRYPT`
   in any value, so no constant in the code can pass it.
5. **DEV-p5-containers-11 (lazy imports).** `no-restricted-syntax` on `ImportExpression` for `web/stub`
   (in `web/eslint.config.js`) and `api/src` (in `api/eslint.config.js`, which now composes web's config
   and adds this one block). No existing code in either folder uses `import()` (the `typeof import(...)`
   types and Vitest's `importOriginal` in `passwords.test.ts` are not `ImportExpression`s), so no
   exemption was needed and no question was raised. `web/src` is not covered: `main.tsx` loads MSW with
   `import()` on purpose, and nothing in `web/src` goes into the API image.
6. **DEV-p5-containers-12 (pin check).** `docker/check-images.sh` reads each Dockerfile as Docker does:
   comment lines dropped, `\` continuations joined, keywords in any case. It checks every image reference:
   `FROM`, `COPY`/`ADD --from=`, `RUN --mount=…,from=` (and the same behind `ONBUILD`). An earlier stage,
   by name in any case or by index, is fine; anything else must match the existing `PINNED` pattern. The
   `# syntax=` directive must be pinned, and `# escape=` is refused (it would change the continuation
   character the reader relies on). The base image for the history comparison now comes from the same
   reader (the last `FROM`), not from a second `sed`.
7. **DEV-p5-containers-13 (URLs with a password).** The layer scan fails on any `scheme://user:password@`
   (non-empty password, empty user allowed) in our own history lines (which include `ARG` values seen by
   a `RUN`) or anywhere in the image config (every `ENV` value, labels, healthcheck, command), whatever
   the variable is called. The finding is printed with the password replaced by `<redacted>`. Each
   image's "no secret" summary line, and the "pins" line, now print only when their checks passed.
8. **DEV-p5-containers-14 (one Gitleaks pin).** New composite action `.github/actions/setup-gitleaks`
   holds the version and SHA-256, keeps the `sha256sum --check --strict` step, and exports `GITLEAKS`.
   `secrets.yml` and `ci.yml`'s `e2e-compose` both use it; neither holds a version or checksum any more.

### Decisions
- **IPv6 /64, not /56 or /48.** As the reviewer's row suggests: a /64 is the smallest block a subscriber
  is normally assigned (one LAN needs a /64 for address autoconfiguration). Some ISPs hand out a /56 or /48, so one such subscriber can still use 256 or 65 536
  keys; a wider prefix would put unrelated customers of an ISP that assigns /64s into one key. The
  per-account limit applies regardless. The cost of /64: hosts sharing a /64 (one home or office LAN)
  share the per-IP allowance, as hosts behind one IPv4 NAT already do. The deprecated IPv4-compatible
  form `::a.b.c.d` lands in the all-zero /64; the socket never reports it, so it is left as is.
- **The `# syntax=` line is dropped, not pinned.** It named `docker/dockerfile:1`, a floating tag of an
  image that runs the build. Both Dockerfiles use nothing the engine's built-in frontend lacks (no
  heredocs, no `RUN --mount`; `HEALTHCHECK --start-interval` needs Engine 25 or later), so dropping it
  removes one pulled image instead of adding a digest that would have to be bumped by hand (Dependabot's
  docker ecosystem moves `FROM` lines). Checked: the rebuild's log never resolves `docker/dockerfile`
  (0 matches). The check still fails on any unpinned `# syntax=` if one is added back. Not covered: a
  `BUILDKIT_SYNTAX` build argument on the command line (nothing in compose or CI passes one).
- **ESLint: shared selectors, not a second rule list.** A later `no-restricted-syntax` setting
  *replaces* an earlier one for the files it matches, it does not merge. A block that set only the new
  selector for `stub/**` would have silently dropped the test-weakener selectors (`it.skip`, `.only`…)
  there, which is a weakened gate. So the two existing selectors moved into a `GATE_SELECTORS` constant,
  used by the existing rule unchanged and by the new `SERVER_SOURCE_RULES`, which adds `ImportExpression`.
  Proof that the change is additive only: `eslint --print-config` before and after, diffed (jq -S), for
  four files. `stub/handlers.ts` and `api/src/main.ts`: the only change is the added selector.
  `src/main.tsx` and `docker/api/import-graph.ts`: no change at all.
- **Composite action rather than a drift check.** One place to edit is simpler than two places plus a
  check that they agree. Dependabot still cannot move the pin (it is a script value), which is unchanged
  from before; the action's header says how to move it.

### Out of scope, said explicitly
- **N1b and N1c** from DEV-p5-containers-13 (`ENV APP_OPTS=<random>` with no telltale name, and
  `ARG SENTRY=<random>` used by a `RUN`): a value with neither a credential-like name nor a recognisable
  shape is beyond any pattern scanner. The comment in `check_secrets` says so; that belongs to the image
  scan and review in wave C.
- Other ways to load code lazily than `import()` (`module.createRequire`, `process.getBuiltinModule`,
  `new Function`) are not covered by the new lint rule. None is used, and the row asked for `import()`.
- A Dockerfile heredoc body (`RUN <<EOF`) would be read as instructions by the new reader. Neither
  Dockerfile has one; if one is added, a body line that looks like `FROM x` fails the check (fails closed).

### Mistakes and wrong turns
- **My first DEV-p5-security-15 test proved nothing.** I first added "r 33" and "p 17" to the existing
  malformed-values table by editing the numbers inside a valid hash. Those keys were derived at r 8, so
  verification fails with or without the cap. Rewrote it to hash at the out-of-range parameters (at a
  small `log2N`), so only the cap can reject them, plus at-the-cap cases that must still verify. That
  rewrite is also what exposed the `maxmem` throw (item 2).
- **A splice that did not save.** My first Python edit to replace the static section of
  `check-images.sh` built the new text and never wrote it back. I noticed when `grep` still showed the old
  `pins:` line, and redid it.
- **A blocked command.** One Python heredoc edit to `passwords.test.ts` was refused by the harness's
  removal safety check (a false positive on `$${…}` template text). I made the same edit with the editor
  tool instead.
- Nothing was committed from a plant. Every plant below lived in a scratch copy of the tree outside the
  repo (or was reverted from a backup straight after the run, for the TypeScript mutations), and
  `git status` was clean of them afterwards.

### Proof: each fix, its test, and the breakage shown red

| Item | Fix | Test / check | Breakage (never committed) → result |
|---|---|---|---|
| DEV-p5-security-13 | `addressKey()`, `throttleKeys()`, `reservedAddress()` in both throttles | `web/stub/throttle.test.ts` (5 tests); 3 tests `AC-SEC-04 / DEV-p5-security-13: …` in `web/stub/securityTests.ts`, run on MemoryStore (`pnpm test`) and PostgreSQL (`pnpm test:integration`) | key reverted to `ip:${attempt.ip}`: unit **4 failed** / 53 passed (57); integration `security.test.ts` **3 failed** / 36 passed (39). `succeeded()` reverted to the raw key: memory **1 failed** / 56 (57); PG **1 failed** / 38 (39) |
| DEV-p5-security-15 | `MAX_R = 32`, `MAX_P = 16`; `maxmem` + 128·r·p | `AC-SEC-01 / DEV-p5-security-15: …` in `api/src/passwords.test.ts` | caps back to 99: **1 failed** / 4 passed (5); `maxmem` without the p term: **1 failed** / 4 passed (5) |
| DEV-p5-security-16 | guard at the top of `startApi()` | `AC-SEC-03 / DEV-p5-security-16: …` in `api/src/security.test.ts` (refused for `{allowReset}` and `{allowReset, production}`, schema still empty; development pair still starts with the reset route) | guard disabled: **1 failed** / 38 passed (39) |
| DEV-p5-security-17 | (code already right) | `AC-SEC-01 / DEV-p5-security-17: …` in `api/src/passwords.test.ts` | the reviewer's mutation, decoy at `{log2N 10, r 8, p 1}`: **1 failed** / 4 passed (5); decoy at the production default: **1 failed** / 4 passed (5) |
| DEV-p5-containers-11 | `ImportExpression` in `no-restricted-syntax` for `web/stub`, `api/src` | `pnpm lint` | the reviewer's L1 (`await import('./loginAudit.ts')` in `PgStore.findLogin`, with the file created) plus `import(name)` in `web/stub/server.ts`: eslint **2 errors, exit 1**. Gate selectors still active there: `it.skip` in `api/src/main.test.ts` and `it.only` in `web/stub/throttle.test.ts`: **2 errors, exit 1** |
| DEV-p5-containers-12 | Dockerfile reader in `check-images.sh`; `# syntax=` dropped | `docker/check-images.sh` | each planted in a scratch copy, image built (build exit 0), check run there: P1 `from node:24-alpine AS deps` → **exit 1** ("FROM node:24-alpine is not pinned…"); `FROM \` + next line `node:24-alpine` → **exit 1**; P3 `COPY --from=busybox:latest …` → **exit 1**; `RUN --mount=type=bind,from=busybox:latest,…` → **exit 1**; `# syntax=docker/dockerfile:1` restored → **exit 1**. Control: `COPY --from=DEPS` and `COPY --from=0` → exit 0. The old script (at `688809b`) on the P1 plant: exit 0 |
| DEV-p5-containers-13 | URL-with-password scan; summaries only on success | `docker/check-images.sh` | N1a `ENV DATABASE_URL=postgres://ascrum_prod:<random 24>@db.prod.internal:5432/ascrum` → **exit 1**, printed `postgres://ascrum_prod:<redacted>@`, and no "no secret" line for that image; an `ARG` URL with a password used by a `RUN` → **exit 1**; a random `ghp_`-shaped token under `ENV APP_OPTS` (Gitleaks finding) → **exit 1** and no "no secret" line (the cosmetic half of the row). The random values never left the scratch copy; the N1a outputs were grepped for the value (no match), and Gitleaks redacts its own findings |
| DEV-p5-containers-14 | `.github/actions/setup-gitleaks` used by `secrets.yml` and `ci.yml` | the action's install script, run locally with the runner variables set | correct SHA-256: exit 0, "8.30.1", `GITLEAKS` exported; SHA-256 changed by one character: "FAILED … did NOT match", **exit 1**. Both workflows and the action parse as YAML; the real run is CI on the PR |

### Gate results (this session, run unpiped)
- `pnpm verify` (from `web/`, ports 4001/5173/5174, `DATABASE_URL` on 55460): **exit 0**.
  - lint: eslint clean, "All matched files use Prettier code style!"
  - typecheck: clean
  - unit: `Test Files  42 passed (42)`, `Tests  443 passed (443)`
  - integration: `Test Files  6 passed (6)`, `Tests  87 passed (87)`
  - e2e: `41 passed (24.6s)`
- The `e2e-compose` job's steps, under compose project `ascrum-p5-hardening`:
  - `docker compose --profile prod-check build`: exit 0
  - `docker/check-images.sh ascrum-api:p5h ascrum-web:p5h`: **exit 0** (pins line; API 12 own history
    entries and web 6, no secret; "main.ts loads exactly the 16 .ts files in /app"; starts and answers
    `/healthz` 200)
  - `docker compose --profile prod-check up --wait --wait-timeout 180`: exit 0
  - `pnpm e2e:compose`: **exit 0**, `47 passed (33.6s)`
  - `docker/check-client-address.sh`: exit 0 (key `ip:<nginx-seen IPv4>`, a forged header does not move it)
  - `docker/check-health.sh`: exit 0
  - `docker compose --profile prod-check down --volumes --remove-orphans`, and the 55460 PostgreSQL
    container removed at the end.

### Found on the way, not fixed (outside the eight items)
- `check-images.sh`'s start-up check removes its throwaway PostgreSQL with `docker rm -f`, without `-v`,
  so each run leaves that container's anonymous data volume behind (13 here: 12 check runs and my own
  test database, all removed by hand at the end). Harmless on CI's throwaway runners; on a developer
  machine they pile up. A one-flag follow-up (`docker rm -fv`), left for the reviewer to log or hand on.

### Questions
None. The spec and the rows covered every decision above.
