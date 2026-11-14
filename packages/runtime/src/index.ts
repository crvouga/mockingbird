/**
 * The shared Mockingbird runtime, published once so every emulator service depends on the same
 * copy. Each subpath re-exports one workspace helper (`@crvouga/mockingbird-runtime/<subpath>` is
 * `@crvouga/mockingbird-<subpath>`); a service's build imports these instead of inlining its own
 * copy (scripts/bundle-service-runtime.ts).
 */

/** Every subpath this package exports, in `package.json` order. */
export const RUNTIME_SUBPATHS = [
  "core",
  "openapi",
  "openapi-metadata",
  "http-codec",
  "http-provider",
  "mqtt-broker",
  "mqtt-broker/node",
  "ui",
  "sqlite",
  "service",
  "service/admin",
  "adapter-node",
] as const
