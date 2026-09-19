# @crvouga/mockingbird-service-junction

Stateful, in-process mock of the [Junction (formerly Vital) API](https://docs.junction.com/) for
test suites: users (`/v2/user`), the lab-testing catalog, lab orders (create, cancel, simulate,
results, requisitions), and at-home phlebotomy / patient-service-center (PSC) scheduling
(availability, booking, reschedule, cancel), plus the `labtest.order.*` and
`labtest.appointment.updated` webhook events. All 39 operations in the vendored OpenAPI subset are
served; behaviour is verified by differential property tests against the Junction sandbox.

Use it when your backend calls Junction via `fetch` or `@tryvital/vital-node` and you want tests to
run offline, deterministically, with no sandbox key.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/junction/SUPPORT.md)
- Drop-in readiness, sealed corpus and sandbox quirks the mock mirrors:
  [docs/drop-in.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/junction/docs/drop-in.md)
- Consumer wiring checklist: [docs/qa-followon.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/junction/docs/qa-followon.md)
- Behaviour notes: [docs/behavior.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/junction/docs/behavior.md)

## Install

```bash
npm install -D @crvouga/mockingbird-service-junction
```

ESM only. Requires Node >= 22 or Bun >= 1.2. No native dependencies: state lives in an in-memory
SQLite engine (pure TypeScript, bundled in). To serve it over HTTP use `Bun.serve` under Bun, or
install `@hono/node-server` under Node.

## Usage

Behaviour the examples rely on (all from the source):

- **Any host works.** Routing uses only the path (`/v2/...`, `/v3/...`).
- **Auth:** every request needs an `x-vital-api-key` header; any value is accepted (sandbox keys
  look like `sk_us_*` / `sk_eu_*`). Without it the response is `401 {"detail":"Missing x-vital-api-key"}`.
  State is not partitioned by key: all requests share one team (`team_id`
  `11111111-1111-4111-8111-111111111111`).
- Bodies are JSON with the API's snake_case field names.
- A default synthetic catalog is installed at construction (lab tests with methods
  `walk_in_test`, `testkit` and `at_home_phlebotomy`); `installCorpus` replaces it with a recording.

### In-process (inject `fetch`)

```ts
import { JunctionAPI } from "@crvouga/mockingbird-service-junction"

const junction = new JunctionAPI({ now: () => Date.UTC(2030, 0, 1) })
const headers = { "x-vital-api-key": "sk_us_mockingbird", "content-type": "application/json" }

const call = async (method: string, path: string, body?: unknown) => {
  const response = await junction.fetch(
    new Request(`https://api.sandbox.tryvital.io${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

const user = await call("POST", "/v2/user", { client_user_id: "app-user-1" })
const userId = String(user.json.user_id)

const catalog = await call("GET", "/v3/lab_test")
const labTests = catalog.json.data as { id: string; method: string }[]
const testkit = labTests.find((test) => test.method === "testkit")
if (testkit === undefined) throw new Error("default catalog has a testkit test")

const order = await call("POST", "/v3/order", {
  user_id: userId,
  patient_details: {
    first_name: "Ada",
    last_name: "Lovelace",
    dob: "1990-01-01",
    gender: "female",
    phone_number: "+14155551234",
    email: "ada@example.com",
  },
  patient_address: {
    first_line: "1 N Central Ave",
    city: "Phoenix",
    state: "AZ",
    zip: "85004",
    country: "US",
  },
  order_set: { lab_test_ids: [testkit.id] },
})
console.log(order.status, (order.json.order as { id: string }).id) // 200 "<uuid>"

// Every event the mock published, oldest first:
console.log(junction.webhookEvents().map((event) => event.event_type)) // ["labtest.order.created"]
```

`now` (milliseconds) drives `created_on`/`updated_at` fields, webhook timestamps, and when delayed
simulations (`POST /v3/order/{id}/test?final_status=completed&delay=<seconds>`) become due; the
delayed transition is applied on the next `GET /v3/order/{id}` whose `now` is past the due time.

### Over HTTP

```ts
import { JunctionAPI } from "@crvouga/mockingbird-service-junction"

const junction = new JunctionAPI()
const server = Bun.serve({
  port: 0, // ephemeral
  hostname: "127.0.0.1",
  fetch: (request) => junction.fetch(request),
})
const baseUrl = `http://127.0.0.1:${server.port}`

const response = await fetch(`${baseUrl}/v2/user`, {
  headers: { "x-vital-api-key": "sk_us_mockingbird" },
})
console.log(response.status) // 200

server.stop()
```

On Node use any Fetch-style server, e.g. `@hono/node-server` (`npm install -D @hono/node-server`),
whose callback receives the bound port:

```js
import { serve } from "@hono/node-server"
const server = serve(
  { fetch: (request) => junction.fetch(request), port: 0, hostname: "127.0.0.1" },
  (info) => console.log(`http://127.0.0.1:${info.port}`),
)
// ... later: server.close()
```

### Pointing `@tryvital/vital-node` at it

The official SDK takes the base URL as `environment` (this is how the package's SDK drop-in test
constructs it):

```js
import { VitalClient } from "@tryvital/vital-node"

