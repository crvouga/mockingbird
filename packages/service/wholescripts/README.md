# @crvouga/mockingbird-service-wholescripts

Stateful mock of the **Wholescripts** supplement fulfilment API for test suites: the product
catalog, the private-label (MedPax) catalog, order submit, status polling and cancel. Orders
move only when a test says so (an admin transition or an auto-advance path on the mock clock).
Wholescripts sends no webhooks, so the app sees each change on its next status poll.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/wholescripts/SUPPORT.md)
- The vendor publishes no spec. The contract (`openapi.yaml`) is hand-authored from our
  consumers' zod schemas (backend and EMR `wholescripts.types.ts`) and the Makor Python client.

## Install

```bash
npm install -D @crvouga/mockingbird-service-wholescripts
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-wholescripts serve`, `createServer` from `./server` (Node), or `createRuntime`
with any Fetch server.

## Usage

Point `WHOLESCRIPTS_API_URL` at the mock. It is read by the backend
(`global-services/services/wholescripts`), the EMR (`services/wholescripts`) and Makor
(`supplement_management`). Any non-empty `WHOLESCRIPTS_USERNAME` / `WHOLESCRIPTS_PASSWORD`
pair is accepted unless you pin one with `--username/--password`.

```bash
npx mockingbird-wholescripts serve --port 8803 --auto-advance "2000:Processing,Complete"
```

