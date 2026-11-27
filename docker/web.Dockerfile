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
FROM node:26.13.1-alpine3.24@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS build
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
FROM nginxinc/nginx-unprivileged:1.31.7-alpine3.24@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e AS runtime
ENV API_UPSTREAM=http://api:3000 \
    ROUTE_STUB_CONTROL=off \
    NGINX_ENVSUBST_FILTER=^(API_UPSTREAM|ROUTE_STUB_CONTROL)$
# Alpine's security fixes that the pinned nginx base (Alpine 3.24.2) does not carry yet (owner's answers to
# Q-p5-image-cves-3 (a) and Q-p5-image-scan-2 (a); spec/worklogs/p5-image-scan.md has the sources). Fixed
# versions from Alpine's secdb, v3.24 main (secdb.alpinelinux.org/v3.24/main.json), each checked against
# the aports 3.24-stable APKBUILD's secfixes and the v3.24 main index:
#   libcrypto3, libssl3 >= 3.5.9-r1 (openssl): CVE-2026-95691, -95692, -88823, -107496, -88822.
#   zlib >= 1.4-r0: CVE-2026-85091 (fixed in 1.3.2-r1) and CVE-2026-4738 (1.4-r0).
#   brotli-libs >= 1.2.1-r0 (brotli): CVE-2026-111497.
#   libexpat >= 2.10.0-r0 (expat): CVE-2026-113351, -115506, -117610, -118370.
#   libxslt >= 1.1.43-r4: CVE-2026-9947, -87636, -125350 (and CVE-2025-10911).
#   libxml2 >= 2.13.9-r3: CVE-2026-86144.
#   curl, libcurl >= 8.23.0-r0 (curl): CVE-2026-92392 among the 24 CVEs secdb lists for 8.23.0-r0.
#   musl, musl-utils >= 1.2.6-r3 (musl): CVE-2026-107891.
# nginx itself (1.30.6-r1, six HIGH/CRITICAL CVEs fixed in 1.30.7) comes from nginx.org's repository, not
# Alpine's, so no floor here can raise it; docker/scan-images.sh reports it in a dated, nginx-only window
# until the base image has nginx >= 1.30.7 (Q-p5-image-scan-2 (c)).
# Unlike the API, nginx links Alpine's OpenSSL and zlib (libssl.so.3, libcrypto.so.3, libz.so.1), for TLS
# and gzip, both of which this config leaves off (plain HTTP on 8080, base nginx.conf's `#gzip on;`). The
# floors are apk version constraints, so apk's solver fails the build on a floor no package satisfies or
# one that is not a valid version (sec-01, fail closed). docker/check-images.sh reads this instruction as
# the one list of floors, checks the built image against it, and refuses any other apk instruction, option,
# repository or key. apk needs root; USER goes back to the base's 101 at once. Remove a floor once
# Dependabot moves the FROM line to a base that has that version.
USER root
RUN apk add --no-cache 'libcrypto3>=3.5.9-r1' 'libssl3>=3.5.9-r1' 'zlib>=1.4-r0' \
      'brotli-libs>=1.2.1-r0' 'libexpat>=2.10.0-r0' 'libxslt>=1.1.43-r4' 'libxml2>=2.13.9-r3' \
      'curl>=8.23.0-r0' 'libcurl>=8.23.0-r0' 'musl>=1.2.6-r3' 'musl-utils>=1.2.6-r3'
USER 101
# Owned by root, read-only for nginx (uid 101).
COPY --from=build /build/web/dist /srv/ascrum
COPY --from=build /build/out/security-headers.conf /etc/nginx/ascrum/security-headers.conf
COPY docker/web/default.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --start-interval=1s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/"]
