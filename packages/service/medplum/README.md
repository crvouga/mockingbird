# @crvouga/mockingbird-service-medplum

Stateful Medplum "mock" that runs the **real [Medplum](https://www.medplum.com/) server** rather
than reimplementing its FHIR API. It self-hosts a pinned Medplum build as a child process on
embedded Postgres and a throwaway `redis-server` process, and exposes it through a Fetch-style
contract (`fetch(Request) -> Response`) plus explicit `start` / `reset` / `stop` lifecycle calls.

Use it for integration tests that need genuine Medplum/FHIR behaviour (search, validation,
auth, versioning) without a hosted Medplum project. Because it runs the real server, the full
Medplum API is available; the vendored contract used for parity covers healthcheck, the login and
token flow, and Patient search/create/read/update/delete
([SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/medplum/SUPPORT.md)).

Costs to know before choosing it: the **first** `start()` clones and builds Medplum (several
minutes, network required); every `start()` boots Postgres, Redis and the server (seconds, not
milliseconds). Share one instance per test file or suite, not per test.

## Install

```bash
npm install -D @crvouga/mockingbird-service-medplum
```

Requirements:

- Node.js >= 22.18 (`engines`). Also used under Bun by this repo's own tests.
- `git` and `npm` on `PATH` for the one-time clone and build
  (`git clone` -> `npm ci` -> `npm run build:fast`, following Medplum's
  [install-from-scratch](https://www.medplum.com/docs/self-hosting/install-from-scratch) flow).
- A `redis-server` binary on `PATH` (macOS: `brew install redis`, Debian/Ubuntu:
  `apt-get install redis-server`). Set `MOCKINGBIRD_REDIS_SERVER` to point at it if it lives
  elsewhere. It is spawned per run with persistence disabled; nothing is compiled or downloaded.
- The postinstall script of `embedded-postgres` must run:
  - **Bun**: list it under `trustedDependencies` in your root `package.json`.
  - **pnpm**: approve it once with `pnpm approve-builds`.
- Disk under `~/.cache/mockingbird/medplum-server/<version>` for the Medplum clone and build.

## Usage

### Lifecycle

| Call | Behaviour |
| --- | --- |
| `await createMedplumAPI(options?)` | Construct a `MedplumAPI` and `await start()` it. |
| `await medplum.start()` | Pick free ports; boot embedded Postgres (database `medplum`) and a `redis-server` child process; ensure the Medplum build exists in the cache (clone/build on first run); write a per-run `medplum.config.json` into a temp dir; spawn `packages/server/dist/index.js` with the current runtime (`process.execPath`); poll `GET /healthcheck` (up to 5 minutes). Idempotent and safe to call concurrently. |
| `medplum.fetch(request)` | Proxy the request to the running server. Only the path and query of `request.url` are used, so any origin works. Redirects are returned, not followed. |
| `await medplum.reset()` | Stop the server, drop and recreate the `medplum` database, restart and wait for healthy. The server re-runs migrations and seeding on boot, so state is pristine. Clears the cached access token. Throws if not started. |
| `await medplum.stop()` | SIGTERM the server (SIGKILL after 10s), stop Redis and Postgres, delete the temp dir. No-op if not started. |

A process exit / SIGINT / SIGTERM guard kills the child processes if your test runner dies. The
first run's clone/build steps have timeouts of 10 minutes (clone), 30 minutes (`npm ci`) and 60
minutes (build); progress goes to `onLog` and to `<cacheRoot>/<version>.log`.

### Seeded credentials and tokens

Each boot seeds Medplum's example project and super admin (`admin@example.com` /
`medplum_admin`, exported as `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD`) and a
`ClientApplication` for the mock's fixed client id. `getAccessToken()` logs in with those
credentials (`POST /auth/login`, PKCE `plain`) and exchanges the code at `POST /oauth2/token`,
returning a bearer token that is cached until `reset()` or `stop()`. Send it as
`Authorization: Bearer <token>`.

### Example

```ts
import { createMedplumAPI } from "@crvouga/mockingbird-service-medplum"

const medplum = await createMedplumAPI({ onLog: (message) => console.log(message) })
try {
  const token = await medplum.getAccessToken()
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/fhir+json" }

  // Direct HTTP against the internal base URL (http://127.0.0.1:<apiPort>/):
  const created = await fetch(new URL("/fhir/R4/Patient", medplum.getBaseUrl()), {
    method: "POST",
    headers,
    body: JSON.stringify({ resourceType: "Patient", name: [{ given: ["Ada"], family: "Lovelace" }] }),
  })
  const patient = (await created.json()) as { id: string }

  // Through fetch(request) (any origin; path and query are forwarded):
  const read = await medplum.fetch(
    new Request(`https://medplum.test/fhir/R4/Patient/${patient.id}`, { headers }),
  )
  console.log(read.status) // 200
} finally {
  await medplum.stop()
}
```

### Pointing the Medplum SDK (or any client) at it

The server listens on `http://127.0.0.1:<apiPort>/` (`getBaseUrl()`), with CORS open
(`allowedOrigins: "*"`) and rate limits disabled. For `@medplum/core`'s `MedplumClient`, pass that
URL as `baseUrl` and sign in with the seeded super admin, or hand it the token:

