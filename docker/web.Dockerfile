# The web image (spec §2, G4): the production build (`vite build`, not the Pages build) behind nginx,
# which also routes the contract's paths to the API so both share one origin (spec §3.6).
#
#   docker build -f docker/web.Dockerfile -t ascrum-web .        (context: the repo root)
#
# Why nginx: it is a static file server and a reverse proxy in one well-known process, with an official
# unprivileged image. A Node server would be our own code for path handling, MIME types, streaming and
# proxying, all of which nginx already does and is scanned for. The cost is the nginx config language,
# kept to one file (docker/web/default.conf.template).
#
# Config from the environment: API_UPSTREAM (default http://api:3000, the compose service) and
# ROUTE_STUB_CONTROL (default off; compose sets `on` for local runs and CI so e2e can reset).
#
# Security headers: exactly the map exported by web/securityHeaders.ts (p5-security), turned into nginx
# config at build time by docker/web/security-headers.ts. The build fails if that module is missing.

# Both bases are pinned by version and digest, written out on each FROM line (not through an ARG):
# Dependabot's docker ecosystem reads only literal FROM lines (DEV-p5-containers-09).
# No `# syntax=` directive: the build runs on the Docker engine's built-in Dockerfile frontend, so no
# frontend image is pulled (DEV-p5-containers-12). If one is ever added, check-images.sh requires it
# pinned by version and digest.
# nginx 1.30 (the stable line) from nginx's own unprivileged image: runs as uid 101 and listens on 8080.
# The one root step is the OS package floor below; the image's USER goes back to 101 right after it.

# --- build: the production bundle and the generated header config ----------------------------------
FROM node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build
WORKDIR /build/web
COPY web/package.json web/pnpm-lock.yaml ./
# pnpm at the version in web/package.json "packageManager", through corepack. No pnpm-workspace.yaml
# here, so only web/ installs; dev dependencies are needed to build, and stay in this stage.
RUN corepack enable pnpm \
 && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile --ignore-scripts
COPY web/ ./
COPY docker/web/security-headers.ts /build/docker/web/security-headers.ts
# First, so a missing web/securityHeaders.ts fails in seconds, before the bundle is built.
RUN mkdir -p /build/out \
 && node /build/docker/web/security-headers.ts securityHeaders.ts > /build/out/security-headers.conf
# vite copies all of public/ into dist/, including MSW's service worker (mockServiceWorker.js, from the
# msw dev dependency). Only the Pages and msw modes register it; the production build never does, so
# it is left out of the image (AC-CTR-02, Q-p5-containers-3).
RUN COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm build \
 && rm dist/mockServiceWorker.js

# --- runtime -----------------------------------------------------------------------------------
FROM nginxinc/nginx-unprivileged:1.30.6-alpine3.24@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03 AS runtime
ENV API_UPSTREAM=http://api:3000 \
    ROUTE_STUB_CONTROL=off \
    NGINX_ENVSUBST_FILTER=^(API_UPSTREAM|ROUTE_STUB_CONTROL)$
# Alpine's security fixes that the pinned nginx base (Alpine 3.24.2) does not carry yet: the same step and
# the same floors as docker/api.Dockerfile (owner's answer to Q-p5-image-cves-3 (a); spec/worklogs/
# p5-image-scan.md has the sources). Fixed versions from Alpine's secdb, v3.24 main
# (secdb.alpinelinux.org/v3.24/main.json), checked against aports 3.24-stable and the v3.24 main index:
#   libcrypto3, libssl3 >= 3.5.9-r1 (openssl): CVE-2026-95691, CVE-2026-95692, CVE-2026-88823,
#     CVE-2026-107496, CVE-2026-88822 (the base has 3.5.9-r0).
#   zlib >= 1.4-r0: CVE-2026-85091 (fixed in 1.3.2-r1) and CVE-2026-4738 (fixed in 1.4-r0); the base has
#     1.3.2-r0, one release older than the node base's.
# Unlike the API, nginx itself links these (libssl.so.3, libcrypto.so.3, libz.so.1), for TLS and gzip, both
# of which this config leaves off (plain HTTP on 8080, base nginx.conf's `#gzip on;`). The floors are apk version constraints, so apk's solver fails
# the build on a floor no package satisfies or one that is not a valid version (sec-01, fail closed).
# docker/check-images.sh reads this line as the one list of floors, checks the built image against it, and
# refuses any other apk instruction, option, repository or key. apk needs root; USER goes back to the
# base's 101 at once. Remove the step once Dependabot moves the FROM line to a base that has these versions.
USER root
RUN apk add --no-cache 'libcrypto3>=3.5.9-r1' 'libssl3>=3.5.9-r1' 'zlib>=1.4-r0'
USER 101
# Owned by root, read-only for nginx (uid 101).
COPY --from=build /build/web/dist /srv/ascrum
COPY --from=build /build/out/security-headers.conf /etc/nginx/ascrum/security-headers.conf
COPY docker/web/default.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --start-interval=1s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/"]
