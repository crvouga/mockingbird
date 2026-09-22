# @crvouga/mockingbird-service-medplum

Stateful, in-process mock of a self-hosted [Medplum](https://www.medplum.com/) server (v5.1.37)
for test suites. It covers:

- **FHIR R4 REST**: create, read, update, delete, conditional writes, JSON Patch, versioning and
  history, and search with the server's semantics (chained, `_has`, `_filter`, `_include` /
  `_revinclude`, `_sort`, `_total`, `_summary`, `_elements`, offset and cursor paging).
- **Operations**: batch and transaction bundles, `$validate`, `$expunge`, `Patient/$everything`,
  GraphQL, and Binary storage with signed attachment URLs.
- **Auth**: OAuth2 password login with PKCE, authorization code, client credentials, refresh
  tokens with rotation, and Basic auth, all as ES384 JWTs with a JWKS.
- **Access control and admin**: access policies, and the project admin API (invite, clients,
  members).

It is built on `@medplum/core` and the server's own FHIR router (`@medplum/fhir-router`, vendored),
so validation messages, search results and OperationOutcomes match the server's.

**Portable**: it needs no child process, database or native module. State lives in an in-memory
SQLite engine written in TypeScript, and crypto is WebCrypto. It runs anywhere JavaScript does:
Node, Bun, workerd (Cloudflare Workers) and browsers. The `./server` entry and the CLI are
the only Node-specific parts.

Parity is proven against the real thing. Every scenario in `test/scenarios` (32 scenarios, 481
exchanges: status, headers and body) and seeded random walks run against a self-hosted Medplum
v5.1.37 and the mock, and they must agree exchange by exchange. The oracle's recording replays
in CI.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/medplum/SUPPORT.md)
- Medplum docs: https://www.medplum.com/docs · FHIR R4: https://hl7.org/fhir/R4/

## Install

```bash
npm install -D @crvouga/mockingbird-service-medplum
```

ESM only. Requires Node >= 22 or Bun >= 1.2 (any runtime with WebCrypto and
`DecompressionStream` for the portable entry). `@medplum/core` is a dependency; bring your own
`@medplum/core` `MedplumClient` if you use the SDK.

## Usage

### In-process with the Medplum SDK

```ts
import { MedplumClient } from "@medplum/core"
import type { Patient } from "@medplum/fhirtypes"
import { DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET, MedplumAPI } from "@crvouga/mockingbird-service-medplum"

const mock = new MedplumAPI() // answers as http://localhost:8103/
const medplum = new MedplumClient({
  baseUrl: "http://localhost:8103/",
  fetch: (url: string, init?: RequestInit) => mock.fetch(new Request(url, init)),
})
await medplum.startClientLogin(DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET)

const patient = await medplum.createResource<Patient>({
  resourceType: "Patient",
  name: [{ given: ["Ada"], family: "Lovelace" }],
})
const found = await medplum.searchResources("Patient", { name: "lovelace" })
console.log(found[0]?.id === patient.id) // true

await mock.reset() // back to the seeded state
```

Every `MedplumAPI` seeds what a fresh self-hosted server seeds, which is the super admin
(`admin@example.com` / `medplum_admin`) and the R4 base project. It also seeds a ready project,
**Mockingbird** (`DEFAULT_PROJECT_ID`), with a project-admin client application
(`DEFAULT_CLIENT_ID` / `DEFAULT_CLIENT_SECRET`). Pass `project: false` to seed only what the
server does.

### `mockingbird-medplum serve`

```bash
npx mockingbird-medplum serve                     # http://127.0.0.1:8103
npx mockingbird-medplum serve --port 0 --client-id 0b9e4a5c-0000-4000-8000-00000000c1d1 --client-secret local
npx mockingbird-medplum serve --help
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--port <n>` | `8103` | Port to listen on (`0` for any free port) |
| `--host <host>` | `127.0.0.1` | Interface to bind |
| `--base-url <url>` | the listening address | Public base URL the server answers as (`fullUrl`s, `Location`, token issuer) |
| `--client-id <uuid>` / `--client-secret <secret>` | `DEFAULT_CLIENT_ID` / `DEFAULT_CLIENT_SECRET` | The default project's client application |
| `--project-id <uuid>` | `DEFAULT_PROJECT_ID` | The default project's id |
| `--super-admin-email <email>` / `--super-admin-password <password>` | `admin@example.com` / `medplum_admin` | The seeded super admin |
| `--admin-key <key>` | open | Require `x-mockingbird-admin-key` on `/__admin/*` |
| `--log <pretty\|json\|off>` | `pretty` | One line per request |
| `--config <file>` | — | Serve every service in a `mockingbird.json` (use `"medplum"` as the service name) |

It prints the listening address and the seeded client credentials. Point `MedplumClient`
(`baseUrl: "http://127.0.0.1:8103/"`) or your backend's Medplum base URL at it.