const client = new VitalClient({ apiKey: "sk_us_mockingbird", environment: baseUrl })
const user = await client.user.create({ clientUserId: "app-user-1" })
```

If your app guards Junction hosts with an allowlist, allow `127.0.0.1` / `localhost` for tests
while keeping the production and sandbox guards intact.

### Webhooks

`onWebhook` is called synchronously with every event the mock records
(`labtest.order.created`, `labtest.order.updated`, `labtest.appointment.updated`). Delivery and
signing are up to you. Junction delivers through Svix; the contributor server script signs with
`svix-id`, `svix-timestamp` and `svix-signature: v1,<base64 HMAC-SHA256 of "<timestamp>.<body>">`,
keyed by the base64-decoded secret after stripping a `whsec_` prefix:

```ts
import { createHmac, randomUUID } from "node:crypto"
import { JunctionAPI } from "@crvouga/mockingbird-service-junction"

const WEBHOOK_URL = "http://127.0.0.1:3100/webhooks/junction"
const WEBHOOK_SECRET = "whsec_bW9ja2luZ2JpcmQtdGVzdC1zZWNyZXQ="

const junction = new JunctionAPI({
  onWebhook: (event) => {
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const body = JSON.stringify(event)
    const key = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ""), "base64")
    const signature = createHmac("sha256", key).update(`${timestamp}.${body}`).digest("base64")
    void fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": randomUUID(),
        "svix-timestamp": timestamp,
        "svix-signature": `v1,${signature}`,
      },
      body,
    }).catch(() => undefined)
  },
})
console.log(junction.webhookEvents().length) // 0
```

`webhookDeliveryAttempts()` returns the retry schedule Junction would follow for each event
(8 attempts: immediately, then 5s, 5m, 30m, 2h, 5h, 10h, 10h, with jitter controlled by the
`webhook` option). It is a record only; nothing is re-sent.

### Resetting between tests

`reset()` clears users, orders, appointments and webhook events, then re-installs the default
catalog, or the corpus passed to `installCorpus` if there was one:

```ts
import { beforeEach, expect, test } from "bun:test"
import { JunctionAPI } from "@crvouga/mockingbird-service-junction"

const junction = new JunctionAPI()
beforeEach(() => junction.reset())

test("starts with no users", async () => {
  const response = await junction.fetch(
    new Request("https://api.sandbox.tryvital.io/v2/user", {
      headers: { "x-vital-api-key": "sk_us_mockingbird" },
    }),
  )
  expect(await response.json()).toMatchObject({ users: [], total: 0 })
})
```

### Sealed corpus (optional, higher fidelity)

Provider-owned inventory (area serviceability, PSC site lists, the team's lab catalog, labs, lab
accounts) cannot be synthesized faithfully. A sealed corpus is an exact sandbox recording of those
parameter-stable GETs; installing it makes the mock answer them byte-for-byte. The recording in the
repo (`corpus/sandbox-sealed.json`) is not shipped in the npm package; copy it or record your own
(see Development).

```ts
import { readFileSync } from "node:fs"
import { JunctionAPI, parseSealedCorpus } from "@crvouga/mockingbird-service-junction"

