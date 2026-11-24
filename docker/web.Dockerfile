# syntax=docker/dockerfile:1
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

ARG NODE_IMAGE=node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
# nginx 1.30 (the stable line) from nginx's own unprivileged image: runs as uid 101 and listens on 8080,
# so no root step is needed anywhere. Pinned by version and digest.
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.30.6-alpine3.24@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03

# --- build: the production bundle and the generated header config ----------------------------------
FROM ${NODE_IMAGE} AS build
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
FROM ${NGINX_IMAGE} AS runtime
ENV API_UPSTREAM=http://api:3000 \
    ROUTE_STUB_CONTROL=off \
    NGINX_ENVSUBST_FILTER=^(API_UPSTREAM|ROUTE_STUB_CONTROL)$
# Owned by root, read-only for nginx (uid 101).
COPY --from=build /build/web/dist /srv/ascrum
COPY --from=build /build/out/security-headers.conf /etc/nginx/ascrum/security-headers.conf
COPY docker/web/default.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --start-interval=1s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/"]
