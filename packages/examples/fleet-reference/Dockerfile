# Build from the repository root. Pin source revision and this multi-architecture digest together.
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS build
WORKDIR /build
COPY package.json bun.lock turbo.json tsconfig.base.json biome.json ./
COPY packages ./packages
COPY scripts ./scripts
COPY sites/docs/package.json ./sites/docs/package.json
RUN command -v node || ln -s /usr/local/bin/bun /usr/local/bin/node
RUN bun install --frozen-lockfile --ignore-scripts
# Every service build embeds its admin vendor brand (scripts/admin-brand.ts) from the docs data.
COPY sites/docs/src/lib/admin-brands.ts sites/docs/src/lib/types.ts ./sites/docs/src/lib/
COPY sites/docs/src/data/brands.json ./sites/docs/src/data/brands.json
COPY sites/docs/public/brands ./sites/docs/public/brands
RUN bunx turbo run build --filter=@crvouga/mockingbird-service-stripe --filter=@crvouga/mockingbird-service-postgres --filter=@crvouga/mockingbird-service-redis --concurrency=2
RUN bun build packages/examples/fleet-reference/entrypoint.ts --target=bun --outfile=/out/fleet.js
RUN bun packages/examples/fleet-reference/inventory.ts > /out/inventory.json

FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895
WORKDIR /app
RUN mkdir -p /state && chown bun:bun /state
COPY --from=build --chown=bun:bun /out/ /app/
USER bun
EXPOSE 9000 9001 5432 6379
STOPSIGNAL SIGTERM
ENTRYPOINT ["bun", "/app/fleet.js"]