### `createServer` (Node)

```ts
import { MedplumClient } from "@medplum/core"
import { createServer } from "@crvouga/mockingbird-service-medplum/server"

const server = await createServer() // any free port; the base URL is the listening address
const medplum = new MedplumClient({ baseUrl: `${server.url}/` })
// ...
await server.close()
```

`createServer(options)` takes every `createRuntime` option plus `port` (default `0`) and `host`
(default `127.0.0.1`). The result has `url`, `port`, `runtime` and `close()`.

### `createRuntime` (any Fetch server)

`createRuntime` is the whole served mock as a single runtime-neutral `fetch(request)`. That
includes health, the `/__admin/*` control plane, namespaces, the clock, faults and the request
journal. Hand it to `Bun.serve`, a Worker or Deno, or call it directly:

```ts
import { createRuntime } from "@crvouga/mockingbird-service-medplum"

const medplum = createRuntime({ baseUrl: "https://medplum.test/" })
export default { fetch: (request: Request) => medplum.fetch(request) }
```

Namespaces isolate data. A request picks one with `x-mockingbird-namespace: <name>`, with a
`/ns/<name>/` base-URL prefix (`new MedplumClient({ baseUrl: "http://localhost:8103/ns/worker-1/" })`),
or through its client id (`PUT /__admin/credentials {"credentials": {"<clientId>": "<namespace>"}}`).
A client is recognized from Basic auth, from a bearer token's `client_id`, or from the
`client_id` field of a form-encoded token request.

### Admin routes (beyond the standard contract)

| Route | Does |
| --- | --- |
| `GET /__admin/medplum` | The namespace's base URL, default project and client, and super admin |
| `PUT /__admin/medplum/clients/:id` `{"secret"?, "name"?, "projectId"?, "admin"?}` | Create or replace a client application with a chosen id and secret |
| `POST /__admin/medplum/users` `{"email", "password", "firstName"?, "lastName"?, "profileType"?, "admin"?, "projectId"?}` | Add a user with a password login and a membership |
| `POST /__admin/medplum/token` `{"clientId"?}` | A bearer token for a client (default: the default client) |
| `POST /__admin/medplum/resources[?projectId=]` | Seed a resource, an array, or a Bundle's entries, keeping given ids |
| `GET /__admin/medplum/resources/:type` | Every current resource of a type, across projects |
| `POST /__admin/medplum/logins/revoke` | Revoke every login, so all issued tokens stop working |

The standard contract also serves `POST /__admin/reset`, snapshot and restore, the clock, faults,
`GET /__admin/requests` and metrics.

### Fault presets

`POST /__admin/faults {"preset": "<name>"}`. Add `count` to limit how many requests it hits.

| Preset | Effect |
| --- | --- |
| `rate_limited` | Every FHIR request answers 429 with the server's quota OperationOutcome |
| `token_expired` | FHIR requests answer 401 as if the token expired |
| `server_error` | FHIR requests fail with the server's unhandled-error 500 |
| `token_server_error` | `POST /oauth2/token` fails with a 500 |
| `write_drop` | Creates and batches drop the connection |
| `slow_search` | Searches take 3 s |

### Faithful details worth knowing

- Deleted resources answer 410 Gone, and their history ends with a delete entry.
- An update that changes nothing keeps its version.
- Resources are validated against the FHIR R4 and Medplum StructureDefinitions, with the
  server's messages.
- Transaction bundles are atomic only when the project has the `transaction-bundles` feature, as
  on the server. Without it, entries commit one by one.
- Search follows Postgres semantics. Name and address matching is by token prefix, sorts use C
  collation (missing values last ascending), and dates compare in UTC. Only the sort key orders
  results, so ties and unsorted pages have no guaranteed order on the server; don't rely on it.
- `:missing` on lookup-table parameters (`name`, `family`, `given`, `address`…)
  matches nothing either way, as on the server.
- Super admins get no refresh token from a password login, as on the server.

## Deliberately not modelled

These answer the server's 404 (or are stored but inert):

- terminology operations (`ValueSet/$expand`, `CodeSystem/$lookup`, …)
- bulk `$export`
- bots (`Bot/$execute`)
- subscription delivery (Subscription resources are stored, but nothing is sent)
- email
- self-registration (`/auth/newuser`)
- the super-admin maintenance routes (`/admin/super/*`)

The optional server features (`BlobStorage`, `Redis`, `WebSocket` subscriptions) are not
emulated.

## API