```ts
import { createRuntime } from "@crvouga/mockingbird-service-wholescripts"

const ws = createRuntime()
const auth = { authorization: `Basic ${btoa("geviti:secret")}`, "content-type": "application/json" }

const submitted = (await (
  await ws.fetch(
    new Request("http://wholescripts.test/api/Orders/Submit", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        ShippingAddress: { FName: "Ada", LName: "L", Address1: "1 Main St", City: "Phoenix", State: "AZ", Zip: "85004" },
        Items: [{ Sku: "SKU001", Quantity: 1 }],
        ShippingMethod: "Ground",
      }),
    }),
  )
).json()) as { orderNumber: string }

// Ship it the way the vendor would; the next GET /api/Orders/Status poll sees it.
await ws.fetch(
  new Request(`http://wholescripts.test/__admin/orders/${submitted.orderNumber}/transition`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: "Complete", trackingNumber: "1Z999", carrier: "UPS" }),
  }),
)
```

### Routes

| Route | Behaviour |
| --- | --- |
| `GET /api/Orders/PrivateLabelProductList` | `{privateLabelProducts: [], medPaxPills: [{sku, genericName, privateLabelName, quantity}], privateLabelCartons: [{sku, name, cartonImage, quantity}]}`. |
| `GET /api/Orders/ProductList` | Product rows (`productName`, `sku`, `medPaxSku`, `categories`, prices, `quantity`, `defaultDosing`, optional `medPaxDetails`). `instockonly=true` keeps `quantity > 0` (the EMR), `search` matches name/SKU/brand/categories (Makor), `limit` caps. |
| `POST /api/Orders/Submit` | `{ShippingAddress, Notes?, Items: [{Sku, Quantity, MedPaxName?, MedPaxPills?: [{Sku, Quantity, ItemTime}]}], ShippingMethod}` → `{orderNumber, success: true, msg}`. A contract violation or an unknown SKU (product, MedPax, pill or carton SKU) is still **200** with `success: false` and the reason in `msg`, which is what both consumers read. |
| `GET /api/Orders/Status?ordernum=` | `[{orderNumber, orderDate, salesOrder, status, tracking: [{trackingNumber, carrier, trackingUrl}], message, subTotal, shipMethod, shipCharge, discount, tax, serviceFee, orderTotal}]`; `[]` for an unknown order. Totals are priced from the catalog (MedPax SKUs at their `medPaxDetails` price) plus 9.95 shipping (0 for "free" methods). |
| `POST /api/Orders/Cancel` | `{OrderNumber}` → `{success, msg}`. Succeeds while `Pending`/`Processing` with no tracking; otherwise `success: false`. Unknown order: 404. |

Missing or wrong Basic credentials answer 401 `{"Message": "Authorization has been denied for this request."}`.

Statuses are `Pending` (new), `Processing`, `Complete`, `Cancelled`, `Error`, or any string a
test sets. How our consumers read them: Makor maps `Pending`/`Processing` to `placed` (or
`shipped` once tracking exists), `Complete` to `shipped` (carrier hand-off, not delivery),
anything containing `cancel`/`error` to `cancelled`/`failed`, and everything else to `unknown`.
The backend and EMR do not map statuses.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `POST /__admin/orders/:orderNumber/transition` | `{to, trackingNumber?, carrier?, trackingUrl?, message?}`. A tracking number is appended to `tracking`; `Complete` without one generates a UPS number. `Processing`/`Complete` set `salesOrder`. |
| `GET /__admin/orders` | The namespace's orders (SKUs and quantities only). |
| `GET`/`PUT /__admin/catalog` | Read or replace `{products, medPaxPills, privateLabelCartons}` for the namespace. |
| `GET`/`PUT /__admin/settings` | `{accounts?: [{username, password}], autoAdvance?: {afterMs, path} \| null}`. |
| `POST /__admin/tick` | Apply every auto-advance step that is due on the mock clock (the served mock ticks every 100 ms). |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`; `GET /__admin/faults/presets`):
`submit_rejected` (200 `success: false`), `submit_timeout` (the order is placed, then the
connection drops: Makor's "order may have been placed" branch), `status_empty` (`[]`),
`status_schema_drift` (rows the backend's zod rejects, so it returns `null`), `server_error`
(500, which Makor retries), `unauthorized` (401).

### Namespaces

`x-mockingbird-namespace`, a `/ns/<name>` prefix on `WHOLESCRIPTS_API_URL`, or by Basic
username: `PUT /__admin/credentials {"credentials": {"<WHOLESCRIPTS_USERNAME>": "<namespace>"}}`.

### Corpus and seed data

The default catalog is the rows our consumers' own tests use
(`geviti-emr-backend/tests/unit/services/wholescripts-service.test.ts`), with their repeated
`medPaxSku`s made unique, plus the Makor MedPax box `000000000200095263` and `medPaxDetails`
rows the Makor catalog sync reads. `Protein Powder` (`PP001`) is out of stock. No sandbox
recording exists; pass `catalog` (or `PUT /__admin/catalog`) to load recorded rows.

### Deliberately not modelled

- Webhooks: Wholescripts has none; status is polled.
- Real fulfilment timing, partial shipments and returns: nothing moves unless a test or
  `autoAdvance` moves it.
- Shipping address and recipient are validated but never stored or echoed back (PHI).
- Real tax, discounts, service fees and carrier rates: tax/discount/fee are 0, shipping is flat.
- Payment authorization: a failed payment is only reachable through `submit_rejected` or an
  `Error` transition.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `WholescriptsAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `transition(orderNumber, {to, …})`, `tick()`, `orders()`. Options: `sqlite`, `now`, `namespace`, `catalog`, `settings`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, namespaces, credentials, presets). Options: `catalog`, `settings`, `tickMs`, `clock`, `seed`, `adminKey`, `onLog`. |
| `WHOLESCRIPTS_PRESETS` | object | Every named fault preset. |
| `WHOLESCRIPTS_NAMESPACE` | string | The service name, `"wholescripts"`. |
| `basicUsername` | function | The Basic username a request carries (how credentials map to namespaces). |
| `canonicalStatus` | function | The canonical casing of a transition target (`complete` → `Complete`). |
| `DEFAULT_CATALOG` | object | The default `{products, medPaxPills, privateLabelCartons}`. |
| `MEDPAX_BOX_SKU` | string | The Makor MedPax box SKU, `000000000200095263`. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http` (auto-advance ticks every 100 ms); the `serve` CLI target; port 8803. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
