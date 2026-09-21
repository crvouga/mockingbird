# @crvouga/mockingbird-service-genebygene

Stateful, in-process mock of the [GeneByGene Nucleus API](https://api.genebygene.com/swagger/index.html)
for test suites. It covers the OAuth client-credentials token endpoint, the product catalog, and
order create/read: all 4 operations of the vendored OpenAPI subset, each verified by live parity
against GeneByGene staging.

Use it when your backend orders kits from GeneByGene and you want tests to run offline, with no
staging credentials.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/genebygene/SUPPORT.md)
- Developer guide (PDF): https://api.genebygene.com/assets/GxG%20API%20Services%20Developer%20Guide%202022.pdf
- Swagger UI: https://api.genebygene.com/swagger/index.html
- Real staging hosts: API `https://staging-api.genebygene.com`, auth
  `https://staging-auth.genebygene.com/connect/token`

## Install

```bash
npm install -D @crvouga/mockingbird-service-genebygene
```

ESM only. Requires Node >= 22 or Bun >= 1.2. No native dependencies: state lives in an in-memory
SQLite engine (pure TypeScript, bundled in). To serve it over HTTP run `npx mockingbird-genebygene serve`, or
use `createServer` from `./server` (Node) or `createRuntime` with any Fetch server.

## Usage

Routes and behaviour (all from the source):

| Route | Behaviour |
| --- | --- |
| `POST /connect/token` | Form (or JSON) body with `grant_type=client_credentials`, `client_id`, `client_secret`. Any non-empty id/secret is accepted; returns `{ access_token, token_type: "Bearer", expires_in: 3600 }`. The token is deterministic per id/secret pair. Wrong grant type: 400 `unsupported_grant_type`; missing id/secret: 400 `invalid_client`. |
| `GET /api/v2/products` | Requires `Authorization: Bearer <anything>`. Returns an array; a seed product `product_default` ("Mockingbird Default Kit") always exists. |
| `POST /api/v2/orders` | Bearer required. JSON `{ productId, quantity }` (`quantity` a positive integer, `productId` must exist, else 400). Returns `{ orderId: "order_...", status: "Pending", quantity, productId, createdAt }`. |
| `GET /api/v2/orders/{orderId}` | Bearer required. The stored order, or 404 `{ message: "order not found" }`. |

- **Any host works.** Routing uses only the path, so the auth host and the API host of the real
  service both map onto one mock instance: point both your token URL and API base URL at it.
- **The bearer token is not validated.** Any `Authorization: Bearer <value>` passes; a missing or
  non-Bearer header returns 401 `{ error: "unauthorized" }`.
- Orders stay `Pending`; there are no status transitions.

### Serve it: `mockingbird-genebygene serve` or `createServer`

```bash
npx mockingbird-genebygene serve                 # http://127.0.0.1:8788
npx mockingbird-genebygene serve --port 0 --log json --admin-key local-admin
npx mockingbird-genebygene serve --config mockingbird.json   # every service in one config
```

```ts
import { createServer } from "@crvouga/mockingbird-service-genebygene/server"

const server = await createServer() // any free port; server.url, server.port
const response = await fetch(`${server.url}/api/v2/products`, { headers: { authorization: "Bearer any-token" } })
console.log(response.status) // 200
await server.close()
```

Served this way — or through `createRuntime()`, the same thing as one runtime-neutral `fetch` —
the mock also answers Mockingbird's service contract, outside the bearer-token check:

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
import { GeneByGeneAPI } from "@crvouga/mockingbird-service-genebygene"

const gbg = new GeneByGeneAPI({ now: () => Date.UTC(2026, 0, 1) })

const tokenResponse = await gbg.fetch(
  new Request("https://staging-auth.genebygene.com/connect/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "demo",
      client_secret: "demo",
    }),
  }),
)
const { access_token } = (await tokenResponse.json()) as { access_token: string }
const auth = { authorization: `Bearer ${access_token}` }

const products = (await (
  await gbg.fetch(new Request("https://staging-api.genebygene.com/api/v2/products", { headers: auth }))
).json()) as { productId: string }[]

const orderResponse = await gbg.fetch(
  new Request("https://staging-api.genebygene.com/api/v2/orders", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ productId: products[0]?.productId, quantity: 1 }),
  }),
)
console.log(await orderResponse.json())
// { orderId: "order_...", status: "Pending", quantity: 1, productId: "product_default", createdAt: "2026-01-01T00:00:00.000Z" }
```

`now` (milliseconds) drives `createdAt`.

### Over HTTP

```ts
import { GeneByGeneAPI } from "@crvouga/mockingbird-service-genebygene"

