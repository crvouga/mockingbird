# The docs site, hosted on the crvouga/workspace fleet (https://raw.githubusercontent.com/crvouga/workspace/main/llms.txt §4).
# Build context is the repo root: the site renders every service package, so turbo builds them first.
#   docker build -f sites/docs/Dockerfile -t mockingbird-docs . && docker run --rm -p 8080:80 mockingbird-docs

FROM oven/bun:1.4.0 AS bun

FROM node:22-bookworm-slim AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
ENV HUSKY=0 TURBO_TELEMETRY_DISABLED=1
COPY . .
RUN bun install --frozen-lockfile
# bunx is a separate symlink; only the bun binary is copied in above.
RUN bun x turbo run build --filter=@crvouga/mockingbird-docs... --output-logs=errors-only

FROM nginx:1.29-alpine
COPY --from=build /app/sites/docs/dist /usr/share/nginx/html
EXPOSE 80
