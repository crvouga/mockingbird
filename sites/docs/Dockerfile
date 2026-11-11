# The docs site, hosted by crvouga/personal (https://www.chrisvouga.dev/llms-cloud.txt §4).
# Build context is the repo root: the site renders every service package, so turbo builds them first.
#   docker build -f sites/docs/Dockerfile -t mockingbird-docs . && docker run --rm -p 8080:80 mockingbird-docs

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
# bunx is a separate symlink; only the bun binary is copied in above.
RUN bun x turbo run build --filter=@crvouga/mockingbird-docs... --output-logs=errors-only

# The server is self-contained: Astro bundles its dependencies into dist/server, whose only import
# outside it is bun:sqlite. No node_modules ships.
FROM oven/bun:1.4.0-slim
WORKDIR /app/sites/docs
ENV HOST=0.0.0.0 PORT=80 WEBHOOK_DB=/data/events.sqlite
COPY --from=build /app/sites/docs/dist ./dist
COPY --from=build /app/sites/docs/package.json ./package.json
COPY --from=build /app/sites/docs/server ./server
EXPOSE 80
# server/index.ts wraps Astro's handler with the security headers.
CMD ["bun", "./server/index.ts"]