| Export | Description |
| --- | --- |
| `MedplumAPI` | Class. `new MedplumAPI(options?)`; `fetch(request: Request): Promise<Response>` is the Medplum server. |
| `createRuntime` | `(options?: MedplumRuntimeOptions) => MedplumRuntime` — the served mock with the Mockingbird service contract. |
| `MEDPLUM_PRESETS` | The fault presets above, as `Record<string, FaultPreset>`. |
| `MEDPLUM_NAMESPACE` | `"medplum"` — the service name and default namespace. |
| `document` | The vendored OpenAPI contract (`openapi.yaml`). |
| `operationIds` / `supportedOperationIds` | Every operation id in the contract / the ones the mock serves. |
| `DEFINITIONS_VERSION` | The `@medplum/definitions` release the embedded FHIR definitions come from. |
| `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` | `"admin@example.com"` / `"medplum_admin"` — the server's seeded super admin. |
| `SUPER_ADMIN_CLIENT_ID` / `SUPER_ADMIN_CLIENT_SECRET` | The super admin's client application (`client_credentials` as super admin). |
| `DEFAULT_PROJECT_ID` | The ready project's id. |
| `DEFAULT_CLIENT_ID` / `DEFAULT_CLIENT_SECRET` | The ready project's client application. |
| `DEFAULT_BASE_URL` | `"http://localhost:8103/"`, Medplum's default base URL. |
| `createServer` / `serveTarget` / `DEFAULT_PORT` | From `./server` (Node): serve over `node:http`; the CLI's flags; `8103`. |

`MedplumAPI` members:

| Member | Description |
| --- | --- |
| `fetch(request)` | One request to the server. Only the path and query of `request.url` route it. |
| `ready()` | Resolves once the definitions are loaded and the namespace is seeded (`fetch` waits for it). |
| `reset()` | Drop everything and reseed. |
| `describe()` | `{ baseUrl, project, superAdmin }` — the seeded credentials. |
| `putClient({ id, secret?, name?, projectId?, admin? })` | Create or replace a client application. |
| `addUser(fixture, projectId?)` | Add a user with a password login and a membership. |
| `accessToken(clientId?)` | A bearer token for a client (default: the default client). |
| `putResource(resource, projectId?)` | Write a resource as the system, keeping a given id. |
| `resources(type)` | Every current resource of a type, across projects. |
| `systemSearch(query)` | Search as the system (every project), e.g. `"Patient?name=ada"`. |
| `revokeAllLogins()` | Revoke every login; returns how many. |

Options:

```text
type MedplumAPIOptions = {
  baseUrl?: string          // public base URL, trailing slash; default "http://localhost:8103/"
  now?: () => number        // clock for meta.lastUpdated, token lifetimes; default Date.now
  namespace?: string        // storage namespace; default "medplum"
  seed?: number | string    // seeds generated ids and secrets; default the namespace
  sqlite?: SqliteClient     // default @crvouga/mockingbird-service-sqlite
  superAdmin?: { email?, password?, clientId?, clientSecret? }
  project?: false | { id?, name?, clientId?, clientSecret?, clientAdmin?, users?: MedplumUserFixture[] }
  maxSearchOffset?: number  // largest _offset accepted; default unlimited, as on the server
}
type MedplumUserFixture = { email; password; firstName?; lastName?; profileType?: "Practitioner" | "Patient" | "RelatedPerson"; admin? }
type MedplumRuntimeOptions = Omit<MedplumAPIOptions, "now" | "namespace"> & { clock?; adminKey?; onLog?; journalSize? }
```

Ids and secrets are deterministic per namespace and seed, so two mocks given the same requests
return the same ids.

## Development

For contributors to the mockingbird repo only.

```bash
bun run test                          # unit, SDK, auth, runtime, property and recorded-oracle tests
bun run portability                   # bundle for the browser platform and run it in workerd
bun run parity                        # boot a self-hosted Medplum and run every scenario and random walks live
bun run oracle:record                 # refresh test/fixtures/oracle-recording.json from the oracle
MOCKINGBIRD_MEDPLUM_ORACLE=1 bun test medplum.oracle.test.ts   # the live comparison as a test
MOCKINGBIRD_MEDPLUM_ORACLE_URL=http://127.0.0.1:8103/ bun test medplum.oracle.test.ts
```

The oracle (`oracle/`, dev-only) is the real Medplum server built from the pinned tag
(`MOCKINGBIRD_MEDPLUM_VERSION`, default `v5.1.37`) into `~/.cache/mockingbird/medplum-server`
(`MEDPLUM_MOCK_CACHE_DIR`). It runs on embedded Postgres and a `redis-server` on `PATH`. The
first boot clones and builds it, which takes several minutes. After changing a scenario, run
`bun run oracle:record`.

`src/vendor/fhir-router` is `@medplum/fhir-router` 5.1.37 (Apache-2.0), with the changes listed
in its README. `bun run generate` regenerates the operation table and the embedded definitions,
and `generate:check` fails when they are stale.

Part of [mockingbird](https://github.com/crvouga/mockingbird) — agent integration guide: [README](https://github.com/crvouga/mockingbird#readme) · [llms.txt](https://github.com/crvouga/mockingbird/blob/main/llms.txt) · [report an issue or request a feature](https://github.com/crvouga/mockingbird/blob/main/docs/REPORTING_ISSUES.md).
