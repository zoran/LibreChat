# syntax=docker/dockerfile:1.19

# v0.8.8

# Public immutable ClamAV/glibc payload is built separately; the application stays Alpine/musl.
FROM node:24.16.0-bookworm-slim AS antivirus-build
RUN apt-get update && apt-get install -y --no-install-recommends \
      gcc libc6-dev binutils libgcc-s1 libstdc++6 ca-certificates
WORKDIR /build
ADD --checksum=sha256:d3ee9e401974855a1edc1761b1425417d126de618d5f0c91cd51209f69f6fcc2 https://www.clamav.net/downloads/production/clamav-1.4.6.linux.x86_64.deb /build/clamav.deb
ADD --checksum=sha256:06dbc7adf96e2f6a27c548a841ce83c95360d1e121b106a6f7cf56f282a3c61b https://www.clamav.net/downloads/production/clamav-1.4.6.tar.gz /build/clamav-source.tar.gz
ADD --checksum=sha256:f55ae2aa17482cf870f16578e56c2d77885c22ac748ebee9f6808c4dbba93bea https://www.clamav.net/downloads/production/clamav-1.4.6.tar.gz.sig /build/clamav-source.tar.gz.sig
COPY scripts/ci/antivirus-assets.mjs /build/antivirus-assets.mjs
COPY packages/api/src/uploads/security/native/antivirus-scope.c /build/antivirus-scope.c
RUN test "$(dpkg --print-architecture)" = amd64 && \
    mkdir /out /build/vendor && dpkg-deb --extract /build/clamav.deb /build/vendor && \
    cc -O2 -Wall -Wextra -Werror -fstack-protector-strong -D_FORTIFY_SOURCE=2 \
      -Wl,-z,relro,-z,now /build/antivirus-scope.c -o /build/antivirus-scope && \
    node /build/antivirus-assets.mjs && rm -rf /var/lib/apt/lists/*

# Base node image
FROM node:24.16.0-alpine AS node

RUN apk upgrade --no-cache
RUN apk add --no-cache jemalloc git setpriv util-linux-misc
RUN apk add --no-cache python3 py3-pip uv

# Set environment variable to use jemalloc
ENV LD_PRELOAD=/usr/lib/libjemalloc.so.2
# Disable dependency installation analytics before any npm lifecycle scripts run.
ENV SCARF_ANALYTICS=false

# Add `uv` for extended MCP support
COPY --from=ghcr.io/astral-sh/uv:0.9.5-python3.12-alpine /usr/local/bin/uv /usr/local/bin/uvx /bin/
RUN uv --version

# Set configurable max-old-space-size with default
ARG NODE_MAX_OLD_SPACE_SIZE=6144
ARG NPM_CI_TIMEOUT_SECONDS=1500
ARG NPM_CI_ATTEMPTS=2

RUN mkdir -p /app && chown node:node /app
WORKDIR /app

USER node

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node api/package.json ./api/package.json
COPY --chown=node:node client/package.json ./client/package.json
COPY --chown=node:node packages/data-provider/package.json ./packages/data-provider/package.json
COPY --chown=node:node packages/data-schemas/package.json ./packages/data-schemas/package.json
COPY --chown=node:node packages/api/package.json ./packages/api/package.json

RUN \
    # Allow mounting of these files, which have no default
    touch .env ; \
    # Create directories for the volumes to inherit the correct permissions
    mkdir -p /app/client/public/images /app/logs /app/uploads /app/skill /app/data ; \
    chmod 1777 /app/data ; \
    npm config set fetch-retry-maxtimeout 600000 ; \
    npm config set fetch-retries 5 ; \
    npm config set fetch-retry-mintimeout 15000 ; \
    attempt=1 ; \
    until timeout "$NPM_CI_TIMEOUT_SECONDS" npm ci --no-audit ; do \
        status=$? ; \
        if [ "$attempt" -ge "$NPM_CI_ATTEMPTS" ]; then \
            exit "$status" ; \
        fi ; \
        echo "npm ci --no-audit failed with exit code $status; retrying attempt $((attempt + 1))/$NPM_CI_ATTEMPTS" ; \
        attempt=$((attempt + 1)) ; \
        npm cache clean --force || true ; \
        sleep 10 ; \
    done

# Keep the CI artifact out of image layers; the build step reads it from the context.
COPY --chown=node:node --exclude=ci-build . .

ARG VITE_MCP_SANDBOX_URL=
ARG PREBUILT_FRONTEND_COMMIT=
RUN --mount=type=bind,target=/build-context \
    if [ -n "$PREBUILT_FRONTEND_COMMIT" ]; then \
        node scripts/ci/frontend-build.mjs install \
            --revision "$PREBUILT_FRONTEND_COMMIT" --directory /build-context/ci-build ; \
    else \
        # React client build with configurable memory
        NODE_OPTIONS="--max-old-space-size=${NODE_MAX_OLD_SPACE_SIZE}" npm run frontend ; \
    fi && \
    npm prune --production && \
    npm cache clean --force

# Build the actual parser assets after either workspace build path and production pruning.
# This is packaging evidence; host/kernel qualification is a separate deployment gate.
USER root
RUN node scripts/ci/security-process-assets.mjs
RUN --mount=type=bind,from=antivirus-build,source=/out,target=/antivirus-build,ro \
    node scripts/ci/antivirus-image-assets.mjs
USER node

# Optional build metadata surfaced in Settings -> About for support triage.
# Declared here (after the heavy install/build steps) so that commit/date
# changing on every CI run does not bust the cache for dependency install
# and frontend build layers. When unset, the backend falls back to local
# git resolution (if .git is present), and finally to empty values.
ARG BUILD_COMMIT=
ARG BUILD_BRANCH=
ARG BUILD_DATE=
ENV BUILD_COMMIT=${BUILD_COMMIT}
ENV BUILD_BRANCH=${BUILD_BRANCH}
ENV BUILD_DATE=${BUILD_DATE}

# Node API setup
EXPOSE 3080
ENV HOST=0.0.0.0
CMD ["npm", "run", "backend"]

# Optional: for client with nginx routing
# FROM nginx:stable-alpine AS nginx-client
# WORKDIR /usr/share/nginx/html
# COPY --from=node /app/client/dist /usr/share/nginx/html
# COPY client/nginx.conf /etc/nginx/conf.d/default.conf
# ENTRYPOINT ["nginx", "-g", "daemon off;"]
