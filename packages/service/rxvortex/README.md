# @crvouga/mockingbird-service-rxvortex

Stateful mock of the **RxVortex (Strive)** compounding-pharmacy API for test suites: the
client-credentials token, order submit, status, cancel, the recovery lookup by sender order id,
the preset catalog, and the signed status webhooks the pharmacy posts back. Orders move only
when a test says so (an admin transition or an auto-advance path on the mock clock), so an eRx
suite that waited up to 60 s on the real sandbox resolves in milliseconds.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/rxvortex/SUPPORT.md)
- The vendor publishes no spec: the contract (`openapi.yaml`) is hand-authored from the wire
  shapes our consumer reads and writes, and every field fallback it relies on is served.

## Install

```bash
npm install -D @crvouga/mockingbird-service-rxvortex
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-rxvortex serve`, `createServer` from `./server` (Node), or `createRuntime` with
any Fetch server.

## Usage

Point `RXVORTEX_API_URL` at the mock. Set `RXVORTEX_WEBHOOK_SECRET` in the app and pass the same
value as `--webhook-secret`.

```bash
npx mockingbird-rxvortex serve --port 8791 \
  --webhook-url http://127.0.0.1:3000/prescriptions/webhooks/rxvortex \
  --webhook-secret "$RXVORTEX_WEBHOOK_SECRET" \
  --auto-advance "2000:Fill,Shipping,Delivered"
```

```ts
import { createRuntime } from "@crvouga/mockingbird-service-rxvortex"

const rx = createRuntime({
  webhooks: { url: "http://127.0.0.1:3000/prescriptions/webhooks/rxvortex", secret: "whsec-test" },
})
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  rx.fetch(
    new Request(`http://rxvortex.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  )

const { access_token } = (await (
  await post("/api/v1/generate-access-token", { client_id: "acme", client_secret: "s" })
).json()) as { access_token: string }
// …the app submits POST /api/v1/orders with Authorization: Bearer <access_token>…

// Move an order the way the pharmacy would; each step emits the signed status webhook.
await post("/__admin/orders/pay_123/transition", { to: "Shipping", trackingnumber: "1Z999" })
await post("/__admin/orders/pay_123/transition", { to: "Delivered" })
```

### Routes

| Route | Behaviour |
| --- | --- |
| `POST /api/v1/generate-access-token` | JSON `{client_id, client_secret}` → `{access_token, token_type: "Bearer", expires_in: 86400}`. Any pair works unless `clients` is set (`PUT /__admin/settings`). Tokens stay valid 24 h on the mock clock; our client caches for 24 h and never refreshes on 401. |
| `POST /api/v1/orders` | Validates the submit payload against the contract; a violation is 422 `{message, errors: {"patient.phone": ["…"]}}`. An inactive or unknown `preset_catalog_id` is 422. A repeated `order.sender_order_id` is 409. Success: `{success: true, order_tracking_id: "RXV-…", sender_order_id, status: "Created"}` (the tracking id is always a string). |
| `GET /api/v1/orders/{id}` | `id` is the tracking id **or** the sender order id (our payment id, the recovery lookup). Returns `rxstatus`, `orderstatus`, `shipping_status`, `delivered_date`, `trackingnumber`, `shippingservice`, `shippingcarrier`, `shipmenttrackingurl`, `cancellable`, and the id under `order_tracking_id`, `tracking_id` and `orderReferenceID`. |
| `DELETE /api/v1/orders/{id}` | Cancels while `cancellable` (until shipped), emitting the webhook; otherwise 409. |
| `GET /api/v1/preset-catalog-items` | `{data: [...]}` rows with `catalog_id`, `medication_name`, `medication_strength`, `package_size`, `quantity`, `quantity_units`, `medication_form`, `route`, `states`, `status`. Includes the custom-cream anchor preset `e404ad76-0f82-4b04-8f25-841650e2e819` and one inactive row. |

### Webhooks

Every status change posts `{event: "order.status_updated", orderReferenceID, order_tracking_id,
tracking_id, sender_order_id, rxstatus, orderstatus, shipping_status, delivered_date,
trackingnumber, shippingcarrier, shippingservice, shipmenttrackingurl, updated_at}` with header
`x-rxvortex-webhook-secret: <secret>` (plain equality, as our receiver checks). Non-2xx answers
are retried (immediately, 5 s, 5 min, 30 min, 2 h). `GET /__admin/webhooks` lists deliveries,
`GET /__admin/webhooks/events` the payloads, `POST /__admin/webhooks/flush` runs pending retries
now, and `PUT /__admin/webhook-endpoints` sets per-namespace receivers.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `POST /__admin/orders/:id/transition` | `{to, trackingnumber?, shippingcarrier?, shippingservice?, delivered_date?}`. `to` is a vendor status: `Fill`, `PV1 Complete`, `Compound`, `Out of Stock`, `On Hold`, `Shipping`, `Delivered`, `Cancelled`, `Rejected`, `Error`, or any string (used verbatim). The three status fields move together; shipping generates tracking when none is given. |
| `PUT /__admin/settings` | `{tokenTtlSeconds?, staticTokens?, clients?, autoAdvance?: {afterMs, path} \| null}` for the calling namespace. `staticTokens` admits `RXVORTEX_API_TOKEN` (the catalog client's static bearer). |
| `POST /__admin/tick` | Apply every auto-advance step that is due on the mock clock (the served mock also ticks every 100 ms). |
| `GET /__admin/orders` | The namespace's orders. |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`; `GET /__admin/faults/presets`):
`duplicate_sender_order_id`, `created_but_500` (creates, then 500; recovery succeeds),
`numeric_tracking_id`, `token_expired`, `stale_error_with_delivered_date`,
`validation_errors_array`, `validation_errors_object`, `validation_errors_empty`, `server_error`,
`webhook_duplicate`, `webhook_reorder`, `webhook_drop`.

### Namespaces

Our backend's `fetch` cannot add headers, so a namespace can be chosen three ways:
`x-mockingbird-namespace`, a `/ns/<name>` prefix on `RXVORTEX_API_URL`, or by client id:
`PUT /__admin/credentials {"credentials": {"<RXVORTEX_CLIENT_ID>": "<namespace>"}}` (tokens carry
the client id they were issued to).

### Deliberately not modelled

- Real fulfilment timing: nothing moves on its own unless `autoAdvance` is set.
- Patient and prescriber details are validated, never stored or echoed back.
- The live catalog: the default rows are synthesised in the live client's field names (no
  sandbox recording exists); pass `catalog` to load recorded rows.
- Refills and multi-order shipments.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `RxVortexAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `transition(id, {to, …})`, `tick()`, `orders()`. Options: `sqlite`, `now`, `namespace`, `catalog`, `settings`, `onWebhook`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, namespaces, credentials, presets, webhooks). Options: `webhooks: {url, secret, retryDelaysMs?, fetch?}`, `settings`, `catalog`, `tickMs`, `clock`, `seed`, `adminKey`, `onLog`. |
| `RXVORTEX_PRESETS` | object | Every named fault preset. |
| `RXVORTEX_NAMESPACE` | string | The service name, `"rxvortex"`. |
| `tokenCredential` | function | The client id a bearer token was issued to (how credentials map to namespaces). |
| `CUSTOM_CREAM_ANCHOR_PRESET_ID` | string | The sandbox custom-cream anchor preset id. |
| `DEFAULT_CATALOG` | array | The default preset catalog rows. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http` (auto-advance ticks every 100 ms); the `serve` CLI target; port 8791. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