const junction = new JunctionAPI()
const recording: unknown = JSON.parse(readFileSync("test/junction-sandbox-sealed.json", "utf8"))
junction.installCorpus(parseSealedCorpus(recording)) // re-applied on every reset()
```

Availability is never recorded (its slot dates and single-use `booking_key`s cannot be replayed);
it always comes from the deterministic generator.

## API

| Export | Description |
| --- | --- |
| `JunctionAPI` | Class. `new JunctionAPI(options?)`; implements the Fetch contract `fetch(request: Request): Promise<Response>`. |
| `JUNCTION_NAMESPACE` | `"junction"` — SQLite namespace holding the mock's state when sharing a `sqlite` client. |
| `document` | The vendored Junction OpenAPI document (Mockingbird subset) that drives routing. |
| `operationIds` | Every `operationId` in `document`. |
| `supportedOperationIds` | The `operationId`s the mock implements (all of them). |
| `parseSealedCorpus` | `(value: unknown) => SealedCorpus`; throws on a non-object or unsupported `version`. |
| `SEALED_CORPUS_VERSION` | Current sealed-corpus format version (`1`). |
| `observationCacheKey` | `(url, method = "GET", body?) => string` — the `"<METHOD> <path>?<sorted query> <json>"` key used by the observation cache and corpus. |
| `prefetchCoverageObservations` | Parity helper: records coverage-ZIP area/PSC/availability reads from the real sandbox into an observation cache before `seedFrom`. |
| `reshapeCoverageGeoCommand` | Parity-walk hook that pins geo/availability parameters onto the coverage corpus. |
| `COVERAGE_ZIPS` | ZIP codes the coverage corpus seals for area/PSC reads. |
| `PSC_AVAILABILITY_ZIPS` | ZIPs that also get PSC availability observations. |
| `PHLEBOTOMY_AVAILABILITY_ZIPS` | ZIPs served for phlebotomy availability (`["85004"]`). |
| `PSC_LAB_IDS` | Lab ids used for PSC reads (`[4, 6, 13, 25]`). |
| `AVAILABILITY_ADDRESS` | Stable Phoenix, AZ address used in availability requests so cache keys match. |
| `AVAILABILITY_START_DATE` | Far-future availability `start_date` (`"2099-06-15"`). |

`JunctionAPI` members:

| Member | Description |
| --- | --- |
| `fetch(request)` | Handle one Junction REST request. |
| `reset()` | `Promise<void>` — clear state; re-install the default catalog or the installed corpus. |
| `installCorpus(corpus)` | Install a `SealedCorpus` (observation cache, catalog, labs, lab accounts). |
| `seedFrom(source, observations?)` | `Promise<SeedReport>` — copy users, orders, appointments, catalog and labs from a real Junction environment. |
| `ensureLabTests(source, ids)` / `ensureOrders(source, ids)` | `Promise<number>` — fetch specific lab tests / orders from `source` if missing. |
| `markUserDeleted(userId)` | Mark a user as deleted (subsequent reads behave like a deleted user). |
| `webhookEvents()` | `JunctionWebhookEvent[]`, oldest first. |
| `webhookDeliveryAttempts()` | Recorded retry schedule per event. |
| `app` / `sqlite` | The underlying Hono app and `SqliteClient`. |

Options and types:

```text
type JunctionAPIOptions = {
  sqlite?: SqliteClient          // share one client across services; default: fresh in-memory DB
  now?: () => number             // clock in ms; default Date.now
  onWebhook?: WebhookPublisher   // called with every recorded event
  webhook?: JunctionWebhookOptions
}
type JunctionWebhookOptions = { seed?: number; jitterRatio?: number /* 0..1, default 0.1 */; timeoutMs?: number /* default 15000 */ }
type JunctionWebhookEvent = {
  event_type: "labtest.order.created" | "labtest.order.updated" | "labtest.appointment.updated"
  data: Record<string, unknown>; team_id: string; user_id: string; client_user_id: string
}
type WebhookPublisher = (event: JunctionWebhookEvent) => void
type SeedSource = { fetch: (request: Request) => Promise<Response>; baseUrl: string; headers: Record<string, string> }
type SeedObservations = { getCache?: ReadonlyMap<string, GetCacheEntry> }
type SeedReport = { users; orders; appointments; catalogTests; labs; cacheEntries: number }
type GetCacheEntry = { status: number; headers: Record<string, string>; body: unknown }
type SealedCorpus = { version: 1; recordedAt; source; observations; catalog: { labTests; labs; expectedResults }; labAccounts }
type OperationId / SupportedOperationId  // string unions of operationIds / supportedOperationIds
```

Seeding from the real sandbox (needs network and a real key):

```ts
import { JunctionAPI } from "@crvouga/mockingbird-service-junction"

const junction = new JunctionAPI()
const report = await junction.seedFrom({
  fetch: (request) => globalThis.fetch(request),
  baseUrl: "https://api.sandbox.tryvital.io",
  headers: { "x-vital-api-key": process.env.JUNCTION_API_KEY ?? "" },
})
console.log(report.users, report.orders)
```

## Development

For contributors to the mockingbird repo only; these scripts and the corpus are not shipped in the
npm package.

```bash
bun test                                   # offline suites, incl. scheduling state space
bun test junction.seed.property.test.ts    # offline monkey (no network)
bun test junction.sdk.property.test.ts     # drives the served mock through @tryvital/vital-node

bun run mock:serve                         # HOST=127.0.0.1 PORT=8787; GET /health, POST /__admin/reset
MOCKINGBIRD_JUNCTION_CORPUS=corpus/sandbox-sealed.json bun run mock:serve
bun run corpus:record                      # record corpus/sandbox-sealed.json (needs a sandbox key)
```

`mock:serve` installs `corpus/sandbox-sealed.json` when present, and signs webhooks to
`MOCKINGBIRD_JUNCTION_WEBHOOK_URL` with `MOCKINGBIRD_JUNCTION_WEBHOOK_SECRET` (delivery is disabled
without a secret). `/health` and `/__admin/reset` bypass the `x-vital-api-key` gate.

Live parity (primary proof is seedParity: warmup N on the sandbox, `seedFrom`, then lockstep M):

```bash
bun run parity                                   # default mode=seed against api.sandbox.tryvital.io
bun run parity -- --warmup 15 --compare 30 --runs 25
bun run parity -- --mode=empty                   # legacy empty-start differential
```

Webhook parity needs a public receiver; see
[docs/webhook-parity.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/junction/docs/webhook-parity.md).
The `client-parity*.ts` SDK scenarios are deprecated as proof and kept only as manual probes.

Part of [mockingbird](https://github.com/crvouga/mockingbird) — agent integration guide: [README](https://github.com/crvouga/mockingbird#readme) · [llms.txt](https://github.com/crvouga/mockingbird/blob/main/llms.txt).
