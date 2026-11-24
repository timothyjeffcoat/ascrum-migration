# syntax=docker/dockerfile:1
# The API image (spec §2, AC-CTR-02): Node 24 running api/src/main.ts directly (type stripping, no
# build step), with production dependencies only, as the unprivileged `node` user.
#
#   docker build -f docker/api.Dockerfile -t ascrum-api .        (context: the repo root)
#
# The context is the repo root because the API imports the shared contract from web/stub/ (Q-p5-1 (b),
# p5-store's worklog). docker/api.Dockerfile.dockerignore is an allowlist: only api/ sources, the
# migrations and the six contract files reach the build, never tests, node_modules or .env files.
#
# Config, all from the environment: DATABASE_URL (required), PORT (default 3000), ALLOW_RESET (unset
# here, so production has no reset route, spec §3.3; compose sets it for local runs and CI only).
#
# Migrations run at start (main.ts, unchanged): startApi() applies pending migrations under a
# PostgreSQL advisory lock before it listens, so two containers starting at once cannot race, and a
# brand-new database gets the seed once. An explicit step (`node api/src/migrate.ts` as a one-off task)
# would also work with this image; see the worklog for why start-up was kept.

# node:24 (spec §2) on Alpine: the smallest official Node image that still has a shell and busybox for
# debugging. Pinned by version and digest; Dependabot's docker ecosystem can bump both together.
ARG NODE_IMAGE=node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

# --- deps: the production dependencies of api/ (only `pg` and its own dependencies) ----------------
FROM ${NODE_IMAGE} AS deps
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

# --- runtime -----------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=3000
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
COPY api/src api/src
COPY web/stub web/stub
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
