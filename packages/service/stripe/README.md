# @crvouga/mockingbird-service-stripe

Stateful, in-process mock of the [Stripe API](https://docs.stripe.com/api) for test suites. It is
driven by a vendored subset of Stripe's OpenAPI contract and verified by differential property tests
against Stripe test mode. Covered: customers (including search and balance transactions), payment
methods, payment and setup intents, charges, refunds, disputes (read-only), checkout sessions,
invoices and invoice items, subscriptions and subscription schedules, coupons and promotion codes,
products, prices, and an event ledger (`/v1/events`) with a webhook hook.

Use it when server-side code talks to Stripe through `fetch` or stripe-node and you want the suite
to run offline with no `api.stripe.com` egress. It does not serve Stripe.js or hosted checkout
(`js.stripe.com`, `checkout.stripe.com`); browser-driven checkout still needs real Stripe test mode.

- Operation coverage (88 of 108 operations in the vendored spec, with reasons for each gap):
  [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/stripe/SUPPORT.md)
- Scope and proof: [stripe-drop-in.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/stripe/docs/stripe-drop-in.md)
  · Consumer wiring checklist: [qa-followon.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/stripe/docs/qa-followon.md)
  · [QA coverage](https://github.com/crvouga/mockingbird/blob/main/packages/service/stripe/docs/qa-coverage.md)
- Stripe API reference: https://docs.stripe.com/api · Upstream OpenAPI: https://github.com/stripe/openapi

## Install

```bash
npm install -D @crvouga/mockingbird-service-stripe
```

ESM only. Requires Node >= 22 or Bun >= 1.2. No native dependencies: state lives in an in-memory
SQLite engine (pure TypeScript, bundled in). To serve it over HTTP run `npx mockingbird-stripe serve`, or
use `createServer` from `./server` (Node) or `createRuntime` with any Fetch server.

## Usage

Behaviour the examples rely on (all from the source):

- **Any host works.** Routing uses only the path (`/v1/...`), so `https://api.stripe.com`,
  `http://127.0.0.1:<port>` or any made-up origin is fine.
- **Auth is required.** Every request needs `Authorization: Bearer <key>` where the key matches
  `^(sk|rk)_test_[A-Za-z0-9]+$`. Missing header or any other shape (including `sk_live_...` and
  keys with extra underscores such as `sk_test_my_key`) returns Stripe's 401 error body.
- **One key = one account.** State is partitioned by bearer key, so an object created with
  `sk_test_a` is `resource_missing` (404) under `sk_test_b`.
- Request bodies are `application/x-www-form-urlencoded` with Stripe's bracket notation, exactly
  as stripe-node sends them. Every response carries `request-id` and `stripe-version` headers.
- `Idempotency-Key` on POSTs is honoured: a replay returns the cached response, a replay with
  different parameters returns 400.

### Serve it: `mockingbird-stripe serve` or `createServer`

```bash
npx mockingbird-stripe serve                 # http://127.0.0.1:12111
npx mockingbird-stripe serve --port 0 --log json --admin-key local-admin
npx mockingbird-stripe serve --config mockingbird.json   # every service in one config
```

```ts
import { createServer } from "@crvouga/mockingbird-service-stripe/server"

const server = await createServer() // any free port; server.url, server.port
const response = await fetch(`${server.url}/v1/products?limit=3`, { headers: { authorization: "Bearer sk_test_mockingbird" } })
console.log(response.status) // 200
await server.close()
```

Served this way — or through `createRuntime()`, the same thing as one runtime-neutral `fetch` —
the mock also answers Mockingbird's service contract, outside Stripe's bearer-key check:

- `GET /health` — unauthenticated readiness probe.
- `/__admin/*` — reset (`POST /__admin/reset`), snapshots (`POST /__admin/snapshots`,
  `POST /__admin/snapshots/{id}/restore`), clock (`POST /__admin/clock {"advance": "2h"}`), fault
  injection (`POST /__admin/faults {"operationId": …, "status": 503, "count": 1}`), and metrics with
  unmatched-route counts (`GET /__admin/metrics`). `GET /__admin` lists every route; `--admin-key`
  locks them behind `x-mockingbird-admin-key`.
- `x-mockingbird-namespace: <name>` — isolates a request's data, so parallel workers share one
  process without seeing each other.

The [Junction README](https://github.com/crvouga/mockingbird/tree/main/packages/service/junction#the-service-contract)
documents the contract in full.

### In-process (inject `fetch`)

```ts
import { StripeAPI } from "@crvouga/mockingbird-service-stripe"

const stripe = new StripeAPI({ now: () => Date.UTC(2026, 0, 1) })

const auth = { authorization: "Bearer sk_test_mockingbird" }

const created = await stripe.fetch(
  new Request("https://api.stripe.com/v1/customers", {
    method: "POST",
    headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "qa@example.com", "metadata[userId]": "1001" }),
  }),
)
const customer = (await created.json()) as { id: string; created: number }
console.log(created.status, customer.id) // 200 "cus_..."

// Any code that accepts a fetch function can be pointed at the mock:
const mockFetch = (input: string | URL | Request, init?: RequestInit) =>
  stripe.fetch(new Request(input, init))
const listed = await mockFetch("https://api.stripe.com/v1/customers?limit=10", { headers: auth })
console.log(((await listed.json()) as { data: unknown[] }).data.length) // 1
```

`now` drives `created`-style fields (Stripe returns seconds; `now` returns milliseconds).

### Over HTTP

```ts
import { StripeAPI } from "@crvouga/mockingbird-service-stripe"

const stripe = new StripeAPI()
const server = Bun.serve({
  port: 0, // ephemeral
  hostname: "127.0.0.1",
  fetch: (request) => stripe.fetch(request),
})
const baseUrl = `http://127.0.0.1:${server.port}`

const response = await fetch(`${baseUrl}/v1/products?limit=3`, {
  headers: { authorization: "Bearer sk_test_mockingbird" },
})
console.log(response.status) // 200

server.stop()
```

On Node, `createServer` (above) is the listener; any Fetch-style server also works with
`StripeAPI#fetch` or `createRuntime().fetch`.

### Pointing stripe-node at it

stripe-node accepts `host`, `port` and `protocol`. This is the construction the package's own
client smoke test uses (stripe 16.x, `apiVersion: "2024-06-20"`):

```js
import Stripe from "stripe"

const client = new Stripe("sk_test_mockingbird", {
  apiVersion: "2024-06-20",
  host: "127.0.0.1",
  port: server.port, // from Bun.serve() above
  protocol: "http",
})
await client.customers.create({ email: "qa@example.com" })
```

With `mockingbird-stripe serve` on port 12111, host, port and protocol are the only wiring. Add a
base-URL override (e.g. `STRIPE_API_BASE_URL=http://127.0.0.1:12111`) at every place your app
constructs a Stripe client; a client built with `new Stripe(key)` and no options cannot be
redirected. Test payment methods and tokens such as `pm_card_visa`, `pm_card_authenticationRequired`
and `tok_chargeDeclinedInsufficientFunds` behave like their Stripe counterparts
(`QA_TEST_PAYMENT_METHODS` and `QA_TEST_CARD_TOKENS` list the ones the suites exercise).

### Webhooks

The mock records an event for every state change (readable through `GET /v1/events` and
`webhookEvents()`), and calls `onWebhook` with each one. Delivery and signing are up to you;
Stripe signs `"<t>.<body>"` with HMAC-SHA256 keyed by the `whsec_` secret verbatim, which
`stripe.webhooks.constructEvent` accepts:

```ts
import { createHmac } from "node:crypto"
import { accountOfKey, StripeAPI } from "@crvouga/mockingbird-service-stripe"

const WEBHOOK_URL = "http://127.0.0.1:3100/webhooks/stripe"
const WEBHOOK_SECRET = "whsec_local_test"
const account = accountOfKey("sk_test_mockingbird")

const stripe = new StripeAPI({
  onWebhook: (event) => {
    if (event.account !== account) return
    const t = Math.floor(Date.now() / 1000)
    const v1 = createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${event.body}`).digest("hex")
    void fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${v1}` },
      body: event.body,
    }).catch(() => undefined)
  },
})

// Or assert on recorded events directly:
console.log(stripe.webhookEvents(account).map((event) => event.type))
```

### Resetting between tests

`reset()` clears every account's objects, the event ledger and the idempotency cache. Create one
instance per suite and reset it in `beforeEach`:

```ts
import { beforeEach, expect, test } from "bun:test"
import { StripeAPI } from "@crvouga/mockingbird-service-stripe"

const stripe = new StripeAPI()
beforeEach(() => stripe.reset())

test("starts empty", async () => {
  const response = await stripe.fetch(
    new Request("https://api.stripe.com/v1/customers", {
      headers: { authorization: "Bearer sk_test_mockingbird" },
    }),
  )
  expect(((await response.json()) as { data: unknown[] }).data).toEqual([])
})
```

## API

`StripeAPI` is the main export; the rest supports account scoping, contract introspection and the
QA corpus used by the parity suites.

| Export | Description |
| --- | --- |
| `createRuntime` | `(options?) => StripeRuntime` — the mock with the service contract (health, admin, namespaces, clock, faults, metrics) as one runtime-neutral `fetch`. Options: `sqlite`, `clock`, `seed`, `adminKey`, `onLog`, `onWebhook`. `./server` adds `createServer(options?)` (Node; `port`, `host`), `serveTarget` and `DEFAULT_PORT` (`12111`). |
| `StripeAPI` | Class. `new StripeAPI(options?)`; implements the Fetch contract `fetch(request: Request): Promise<Response>`. |
| `accountOfKey` | `(key: string) => string` — the opaque `acct_...` partition id for an API key (use it to filter `webhookEvents`). |
| `accountOf` | `(request: Request) => string` — the partition id for a request's bearer key. |
| `STRIPE_NAMESPACE` | `"stripe"` — SQLite namespace holding every Stripe record when sharing a `sqlite` client. |
| `document` | The vendored Stripe OpenAPI document (Mockingbird subset) that drives routing and validation. |
| `operationIds` | Every `operationId` in `document` (108). |
| `supportedOperationIds` | The `operationId`s the mock implements (88); the rest return a Stripe-shaped error. |
| `QA_SURFACE_OPS` | Operations the QA suites exercise (same set as `supportedOperationIds`). |
| `QA_METADATA` | Pinned metadata values (`intent`, `source`, `userId`) the suites send. |
| `QA_AMOUNTS` | Pinned amounts in cents: `1000`, `15000`, `17999`. |
| `QA_CUSTOMER` | Pinned customer `email`, `name`, `phone`. |
| `QA_TEST_PAYMENT_METHODS` | Test payment method ids the suites attach (`pm_card_visa`, ...). |
| `QA_TEST_CARD_TOKENS` | Test card tokens the suites use (`tok_visa`, decline tokens, ...). |
| `QA_SEARCH_QUERIES` | Search queries the suites issue against `/v1/customers/search`. |
| `QA_COUPON_CODES` | Coupon / promotion codes used by the coupon flows. |
| `reshapeQaCommand` | Parity-walk hook that pins sampled commands onto QA corpus values (for the repo's parity runner). |

`StripeAPI` members:

| Member | Description |
| --- | --- |
| `fetch(request)` | Handle one Stripe REST request. |
| `reset()` | `Promise<void>` — clear all state, events and cached idempotent responses. |
| `webhookEvents(account?)` | `StripeWebhookEvent[]`, oldest first; `account` narrows to one `accountOfKey(...)` partition. |
| `webhookDeliveryAttempts(account?)` | Delivery attempts recorded for the event ledger. |
| `importStateFrom(source)` | Adopt another `StripeAPI` instance's state (used by seeded parity walks). |
| `app` | The underlying Hono app. |
| `sqlite` | The `SqliteClient` holding state. |

Options and types:

```text
type StripeAPIOptions = {
  sqlite?: SqliteClient        // share one client across services; default: fresh in-memory DB
  now?: () => number           // clock in ms for created-style fields; default Date.now
  onWebhook?: WebhookPublisher // called with every event the mock records
}
type StripeWebhookEvent = { type: string; account: string; body: string } // body is the JSON event
type WebhookPublisher = (event: StripeWebhookEvent) => void
type OperationId / SupportedOperationId  // string unions of operationIds / supportedOperationIds
```

`SqliteClient` is the storage port bundled with this package (`exec`, `prepare(sql).run/all/get`,
`transaction`); `Database` from `@crvouga/mockingbird-service-sqlite` satisfies it, as do
better-sqlite3 and wrapped `bun:sqlite`.

## Development

For contributors to the mockingbird repo only; these scripts are not shipped in the npm package.

```bash
bun test                     # self-parity, auth/idempotency and namespace suites (offline)
bun run mock:server          # serve over HTTP on PORT (default 12111), GET /health for readiness
bun run client-parity        # stripe-node smoke proof, including webhook signature verification
bun run parity               # live differential parity against Stripe test mode
MOCKINGBIRD_STRIPE_SECRET_KEY=sk_test_... bun run parity -- --only GetPrices,GetProducts
```

`mock:server` delivers webhooks to the targets in `MOCKINGBIRD_STRIPE_WEBHOOK_TARGETS` (a JSON array
of `{apiKey, url, secret}`, matched by the API key that produced the event) or to a single fallback
target from `MOCKINGBIRD_STRIPE_WEBHOOK_URL` + `MOCKINGBIRD_STRIPE_WEBHOOK_SECRET`:

```bash
PORT=12111 MOCKINGBIRD_STRIPE_WEBHOOK_TARGETS='[{"apiKey":"sk_test_mso","url":"http://127.0.0.1:3100/billing/webhooks/stripe/mso","secret":"whsec_..."}]' bun run mock:server
```

Live parity needs a real `sk_test_` key and mutates a shared test account.

Part of [mockingbird](https://github.com/crvouga/mockingbird) — agent integration guide: [README](https://github.com/crvouga/mockingbird#readme) · [llms.txt](https://github.com/crvouga/mockingbird/blob/main/llms.txt).
