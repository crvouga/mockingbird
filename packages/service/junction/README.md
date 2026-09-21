# @crvouga/mockingbird-service-junction

Stateful mock of the [Junction (formerly Vital) API](https://docs.junction.com/): users
(`/v2/user`), the lab-testing catalog, lab orders (create, cancel, simulate, results,
requisitions), at-home phlebotomy and patient-service-center (PSC) scheduling, and the
`labtest.order.*` / `labtest.appointment.updated` webhooks. All 39 operations in the vendored
OpenAPI subset are served, and behaviour is checked by differential property tests against the
Junction sandbox.

Use it to take Junction off your suite's critical path: no sandbox key, no shared 50-user sandbox
cap, no cross-suite interference. Serve it as a local origin with one command, or run it in-process.

```bash
npx mockingbird-junction serve   # http://127.0.0.1:8787, recorded sandbox corpus loaded
```

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/junction/SUPPORT.md)
- Drop-in readiness and the sandbox quirks the mock mirrors:
  [docs/drop-in.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/junction/docs/drop-in.md)
- Behaviour notes: [docs/behavior.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/junction/docs/behavior.md)
- **What the mock does not model:** [below](#what-is-and-is-not-modelled). Read it before trusting a
  green suite.

## Install

```bash
npm install -D @crvouga/mockingbird-service-junction
```

ESM only; Node >= 22 or Bun >= 1.2 (CommonJS callers on Node >= 22.12 can `require()` it). No
native dependencies: state lives in an in-memory SQLite engine written in TypeScript, bundled in.

| Entry point | Runtime | What it is |
| --- | --- | --- |
| `@crvouga/mockingbird-service-junction` | any (Node, Bun, Workers, browsers) | `JunctionAPI`, `createRuntime`, corpus and verify tools |
| `@crvouga/mockingbird-service-junction/server` | Node | `createServer()` — a listening HTTP server |
| `@crvouga/mockingbird-service-junction/corpus` | any | `defaultCorpus` — the recording shipped in the package (a separate entry, so importing the mock never parses it) |
| `mockingbird-junction` (bin) | Node | `serve`, `corpus pull`, `corpus diff`, `verify` |

## Usage

### `mockingbird-junction serve`

```bash
npx mockingbird-junction serve --port 8787
npx mockingbird-junction serve --corpus ./test/junction-corpus.json --lab-accounts ./test/lab-accounts.json
npx mockingbird-junction serve --webhook-url http://127.0.0.1:3100/webhooks/junction --webhook-secret whsec_...
npx mockingbird-junction serve --help
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--port <n>` | `8787` | Port to listen on (`0` for any free port; the bound URL is printed) |
| `--host <host>` | `127.0.0.1` | Interface to bind |
| `--corpus <default\|none\|file>` | `default` | The shipped corpus, no corpus (synthetic data), or a file from `corpus pull` |
| `--geo <corpus\|synthetic>` | `corpus` with a corpus | How unknown ZIPs are answered; see [Geo](#geo-corpus-or-synthetic) |
| `--lab-accounts <file>` | built-in fixtures | JSON array of [lab accounts](#lab-accounts) |
| `--webhook-url <url>` / `--webhook-secret <whsec_…>` | off | Deliver [signed webhooks](#webhooks) (secret also from `MOCKINGBIRD_JUNCTION_WEBHOOK_SECRET`) |
| `--webhook-retry-delays <ms,…>` | Svix's schedule | Delay before each delivery attempt, e.g. `0,1000,5000` in tests |
| `--webhook-scope <scope>` | — | Sent as `x-mockingbird-scope` on every delivery |
| `--admin-key <key>` | open | Require `x-mockingbird-admin-key` on `/__admin/*` (also `MOCKINGBIRD_ADMIN_KEY`) |
| `--seed <seed>` | `0` | Seeds fault rates and retry jitter |
| `--log <pretty\|json\|off>` | `pretty` | One line per request: operation id, status, duration, namespace, fault |
| `--seed-url <url>` / `--seed-key <key>` | — | Pull a corpus from a live team at boot. Slow and a live dependency; prefer a committed `corpus pull` file |
| `--config <file>` | — | Serve every service in a `mockingbird.json` instead ([below](#many-services-from-one-config)) |

At startup it prints the listen address, the loaded corpus (its version label, observation, ZIP,
lab-test and lab-account counts, recording date and source), the geo mode, and whether webhook
delivery is on.

### Many services from one config

Any Mockingbird service's CLI can boot every service in a config file, so a stack adds a config
entry per vendor instead of a wrapper process per vendor. Each service named must be installed
(`junction` loads `@crvouga/mockingbird-service-junction`).

```json
{
  "log": "json",
  "services": {
    "junction": {
      "port": 8787,
      "adminKey": "local-admin",
      "options": { "corpus": "./test/junction-corpus.json", "webhook-url": "http://127.0.0.1:3100/webhooks/junction" }
    },
    "stripe": { "port": 12111 }
  }
}
```

```bash
npx mockingbird-junction serve --config mockingbird.json
```

`options` takes the service's own `serve` flags by long name.

### `createServer` (Node)

```ts
import { createServer } from "@crvouga/mockingbird-service-junction/server"

const server = await createServer() // shipped corpus, any free port
const health = await fetch(`${server.url}/health`)
console.log(health.status) // 200

// Point the Vital SDK (or your backend's Junction base URL) at server.url, then:
await server.close()
```

`createServer(options)` takes every [`createRuntime`](#createruntime-any-fetch-server) option plus
`port` (default `0`), `host` (default `127.0.0.1`) and `corpus` (`"default"`, `"none"`, a file path
or a loaded corpus). The result has `url`, `port`, `runtime` and `close()`.

### `createRuntime` (any Fetch server)

`createRuntime` is the whole served mock — health, admin, namespaces, clock, faults, metrics — as a
single runtime-neutral `fetch(request)`. Hand it to `Bun.serve`, a Worker, or call it directly:

```ts
import { createRuntime } from "@crvouga/mockingbird-service-junction"
import { defaultCorpus } from "@crvouga/mockingbird-service-junction/corpus"

const junction = createRuntime({ corpus: defaultCorpus })
const as = (worker: string) => ({
  "x-vital-api-key": "sk_us_mockingbird",
  "x-mockingbird-namespace": worker, // isolates this worker's data
  "content-type": "application/json",
})

await junction.fetch(
  new Request("http://junction.local/v2/user", {
    method: "POST",
    headers: as("worker-1"),
    body: JSON.stringify({ client_user_id: "patient-1" }),
  }),
)
const other = await junction.fetch(new Request("http://junction.local/v2/user", { headers: as("worker-2") }))
console.log(await other.json()) // worker-2 sees none of worker-1's users

await junction.reset("worker-1") // or junction.reset("*") for every namespace
```

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

## The service contract

Every Mockingbird service answers the same control surface, outside the vendor's auth gate:

- `GET /health` — unauthenticated readiness probe:
  `{ "status": "ok", "service": "junction", "corpus": "<label>", "geo": "corpus", … }`.
- `/__admin/*` — the control plane. Open by default; with `--admin-key` / `adminKey` it requires
  `x-mockingbird-admin-key`, which is separate from any vendor key. Admin errors have one shape,
  `{ "error": { "type": "mockingbird_admin", "message": "…" } }`, so they can never be confused
  with a Junction error. `GET /__admin` lists every route.
- `x-mockingbird-namespace: <name>` — isolates a request's data (`[A-Za-z0-9_.-]{1,64}`). Each
  namespace is a separate team over one shared database, so parallel workers share one process
  without seeing each other. The corpus is shared read-only; creating a namespace is cheap. Admin
  routes take the namespace from `?namespace=`, then the header, then `default`.

| Route | Does |
| --- | --- |
| `POST /__admin/reset` | Reset the request's namespace; `?all=1` resets every namespace |
| `GET /__admin/namespaces` | Namespaces created so far |
| `POST /__admin/snapshots` | Snapshot the namespace; returns `{ id }` |
| `POST /__admin/snapshots/{id}/restore` | Restore it (an assignment: later writes are discarded) |
| `DELETE /__admin/snapshots/{id}` | Forget a snapshot |
| `GET` / `POST /__admin/clock` | Read or move the clock: `{ "set": "2030-01-01T00:00:00Z" }`, `{ "advance": "2h" }`, `{ "freeze": true }`, `{ "reset": true }` |
| `GET` / `POST` / `DELETE /__admin/faults` | List, add or clear [fault rules](#faults-and-error-shapes) (`DELETE ?id=` removes one) |
| `POST /__admin/faults/presets/{name}` | Add a named Junction fault; body may override `count`, `rate`, `operationId`… |
| `GET /__admin/metrics` | Requests by operation and status, fault count, and **unmatched routes** |
| `GET /__admin/orders` | Orders in the namespace with their current status |
| `POST /__admin/orders/{id}/transition` | Move an order: `{ "to": "completed", "result": "abnormal" }` ([order control](#order-control)) |
| `GET` / `PUT /__admin/results/{id}` | Read or install an exact result payload / PDF for an order |
| `GET /__admin/result-fixtures` | The named results |
| `GET` / `PUT /__admin/lab-accounts` | Read or replace the namespace's [lab accounts](#lab-accounts) (`{ "accounts": null }` restores the default) |
| `GET /__admin/corpus`, `PUT /__admin/geo` | The loaded corpus; switch [geo mode](#geo-corpus-or-synthetic) |
| `GET /__admin/webhooks` | [Deliveries](#webhooks) with every attempt |
| `POST /__admin/webhooks/{id}/replay`, `POST /__admin/webhooks/flush` | Redeliver one message; run pending retries now |
| `GET /__admin/webhooks/events` | Every event recorded, delivered or not |

`GET /__admin/metrics` → `unmatched` counts requests to paths the contract does not have. It is how
a new SDK call shows up — as a count — before it fails a suite as a 404.

## Corpus

Provider-owned inventory — area serviceability, PSC site lists, the lab catalog, labs, lab
accounts — cannot be synthesized faithfully. A corpus is an exact recording of those
parameter-stable reads, and the mock answers them byte for byte.

**The shipped corpus** (`defaultCorpus`, and what `serve` loads unless told otherwise) was recorded
from the Junction sandbox. It covers area and PSC serviceability for 57 ZIPs across the US, the PSC
labs those ZIPs reach, and the recording team's catalog. The catalog and lab accounts belong to the
**recording team**: lab-test ids are per team, so your product's ids will not be in it. For your
catalog and your lab accounts, record your own team and commit the file:

```bash
npx mockingbird-junction corpus pull --real-key "$JUNCTION_SANDBOX_KEY" --out test/junction-corpus.json
npx mockingbird-junction corpus pull --real-key "$JUNCTION_SANDBOX_KEY" --base test/junction-corpus.json \
  --zip 10001,94105 --coverage-only --out test/junction-corpus.json   # add ZIPs to it
npx mockingbird-junction corpus diff test/junction-corpus.json /tmp/fresh.json   # exit 1 when they differ
```

`corpus pull` only issues GETs, refuses non-sandbox keys (`sk_us_…` / `sk_eu_…`) unless given
`--allow-any-key`, and stamps the file with a SHA-256 `fingerprint` of its content (not its
recording time), so re-pulling unchanged data yields the same fingerprint. Availability is never
recorded: its slot dates and single-use `booking_key`s cannot be replayed, so it always comes from
the deterministic generator.

### Geo: corpus or synthetic

With a corpus loaded, serviceability reads (`area/info`, `psc/info`, phlebotomy and PSC
availability) answer **only** for ZIPs the corpus covers. Any other well-formed ZIP gets:

```json
{
  "detail": {
    "error_type": "MOCKINGBIRD_UNKNOWN_ZIP",
    "error_message": "ZIP 00501 is not in the loaded Junction corpus (57 ZIPs covered). Record it with `mockingbird-junction corpus pull --zip 00501`, or serve with --geo synthetic to invent coverage.",
    "zip_code": "00501",
    "corpus": "v1-2026-09-18-HqFDuEAuhkwD"
  }
}
```

with status **424**, which Junction never sends and HTTP clients do not retry: a fixture gap fails
loudly instead of silently disagreeing with production. A malformed ZIP still gets Junction's own
422. `--geo synthetic` (the default without a corpus) invents plausible, deterministic coverage
instead — right for property tests that walk random ZIPs, wrong for a suite standing in for
production.

## Lab accounts

`create_order` routes, accepts and rejects `lab_account_id` against the team's lab accounts,
following Junction's documented rules: an explicit id must exist, be linked to the team, belong to
the ordered lab and be active; with no id, one active account for the lab is selected, several are
an error, and a lab with none falls back to Junction's platform account. The billing type must be
allowed in the patient's state by the account's `allowed_billing`.

The accounts come from, in order: `labAccounts` / `--lab-accounts`, else the corpus (a pulled
corpus carries your team's real accounts), else built-in fixtures. Configure them as
`ClientFacingLabAccount`s, with `states` as shorthand for client-bill states:

```ts
import { createRuntime, US_STATES } from "@crvouga/mockingbird-service-junction"

const junction = createRuntime({
  labAccounts: [
    { id: "acct-bioref-nynj", lab: "bioreference", states: ["NY", "NJ"] },
    {
      id: "acct-labcorp-47",
      lab: "labcorp",
      states: US_STATES.filter((state) => !["NY", "NJ", "RI"].includes(state)),
    },
    { id: "acct-quest", lab: "quest", delegated_flow: "order_delegated" },
  ],
})
console.log(junction.instance().labAccounts().length) // 3
```

Rejections keep Junction's body shape, `400 {"detail": "Lab account is not associated with lab labcorp"}`.
`PUT /__admin/lab-accounts` swaps them per namespace at runtime. `delegated_flow` is stored and
listed, but see [not modelled](#what-is-and-is-not-modelled).

## Order control

`simulate_order` (`POST /v3/order/{id}/test`) behaves like the sandbox's, including its stepwise
rules. For direct control, the admin API moves an order straight to a status, recording the same
event, dates and appointment cascade, and publishing the same webhook, a real transition does:

```bash
curl -X POST localhost:8787/__admin/orders/$ORDER/transition -d '{"to": "collected"}'
curl -X POST localhost:8787/__admin/orders/$ORDER/transition -d '{"to": "completed", "result": "critical"}'
curl -X POST localhost:8787/__admin/orders/$ORDER/transition -d '{"to": "cancelled.testkit.do_not_process"}'
```

`to` is a full status (`completed.testkit.completed`), a `<phase>.<event>` pair, or a name that maps
onto the contract's own status for the order's collection method:

| Name | `at_home_phlebotomy` | `on_site_collection` | `testkit` | `walk_in_test` |
| --- | --- | --- | --- | --- |
| `requisition_created` | `received.…requisition_created` | same | same | same |
| `scheduled` | `collecting_sample.…appointment_scheduled` | — | — | `collecting_sample.…appointment_scheduled` |
| `shipped` / `delivered` | — | — | `collecting_sample.…transit_customer` / `…with_customer` | — |
| `collected` | `collecting_sample.…draw_completed` | `sample_with_lab.…draw_completed` | `collecting_sample.…transit_lab` | — |
| `at_lab` | — | `sample_with_lab.…draw_completed` | `sample_with_lab.…delivered_to_lab` | — |
| `partial_results` | `sample_with_lab.…partial_results` | same | — | same |
| `completed` / `corrected` / `cancelled` / `failed` | `completed.…completed` / `completed.…corrected` / `cancelled.…cancelled` / `failed.…sample_error` | same | same | same |

A name with no real status for the method (`collected` for a walk-in test) is refused with the
valid choices, never approximated. `result` picks a named result — `normal`, `abnormal`,
`critical`, `missing_results` — which steers the generator so the payload keeps Junction's exact
shape. For an exact payload, `PUT /__admin/results/{id}` with `{ "results": [...],
"missing_results": null, "interpretation": "critical", "pdf_base64": "…" }`.

There is no `isTestCancelled` in Junction's contract; cancelling produces the vendor's
`cancelled.<method>.cancelled` event and webhook, which is what a consumer derives that flag from.

**Time.** Every timestamp reads the runtime clock. `POST /__admin/clock {"advance": "2h"}` makes
delayed simulations (`?delay=<seconds>`) due and moves appointment windows, with no sleeping.

## Faults and error shapes

Error bodies the mock reproduces byte for byte, checked against the sandbox by `verify` and the
parity suite:

| Case | Status | Body |
| --- | --- | --- |
| `GET /v2/user/{unknown id}` | 404 | `{"detail":"Not found"}` |
| `GET /v2/user/resolve/{unknown client_user_id}` | 404 | `{"detail":"User not found"}` |
| Missing `x-vital-api-key` | 401 | `{"detail":"Missing x-vital-api-key"}` |
| Request validation | 422 | `{"detail":[{"type":…,"loc":[…],"msg":…,"input":…}]}` (Pydantic shape) |
| Business rule | 400 | `{"detail":"<message>"}` or `{"detail":{"error_type":"INVALID_REQUEST","error_message":"…"}}` |

Faults reproduce the sandbox's failure modes on demand, for retry paths and error handling:

| Preset | Fault | Fidelity |
| --- | --- | --- |
| `sandbox_user_quota` | `create_user` → 400 `{"detail":{"error_type":"INVALID_REQUEST","error_message":"You have reached the maximum of 50 Sandbox users"}}` | byte-exact, as observed from a sandbox team |
| `rate_limited` | 429 `{"detail":"Too Many Requests"}`, `retry-after: 1` | shape-plausible, not verified |
| `server_error` / `bad_gateway` / `unavailable` | 500 / 502 / 503 | shape-plausible, not verified |

```ts
import { createRuntime, FAULT_PRESETS } from "@crvouga/mockingbird-service-junction"

const junction = createRuntime()
junction.faults.add({ ...FAULT_PRESETS.sandbox_user_quota, id: "quota", count: 1 }) // next create_user only
junction.faults.add({ id: "flaky-orders", operationId: "create_order_v3_order_post", status: 503, rate: 0.25 })
```

A rule matches on `operationId`, `method`, `pathPrefix` and `namespace` (all optional), fires
`count` times or forever, for a `rate` of matching requests (seeded, so a run replays identically),
after an optional `delayMs`. A rule added through the admin API defaults to the calling namespace,
so one worker's injected failure never lands on another's request; one added in-process, as above,
applies to every namespace unless given a `namespace`. Over HTTP: `POST /__admin/faults` with the same fields, or
`POST /__admin/faults/presets/sandbox_user_quota`.

## Webhooks

With `webhooks` / `--webhook-url`, every event is delivered signed, with retries:

- **Standard Svix signatures**: `svix-id`, `svix-timestamp`, and `svix-signature: v1,<base64
  HMAC-SHA256 of "<svix-id>.<svix-timestamp>.<body>">`, keyed by the base64 part of `whsec_…`. The
  official `svix` verifier, and a receiver written for real Junction, accept it unchanged. (Signing
  `"<timestamp>.<body>"` without the message id, as this package's own server script did before,
  is not Svix-compatible.)
- Timestamps are wall-clock even when the mock clock is moved, because receivers reject timestamps
  outside a few minutes of their own clock.
- Any 2xx is delivered; anything else is retried on Svix's schedule (immediately, 5 s, 5 min,
  30 min, 2 h, 5 h, 10 h, 10 h) or `retryDelaysMs`. `POST /__admin/webhooks/flush` runs pending
  retries now; `POST /__admin/webhooks/{id}/replay` redelivers one message.

```ts
import { createRuntime, verifySvix } from "@crvouga/mockingbird-service-junction"

const secret = "whsec_bW9ja2luZ2JpcmQtdGVzdC1zZWNyZXQ="
const junction = createRuntime({
  webhooks: { url: "http://127.0.0.1:3100/webhooks/junction", secret, retryDelaysMs: [0, 500, 2000] },
})

// In a test receiver:
const accept = async (request: Request) =>
  verifySvix(
    secret,
    {
      "svix-id": request.headers.get("svix-id") ?? "",
      "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
      "svix-signature": request.headers.get("svix-signature") ?? "",
    },
    await request.text(),
  )
console.log(typeof accept, junction.webhooks?.deliveries().length) // "function" 0
```

## Verify

`verify` is the fidelity guarantee: it runs the same requests against real Junction and the mock
and reports every divergence.

```bash
npx mockingbird-junction verify --real-key "$JUNCTION_SANDBOX_KEY" --corpus test/junction-corpus.json
npx mockingbird-junction verify --real-key "$JUNCTION_SANDBOX_KEY" --orders --sample 50 --json
```

- **Drift**: re-fetches each recorded observation (or `--sample n` of them) and reports any that no
  longer match production — the signal to re-pull.
- **Scenario**: creates a user, reads it back, provokes the documented 404s, reads the catalog and a
  covered ZIP's serviceability, and deletes the user; with `--orders`, also places, reads and
  cancels an order for the corpus's first lab test. Status codes must match; bodies must match in
  shape, and byte for byte for the documented error bodies.

It exits 1 on any divergence. The scenario always deletes its user (and cancels its order), because
it runs against the same capped sandbox the mock exists to relieve. `verifyAgainstReal` is the same
check as a function. This repo runs it in CI against the Junction sandbox.

## Determinism

With a fixed clock (`clock` / `POST /__admin/clock {"set": …, "freeze": true}`) and `seed`, a run
replays exactly. Stable across runs: user ids, order ids, event ids, sample ids, booking keys and
webhook message ids (derived from sequence numbers), timestamps (from the clock), generated
availability, and which requests a partial-`rate` fault hits. Wall-clock by design: webhook
`svix-timestamp`, `/health` uptime, and request log durations.

## What is and is not modelled

A mock that is silent about its gaps is how a green suite starts lying. Specifically:

- **Corpus-backed** (byte-exact): area and PSC serviceability for covered ZIPs; the catalog, labs,
  expected results and lab accounts of the team the corpus was recorded from.
- **Synthetic** (deterministic, shape-faithful, values invented): availability slots and booking
  keys; results (biomarker lines and PDFs) unless a fixture is installed; requisition PDFs;
  coverage for any ZIP in `--geo synthetic` mode.
- **Not modelled**:
  - `delegated_flow`-specific ordering. Accounts carry the field and orders follow the documented
    selection and billing rules above, but any additional behaviour Junction applies to delegated
    accounts is not reproduced. Run `verify --orders` with your team's corpus to check what you rely on.
  - Rate limits and outages, except when injected as faults.
  - Real 429 / 5xx bodies: the presets are plausible, not recorded.
  - Phlebotomy availability breadth: the sandbox serves it only for `85004`; the mock generates slots
    for any covered ZIP.
  - Webhook retry jitter across a snapshot restore (the jitter stream is not part of a snapshot).
  - Operations outside the vendored OpenAPI subset: they return 404 and are counted as
    `unmatched` in `/__admin/metrics`.

## API

Main entry (`@crvouga/mockingbird-service-junction`, runtime-neutral):

| Export | Description |
| --- | --- |
| `createRuntime` | `(options?: JunctionRuntimeOptions) => JunctionRuntime` — the served mock (health, admin, namespaces, clock, faults, metrics, webhooks) as one `fetch`. Options: `corpus`, `geo`, `labAccounts`, `webhooks`, `onWebhook`, `sqlite`, `clock`, `seed`, `adminKey`, `onLog`. |
| `JunctionAPI` | Class. `new JunctionAPI(options?)`: one namespace's mock, implementing `fetch(request: Request): Promise<Response>`. |
| `JUNCTION_NAMESPACE` | `"junction"` — the default namespace's storage key when sharing a `sqlite` client. |
| `document` | The vendored Junction OpenAPI document (Mockingbird subset) that drives routing. |
| `operationIds` | Every `operationId` in `document`. |
| `supportedOperationIds` | The `operationId`s the mock implements (all of them). |
| `pullCorpus` | `(options: PullCorpusOptions) => Promise<SealedCorpus>` — record a corpus from a real team (GETs only). |
| `diffCorpus` | `(before, after) => CorpusDiff` — ZIPs, lab tests, lab accounts and observations added / removed / changed. |
| `fingerprintCorpus` | `(corpus) => Promise<string>` — SHA-256 of a corpus's content. |
| `corpusLabel` | `(corpus) => string` — the short label `/health` and logs show, e.g. `v1-2026-09-18-HqFDuEAuhkwD`. |
| `parseSealedCorpus` | `(value: unknown) => SealedCorpus`; throws on a non-object or unsupported `version`. |
| `SEALED_CORPUS_VERSION` | Current corpus format version (`1`). |
| `verifyAgainstReal` | `(options: VerifyOptions) => Promise<VerifyReport>` — the `verify` command as a function. |
| `DEFAULT_JUNCTION_BASE_URL` | `"https://api.sandbox.tryvital.io"`. |
| `isSandboxKey` / `SANDBOX_KEY_PREFIXES` | Whether a key is a sandbox team key (`sk_us_` / `sk_eu_`). |
| `UNKNOWN_ZIP_STATUS` / `UNKNOWN_ZIP_ERROR_TYPE` | `424` / `"MOCKINGBIRD_UNKNOWN_ZIP"` — the corpus-mode unknown-ZIP error. |
| `labAccountFromInput` | `(input: LabAccountInput) => LabAccountRecord` — normalize (and validate) a configured account. |
| `TEAM_LAB_ACCOUNTS` | The built-in lab-account fixtures. |
| `US_STATES` | The 50 `USState` codes Junction accepts. |
| `ORDER_STATUSES_BY_METHOD` | Every order status in the contract, by collection method. |
| `TRANSITION_ALIASES` | The transition names above, by method. |
| `resolveTransition` | `(method, target) => { status } \| { error }` — how `/__admin/orders/{id}/transition` reads `to`. |
| `RESULT_FIXTURES` | Named results (`normal`, `abnormal`, `critical`, `missing_results`). |
| `FAULT_PRESETS` | Named Junction faults (`sandbox_user_quota`, `rate_limited`, `server_error`, `bad_gateway`, `unavailable`). |
| `createWebhookDispatcher` | `(endpoint: WebhookEndpoint) => WebhookDispatcher` — signed delivery with retries, standalone. |
| `signSvix` / `verifySvix` | Produce / check a standard Svix `svix-signature`. |
| `observationCacheKey` | `(url, method = "GET", body?) => string` — the `"<METHOD> <path>?<sorted query> <json>"` key corpora use. |
| `prefetchCoverageObservations` | Parity helper: records coverage-ZIP reads from the sandbox into an observation cache before `seedFrom`. |
| `reshapeCoverageGeoCommand` | Parity-walk hook that pins geo/availability parameters onto the coverage corpus. |
| `COVERAGE_ZIPS` | The ZIPs the shipped corpus covers. |
| `PSC_AVAILABILITY_ZIPS` | ZIPs that also get PSC availability observations. |
| `PHLEBOTOMY_AVAILABILITY_ZIPS` | ZIPs the sandbox serves phlebotomy availability for (`["85004"]`). |
| `PSC_LAB_IDS` | Lab ids used for PSC reads (`[4, 6, 13, 25]`). |
| `AVAILABILITY_ADDRESS` | Stable Phoenix, AZ address used in availability requests so cache keys match. |
| `AVAILABILITY_START_DATE` | Far-future availability `start_date` (`"2099-06-15"`). |

`./server` (Node): `createServer(options?) => Promise<JunctionServer>`, `serveTarget` (what
`serve` and `serve --config` use), `loadCorpus(source)`, `DEFAULT_PORT` (`8787`).
`./corpus`: `defaultCorpus`.

`JunctionRuntime` (from `createRuntime`) members: `fetch`, `instance(namespace?)`, `namespaces()`,
`reset(namespace? | "*")`, `snapshot(namespace?)`, `restore(snapshot, namespace?)`, `clock`
(`now`, `set`, `advance`, `freeze`, `unfreeze`, `reset`, `state`), `faults` (`add`, `list`,
`remove`, `clear`), `metrics` (`report`, `reset`), `webhooks` (`deliveries`, `replay`, `flush`,
`idle`, `clear`), `sqlite`, `rng`.

`JunctionAPI` members:

| Member | Description |
| --- | --- |
| `fetch(request)` | Handle one Junction REST request. |
| `reset()` | `Promise<void>` — clear state; re-install the corpus or default catalog, and the configured lab accounts. |
| `installCorpus(corpus)` | Install a `SealedCorpus`: observations (shared, read-only), catalog, labs, lab accounts, ZIP coverage. |
| `corpusInfo()` | `CorpusInfo \| undefined` — label, recording date, source and counts. |
| `geoMode` | `"corpus" \| "synthetic"`, settable. |
| `configureLabAccounts(accounts?)` / `labAccounts()` | Replace (or restore with `undefined`) / read the team's lab accounts. |
| `order(id)` / `orders()` | Read orders. |
| `transitionOrder(id, status, { now, flags? })` | Move an order to a full status and publish its webhook. |
| `installResultFixture(orderId, fixture)` / `resultFixture(orderId)` | Serve an exact result payload / PDF for an order. |
| `seedFrom(source, observations?)` | `Promise<SeedReport>` — copy users, orders, appointments, catalog and labs from a real Junction environment. |
| `ensureLabTests(source, ids)` / `ensureOrders(source, ids)` | `Promise<number>` — fetch specific lab tests / orders from `source` if missing. |
| `markUserDeleted(userId)` | Mark a user as deleted (subsequent reads behave like a deleted user). |
| `webhookEvents()` | `JunctionWebhookEvent[]`, oldest first. |
| `webhookDeliveryAttempts()` | The retry schedule Junction would follow per event (a record; see `webhooks` for delivery). |
| `app` / `sqlite` | The underlying Hono app and `SqliteClient`. |

Options and types:

```text
type JunctionAPIOptions = {
  sqlite?: SqliteClient          // share one client across services; default: fresh in-memory DB
  namespace?: string             // storage namespace; default "junction"
  now?: () => number             // clock in ms; default Date.now
  corpus?: SealedCorpus          // installed now and on every reset()
  geo?: "corpus" | "synthetic"   // default "corpus" with a corpus, else "synthetic"
  labAccounts?: LabAccountInput[]
  onWebhook?: WebhookPublisher   // called with every recorded event
  webhook?: JunctionWebhookOptions
}
type LabAccountInput = { id; lab; status?; delegated_flow?; account_name?; provider_account_id?; org_id?;
  business_units?; default_clinical_notes?; allowed_billing?: Record<billingType, State[]>; states?: State[];
  team_id_allowlist? }
type WebhookEndpoint = { url; secret: "whsec_…"; retryDelaysMs?: number[]; timeoutMs?; headers?; fetch? }
type ResultFixture = { name; results?: unknown[]; missing_results?: unknown[] | null; interpretation?; pdf_base64? }
type FaultRule = { id; operationId?; method?; pathPrefix?; status; body?; headers?; count?; rate?; delayMs? }
type JunctionWebhookOptions = { seed?: number; jitterRatio?: number /* 0..1, default 0.1 */; timeoutMs?: number }
type JunctionWebhookEvent = {
  event_type: "labtest.order.created" | "labtest.order.updated" | "labtest.appointment.updated"
  data: Record<string, unknown>; team_id: string; user_id: string; client_user_id: string
}
type SealedCorpus = { version: 1; recordedAt; source; fingerprint?; observations; catalog: { labTests; labs; expectedResults }; labAccounts }
type SeedSource = { fetch: (request: Request) => Promise<Response>; baseUrl: string; headers: Record<string, string> }
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

For contributors to the mockingbird repo only.

```bash
bun test                                   # offline suites, incl. scheduling state space
bun test junction.runtime.property.test.ts # service contract, corpus, lab accounts, faults, webhooks, verify
bun test junction.sdk.property.test.ts     # drives the served mock through @tryvital/vital-node

bun run mock:serve                         # env-configured `serve`: HOST, PORT, MOCKINGBIRD_JUNCTION_CORPUS,
                                           # MOCKINGBIRD_JUNCTION_WEBHOOK_URL / _SECRET / _SCOPE
bun run corpus:record -- --force           # re-record the shipped corpus/sandbox-sealed.json (Vault key)
bun run verify -- --real-key "$KEY"        # `mockingbird-junction verify` from source
```

Live parity (primary proof is seedParity: warmup N on the sandbox, `seedFrom`, then lockstep M):

```bash
bun run parity                                   # default mode=seed against api.sandbox.tryvital.io
bun run parity -- --warmup 15 --compare 30 --runs 25
bun run parity -- --mode=empty                   # legacy empty-start differential
```

Webhook parity needs a public receiver; see
[docs/webhook-parity.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/junction/docs/webhook-parity.md).

Part of [mockingbird](https://github.com/crvouga/mockingbird) — agent integration guide: [README](https://github.com/crvouga/mockingbird#readme) · [llms.txt](https://github.com/crvouga/mockingbird/blob/main/llms.txt).
