# The API image (spec §2, AC-CTR-02): Node 24 running api/src/main.ts directly (type stripping, no
# build step), with production dependencies only, as the unprivileged `node` user.
#
#   docker build -f docker/api.Dockerfile -t ascrum-api .        (context: the repo root)
#
# The context is the repo root because the API imports the shared contract from web/stub/ (Q-p5-1 (b),
# p5-store's worklog). docker/api.Dockerfile.dockerignore is an allowlist: only the non-test sources of
# api/src/ and web/stub/, the migrations and the lockfile reach the build, never tests, node_modules or
# .env files. Of those sources, the image gets exactly the files the API loads at run time, taken from
# Node's own loader at build time (docker/api/import-graph.ts, DEV-p5-containers-05): a file the API
# starts importing gets in by itself, and one it does not import (a test helper, the MSW adapter) stays out.
#
# Config, all from the environment (api/src/config.ts): DATABASE_URL (required), PORT (default 3000);
# APP_ENV unset means production mode, so no ALLOW_RESET and `Secure` cookies (spec §3.3, p5-security).
# The image starts through `node api/src/main.ts`, which reads the environment with loadConfig()
# (the condition for DEV-p5-security-16; docker/check-images.sh checks the CMD and that it starts).
#
# Migrations run at start (main.ts, unchanged): startApi() applies pending migrations under a
# PostgreSQL advisory lock before it listens, so two containers starting at once cannot race, and a
# brand-new database gets the seed once. An explicit step (`node api/src/migrate.ts` as a one-off task)
# would also work with this image; see the worklog for why start-up was kept.

# node:24 (spec §2) on Alpine: the smallest official Node image that still has a shell and busybox for
# debugging. Pinned by version and digest, written out on each FROM line (not through an ARG): Dependabot's
# docker ecosystem reads only literal FROM lines, and bumps the version and digest together there
# (DEV-p5-containers-09). docker/check-images.sh fails on an unpinned FROM.
# No `# syntax=` directive: the build runs on the Docker engine's built-in Dockerfile frontend, so no
# frontend image is pulled (DEV-p5-containers-12). If one is ever added, check-images.sh requires it
# pinned by version and digest.

# --- deps: the production dependencies of api/ (only `pg` and its own dependencies) ----------------
FROM node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS deps
WORKDIR /build/api
# pnpm at the version the repo pins (web/package.json "packageManager"), through Node's corepack.
COPY web/package.json /build/web-package.json
RUN corepack enable pnpm \
 && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack prepare "$(node -p "require('/build/web-package.json').packageManager")" --activate
COPY api/package.json api/pnpm-lock.yaml ./
# No pnpm-workspace.yaml here, so api/ installs on its own from its own lockfile. --prod leaves out
# every devDependency (@types/pg, and the vitest link into web/); --frozen-lockfile refuses drift.
RUN COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --prod --frozen-lockfile --ignore-scripts
# Some published packages ship their own tests (pg-protocol: *.test.js and .ts, pg-types: test/). Nothing
# requires them at run time; AC-CTR-02 says no test files in the image, so they are dropped here.
RUN find node_modules/.pnpm -type f -name '*.test.*' -delete \
 && find node_modules/.pnpm -mindepth 4 -maxdepth 5 -type d \( -name test -o -name tests -o -name __tests__ \) \
      -prune -exec rm -rf {} +

# --- app: exactly the source files the API loads (DEV-p5-containers-05) ------------------------------
# The tree as it will be in /app, then Node's loader lists what main.ts actually imports, and only that
# is copied to /out. Importing main.ts here is also the first smoke test: a missing module fails the build.
WORKDIR /build/app
COPY api/package.json api/package.json
COPY api/src api/src
COPY web/stub web/stub
COPY docker/api/import-graph.ts /build/import-graph.ts
RUN printf '{ "type": "module" }\n' > web/package.json \
 && ln -s /build/api/node_modules api/node_modules \
 && node /build/import-graph.ts /build/app /build/app/api/src/main.ts > /build/import-graph.txt \
 && mkdir -p /out \
 && tar -cf - -T /build/import-graph.txt | tar -xf - -C /out \
 && echo "API sources in the image:" && cat /build/import-graph.txt

# --- runtime -----------------------------------------------------------------------------------
FROM node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS runtime
ENV NODE_ENV=production \
    PORT=3000
# Alpine's OpenSSL and zlib leave the image (owner's answer to Q-p5-image-scan-1 (a)). In this image their
# only users were apk-tools/libapk and busybox's ssl_client: Node never loads them (it bundles its own
# OpenSSL and zlib; `ldd` on node lists only musl, libstdc++ and libgcc), the API never runs apk, and its
# HEALTHCHECK uses Node's fetch. So instead of raising them to Alpine's fixed versions (live deploy run 3,
# the image-scan gate: CVE-2026-95691, -95692, -88823, -107496, -88822 in libssl3/libcrypto3 3.5.9-r0 and
# CVE-2026-4738 in zlib 1.3.2-r1; p5-image-cves), the step removes them with their users. apk also purges
# ca-certificates-bundle, which nothing needs here: Node uses its own CA store, and the deployed API connects
# to RDS with sslmode=no-verify (infra/src/demoStack.ts). Busybox stays (the shell for debugging, the ECS
# start command and check-images.sh), and so does apk's installed database, which the scanners read.
# docker/check-images.sh checks that the six packages are absent and that this is the only apk instruction.
RUN apk del --no-cache apk-tools libapk ssl_client libssl3 libcrypto3 zlib
# The API never installs anything at run time, so the base image's package managers go: fewer tools for
# an attacker, fewer packages for the image scan (wave C). They live in the base layers, so this does
# not make the image smaller.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
# Files stay owned by root and read-only for the `node` user: the process cannot change its own code.
COPY --from=deps /build/api/node_modules api/node_modules
COPY api/package.json api/package.json
COPY api/migrations api/migrations
COPY --from=deps /out/ ./
# web/stub/*.ts are ES modules; this is the only part of web/package.json Node needs to load them.
RUN printf '{ "type": "module" }\n' > web/package.json
USER node
EXPOSE 3000
# AC-CTR-03: /healthz answers 503 when the database is unreachable. Node's own fetch, so the check
# needs nothing else in the image. ECS ignores this (its task definition has its own); Docker and
# compose use it.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --start-interval=1s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "api/src/main.ts"]