```js
import { MedplumClient } from "@medplum/core"

const client = new MedplumClient({ baseUrl: medplum.getBaseUrl() })
client.setAccessToken(await medplum.getAccessToken())
await client.searchResources("Patient")
```

### Resetting between tests

`reset()` restarts the server on a fresh database, so it costs roughly one server boot. Prefer
unique data per test and reset between files or suites:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test"
import { MedplumAPI } from "@crvouga/mockingbird-service-medplum"

const medplum = new MedplumAPI()
beforeAll(() => medplum.start(), 15 * 60 * 1000) // first run builds Medplum
afterAll(() => medplum.stop())

test("healthcheck", async () => {
  const response = await medplum.fetch(new Request("http://medplum.test/healthcheck"))
  expect(response.status).toBe(200)
})

test("starts clean after reset", async () => {
  await medplum.reset()
  const token = await medplum.getAccessToken()
  const response = await medplum.fetch(
    new Request("http://medplum.test/fhir/R4/Patient?name=Lovelace", {
      headers: { authorization: `Bearer ${token}` },
    }),
  )
  expect(response.status).toBe(200)
}, 5 * 60 * 1000)
```

## API

| Export | Description |
| --- | --- |
| `MedplumAPI` | Class. `new MedplumAPI(options?)`; implements the Fetch contract `fetch(request: Request): Promise<Response>`. Does not start anything until `start()`. |
| `createMedplumAPI` | `(options?) => Promise<MedplumAPI>` — construct and `start()`. |
| `SUPER_ADMIN_EMAIL` | `"admin@example.com"` — seeded super admin email. |
| `SUPER_ADMIN_PASSWORD` | `"medplum_admin"` — seeded super admin password. |
| `buildServerConfig` | `(input: { apiPort, dbPort, redisPort, dataDir, superAdminEmail?, superAdminPassword? }) => MedplumServerConfig` — the `medplum.config.json` the mock writes. |
| `resolveMedplumPaths` | `(options?: { version?, cacheDir? }) => MedplumPaths` — where the clone, server entry and build marker live. |

`MedplumAPI` members:

| Member | Description |
| --- | --- |
| `start()` / `stop()` / `reset()` | Lifecycle, see Usage. |
| `fetch(request)` | Proxy one request to the running server. |
| `getAccessToken()` | `Promise<string>` — cached bearer token for the seeded super admin. |
| `getBaseUrl()` | `"http://127.0.0.1:<apiPort>/"`; throws if not started. |
| `apiPort` | Port of the running server; throws if not started. |
| `isStarted` | `boolean`. |

Options and types:

```text
type MedplumAPIOptions = {
  version?: string                  // Medplum git tag; default MOCKINGBIRD_MEDPLUM_VERSION env, else "v5.1.37"
  cacheDir?: string                 // cache root; default MEDPLUM_MOCK_CACHE_DIR env, else ~/.cache/mockingbird/medplum-server
  onLog?: (message: string) => void // build progress and server stdout/stderr
  email?: string                    // login for getAccessToken(); default SUPER_ADMIN_EMAIL
  password?: string                 // default SUPER_ADMIN_PASSWORD
}
type MedplumProcessOptions = { version?; cacheDir?; onLog? }
type MedplumPaths = { version; cacheRoot; cloneDir: "<cacheRoot>/<version>"; serverEntry; buildMarker }
type MedplumProcessInfo = { apiPort; dbPort; redisPort; baseUrl; dataDir; paths; config }
type MedplumServerConfig             // shape of medplum.config.json (see buildServerConfig)
```

`email` / `password` only change which credentials `getAccessToken()` sends; the server always
seeds `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD`.

## Development

For contributors to the mockingbird repo only.

Tests are property-based. The always-on properties cover config generation and port picking
without touching the network. The full self-hosted properties (server boot, self-parity between
two independent servers, reset semantics, stop/restart lifecycle) run only with
`MOCKINGBIRD_MEDPLUM_E2E=1`:

```bash
bun test
MOCKINGBIRD_MEDPLUM_E2E=1 bun test   # first run pays the clone/build cost (several minutes, logged)
```

In this repo, the root `package.json` already lists `embedded-postgres` under
`trustedDependencies`.

Part of [mockingbird](https://github.com/crvouga/mockingbird) — agent integration guide: [README](https://github.com/crvouga/mockingbird#readme) · [llms.txt](https://github.com/crvouga/mockingbird/blob/main/llms.txt).