const gbg = new GeneByGeneAPI()
// port 0 = ephemeral
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => gbg.fetch(request) })
const baseUrl = `http://127.0.0.1:${server.port}`

// Use baseUrl for both the auth host and the API host in your app's config:
const tokenUrl = `${baseUrl}/connect/token`
const apiBaseUrl = baseUrl

const token = await fetch(tokenUrl, {
  method: "POST",
  body: new URLSearchParams({ grant_type: "client_credentials", client_id: "id", client_secret: "secret" }),
})
console.log(token.status, apiBaseUrl) // 200

server.stop()
```

On Node, `createServer` (above) is the listener; any Fetch-style server also works with
`GeneByGeneAPI#fetch` or `createRuntime().fetch`.

### Resetting between tests

`reset()` deletes all orders and products, then re-seeds `product_default`:

```ts
import { beforeEach, expect, test } from "bun:test"
import { GeneByGeneAPI } from "@crvouga/mockingbird-service-genebygene"

const gbg = new GeneByGeneAPI()
beforeEach(() => gbg.reset())

test("catalog has the seed product", async () => {
  const response = await gbg.fetch(
    new Request("https://staging-api.genebygene.com/api/v2/products", {
      headers: { authorization: "Bearer test" },
    }),
  )
  expect(await response.json()).toEqual([
    {
      productId: "product_default",
      name: "Mockingbird Default Kit",
      description: "Seed product for GeneByGene mock",
    },
  ])
})
```

## What is and is not modelled

- **Modelled**: all four operations in the vendored subset (see
  [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/genebygene/SUPPORT.md)),
  each verified by live parity against GeneByGene staging, including the documented token and
  validation errors.
- **Not modelled**: any endpoint outside those four, which 404s and is counted in
  `GET /__admin/metrics` under `unmatched`; real rate-limit and 5xx bodies — `POST /__admin/faults`
  injects Mockingbird's own, which are shape-plausible, not recorded; token expiry is reported
  (`expires_in: 3600`) but never enforced.
- **Determinism**: tokens are deterministic per client id/secret pair, and with a fixed clock and
  `seed` ids and timestamps replay exactly.

## API

| Export | Description |
| --- | --- |
| `createRuntime` | `(options?) => GeneByGeneRuntime` — the mock with the service contract (health, admin, namespaces, clock, faults, metrics) as one runtime-neutral `fetch`. Options: `sqlite`, `clock`, `seed`, `adminKey`, `onLog`. `./server` adds `createServer(options?)` (Node; `port`, `host`), `serveTarget` and `DEFAULT_PORT` (`8788`). |
| `GeneByGeneAPI` | Class. `new GeneByGeneAPI(options?)`; implements the Fetch contract `fetch(request: Request): Promise<Response>`. Members: `fetch(request)`, `reset()`, `app` (Hono app), `sqlite` (`SqliteClient`). |
| `GENEBYGENE_NAMESPACE` | `"genebygene"` — SQLite namespace holding the mock's state when sharing a `sqlite` client. |
| `document` | The vendored GeneByGene OpenAPI document (Mockingbird subset) that drives routing. |
| `operationIds` | Every `operationId` in `document`: `PostConnectToken`, `GetProducts`, `PostOrders`, `GetOrder`. |
| `supportedOperationIds` | The `operationId`s the mock implements (all four). |

Options and types:

```text
type GeneByGeneAPIOptions = {      // exported: constructor options
  sqlite?: SqliteClient            // share one client across services; default: fresh in-memory DB
  now?: () => number               // clock in ms for createdAt; default Date.now
}
type OperationId / SupportedOperationId  // string unions of operationIds / supportedOperationIds
```

## Development

For contributors to the mockingbird repo only; the parity script is not shipped in the npm package.

```bash
bun test                     # offline property suites
bun run parity               # live parity against GeneByGene staging (credentials from env or OpenBao)
MOCKINGBIRD_GENEBYGENE_CLIENT_ID=... MOCKINGBIRD_GENEBYGENE_CLIENT_SECRET=... bun run parity
```

Live parity exercises the token endpoint against staging auth and discovers product ids from the
real catalog before creating orders (the live catalog differs from the mock's seed product).

Part of [mockingbird](https://github.com/crvouga/mockingbird) — agent integration guide: [README](https://github.com/crvouga/mockingbird#readme) · [llms.txt](https://github.com/crvouga/mockingbird/blob/main/llms.txt).
