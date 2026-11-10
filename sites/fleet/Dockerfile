# Mockingbird Fleet Cloud: one stateless image holding the control API, the dashboard and every
# HTTP emulator. Hosted as the fleet service `mockingbird-fleet` (https://www.chrisvouga.dev/llms-cloud.txt §4).
# Build context is the repo root: the server bundles every service package, so turbo builds them first.
#   docker build -f sites/fleet/Dockerfile -t mockingbird-fleet .
#   docker run --rm -p 8080:8080 -e AUTH_DEV_LOGIN=1 mockingbird-fleet   # loopback only, in-memory

FROM oven/bun:1.4.0 AS bun

# Only the lockfile and every workspace's package.json. The build stage copies this before the
# source, so a source edit leaves its install layer cached.
FROM oven/bun:1.4.0 AS manifests
WORKDIR /src
COPY . .
RUN mkdir /manifests \
  && cp bun.lock /manifests/ \
  && find . -name package.json -not -path "*/node_modules/*" -exec cp --parents {} /manifests/ \;

FROM node:22-bookworm-slim AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
# Package builds spawn `bunx` (a symlink to bun in the official image).
RUN ln -sf bun /usr/local/bin/bunx
WORKDIR /app
ENV HUSKY=0 TURBO_TELEMETRY_DISABLED=1
COPY --from=manifests /manifests ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun x turbo run build --filter=@crvouga/mockingbird-fleet-cloud... --output-logs=errors-only

# The bundle is self-contained: its only imports outside dist/ are Bun built-ins. No node_modules ships.
FROM oven/bun:1.4.0-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build --chown=bun:bun /app/sites/fleet/dist ./dist
USER bun
EXPOSE 8080
STOPSIGNAL SIGTERM
CMD ["bun", "dist/main.js"]
