# @crvouga/mockingbird-service-medplum

Stateful Medplum mock that runs the **real Medplum server** instead of reimplementing its API surface. Built for [Mockingbird](https://github.com/crvouga/mockingbird), the catalog of stateful mock servers that speak `fetch(Request) -> Response`.

## How it works

Rather than hand-implementing a FHIR-shaped fake, this package:

1. Ensures a pinned Medplum monorepo clone is built under the shared cache (`~/.cache/mockingbird/medplum-server/<version>`) using the official [install-from-scratch](https://www.medplum.com/docs/self-hosting/install-from-scratch) flow (`git clone` -> `npm ci` -> `npm run build:fast`). One-time cost, cached across runs; override the location with `MEDPLUM_MOCK_CACHE_DIR` and the tag with `MOCKINGBIRD_MEDPLUM_VERSION` (default `v5.1.37`).
2. Boots [embedded-postgres](https://github.com/leinelissen/embedded-postgres) (real Postgres binaries) and [redis-memory-server](https://github.com/mhassan1/redis-memory-server) (in-process `redis-server`) on ephemeral free ports.
3. Generates a per-run `medplum.config.json` in a temp dir and spawns `packages/server/dist/index.js` from the clone as a child process.
4. Waits for `/healthcheck`, then exposes the server through the Mockingbird `FetchAPI` contract by proxying requests over native `fetch` to the internal base URL.

```ts
import { createMedplumAPI } from "@crvouga/mockingbird-service-medplum"

const medplum = await createMedplumAPI()
try {
  const token = await medplum.getAccessToken()
  const response = await medplum.fetch(new URL("/fhir/R4/Patient", medplum.getBaseUrl()), {
    headers: { authorization: `Bearer ${token}` },
  })
} finally {
  await medplum.stop()
}
```

## Lifecycle

The core `FetchAPI` contract has no lifecycle, so this package follows the adapter convention of explicit async lifecycle calls on the concrete class:

| Call | Behavior |
| --- | --- |
| `await medplum.start()` | Boot Postgres + Redis, ensure the clone build, spawn the server, poll `/healthcheck` |
| `medplum.fetch(request)` | Proxy to the running server (origin rewritten to the internal base URL) |
| `await medplum.reset()` | Stop the server, drop and recreate the `medplum` database, restart — the server re-runs migrations and seeding, restoring pristine state |
| `await medplum.stop()` | Graceful stop: SIGTERM then SIGKILL, shut down Redis and Postgres, remove the temp dir |

`createMedplumAPI(options)` is an async factory that calls `start()` for you. A process-exit guard kills the children if the parent dies unexpectedly.

## Seeded credentials

First boot seeds Medplum's example project and super admin (`admin@example.com` / `medplum_admin`, per [Run the stack](https://www.medplum.com/docs/contributing/run-the-stack)) plus a `ClientApplication` created from the config's `defaultSuperAdminClientId`/`defaultSuperAdminClientSecret` (the client id must be a UUID — Medplum validates resource ids). `getAccessToken()` performs the seeded-client authorization-code + PKCE flow against `/auth/login` and `/oauth2/token` and caches the bearer token. Exported constants: `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD`, `SUPER_ADMIN_CLIENT_ID`, `SUPER_ADMIN_CLIENT_SECRET`.

## Notes for package managers

- **Bun**: postinstall scripts of `embedded-postgres` and `redis-memory-server` must be trusted; the repo root lists them under `trustedDependencies`.
- **pnpm**: approve the build scripts once (`pnpm approve-builds`) or set `REDISMS_DISABLE_POSTINSTALL=true` to defer the Redis binary download to the first `start()`.

## Testing

Tests are property-based per repo policy. The always-on properties cover config generation and port picking without touching the network. The full self-hosted properties (server boot, self-parity between two independent servers, reset semantics, stop/restart lifecycle) run when `MOCKINGBIRD_MEDPLUM_E2E=1`:

```bash
MOCKINGBIRD_MEDPLUM_E2E=1 bun test
```

The first E2E run pays the clone/build cost (several minutes, logged); later runs reuse the cache.

## Requirements

- Node.js >= 22.18
- `git` on PATH (for the one-time clone)
- `make` for the `redis-memory-server` binary compile (see its README); the binary is cached after the first build
