# @crvouga/mockingbird-service-genebygene

Stateful mock of **Gene by Gene's Nucleus API v2** (and its OAuth auth host) for test suites:
client-credentials tokens with the credential-blocking failures, the product catalog, shipping
quotes, order placement (shipped and quantity-only, plus orders for existing kits), order
lines, fulfillments and address edits, kits and their demographics attributes, the three-layer
cancel, results with presigned downloads, notification subscriptions, and GxG-signed
notifications. Kits move along the lab's status ladder only when a test says so, so genomics
suites that serialised on one staging slot with 15 s sleeps and 300 s waits resolve in
milliseconds.

> The catalog calls this package `@crvouga/mockingbird-service-gene-by-gene`; it is published as
> `@crvouga/mockingbird-service-genebygene` (bin `mockingbird-genebygene`).

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/genebygene/SUPPORT.md)
  (30 of the 51 operations; every one our consumer calls).
- Contract: `openapi.yaml` is the full Nucleus v2 Swagger document our consumer commits
  (`GXG/transport/spec/gxg-openapi.json`, from `demo-api.genebygene.com`), vendored by
  `scripts/vendor-openapi.ts`. The script adds operationIds and Mockingbird annotations, the fields
  the live API returns but Swagger omits (`ProductDto.preassembly`,
  `OrderLineDto.placerOrderNumber`/`kitNumbers`, `CreateOrder_Item.placerOrderNumber`, `null`
  courier objects), schemas for the bodies Swagger leaves out (`eventTypes`,
  `kitorderlines/kits`, `results/search`, `presignedUrl`), and the auth host's `/connect/token`.

## Install

```bash
npm install -D @crvouga/mockingbird-service-genebygene
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-genebygene serve` (default port 8788), `createServer` from `./server` (Node), or
`createRuntime` with any Fetch server.

## Usage

The mock serves the API **and** the auth host on one port. Point the app at it:

| App env | Value |
| --- | --- |
| `GENE_BY_GENE_API_URL` | `http://127.0.0.1:8788` (or `…/ns/<namespace>`) |
| `GENE_BY_GENE_ACCESS_TOKEN_URL` | `http://127.0.0.1:8788/connect/token` (or `…/ns/<namespace>/connect/token`) |
| `GENE_BY_GENE_API_KEY` / `_CLIENT_SECRET` | anything, unless `--client-id/--client-secret` pin a pair |
| `GENE_BY_GENE_RESULTS_S3_*` | the stack's s3rver, matching `--results-s3-endpoint/--results-s3-bucket` |

(Our backend's non-prod safety gate must allow loopback first: catalog item G-X1.)

```bash
npx mockingbird-genebygene serve --port 8788 \
  --webhook-url http://127.0.0.1:3000/webhooks/gene-by-gene --webhook-secret "$GXG_KV_SECRET" \
  --results-s3-endpoint http://127.0.0.1:4569 --results-s3-bucket geviti-gxg-results-dev
```

```ts
import { createRuntime } from "@crvouga/mockingbird-service-genebygene"

const gxg = createRuntime({ webhooks: { url: "http://127.0.0.1:3000/webhooks/gene-by-gene", secret: "kv-secret" } })
const call = (path: string, init: RequestInit = {}) => gxg.fetch(new Request(`http://gxg.test${path}`, init))

const { access_token } = (await (
  await call("/connect/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: "id", client_secret: "s" }),
  })
).json()) as { access_token: string }
// …the app places POST /api/v2/orders with Authorization: Bearer <access_token>; the response's
// orderLines[].kitNumbers carry the new kit (Order.Created + KitNumbersGenerated are sent)…

const admin = (path: string, body: unknown) =>
  call(`/__admin${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
await admin("/orders/<orderId>/ship", {}) // tracking numbers + Order.Shipped
await admin("/kits/WB3K9Q2X/transition", { to: "Received" }) // Kit.Received
await admin("/kits/WB3K9Q2X/transition", { to: "Completed", fixture: "pgx" }) // results + Kit.Completed
await admin("/kits/WB7ABCDE/transition", { to: "Error", errorCode: 19 }) // Kit.Error (new collection)
```

### Routes (vendor)

| Route | Behaviour |
| --- | --- |
| `POST /connect/token` | Form `grant_type=client_credentials, client_id, client_secret` → `{access_token, expires_in: 3600, token_type: "Bearer"}`. Blocked clients (`PUT /__admin/settings {blockedClients}`) get 400 `{"error":"invalid_client"}`, 401 or 403; a mismatch against pinned `clients` is 400 `invalid_client`. |
| `GET /api/v2/products[?productId\|productCode\|productType]` | The recorded staging catalog (3 bundles with components), byte for byte. `productId` also finds component products; unknown → 404. |
| `POST /api/v2/fulfillments/actions/getShippingOptions` | `{shippingAddress, quantity, productId}` → `{dutiesAndTaxesIncluded, errorMessages, shippingOptions[{courierName, courierServiceCode, courierServiceDisplayName, estimatedShipDate, estimatedPrice, estimatedDeliveryDate, attributes}]}`. Address problems (missing fields, `addressLine1` > 35 chars, non-US) come back as `errorMessages`; a product with nothing to ship is 400 "… is not valid for shipping options". |
| `POST /api/v2/orders` | Shipped form `{items:[{productId, placerOrderNumber, shipments:[{quantity, address, courierServiceCode, referenceId}]}], notes}` or quantity-only `{items:[{productId, placerOrderNumber, quantity}]}`. Bundles expand into one order line per component; the kit-material line carries a fulfillment (outbound shipment + return label) per shipment; every line carries the kit numbers (`WB` + 6). Address > 35 chars → 400 "shipping address(es) not validated"; unknown courier → 400 "… not valid for shipping options". |
| `POST /api/v2/orders/actions/createOrderForExistingKits` | `{items:[{productId, kitNumbers, samples[{kitNumber, attributes}]}]}`: a lab order on existing kits (`Order.Created` with `OrderType: 3`); unknown kits → 400. |
| `GET /api/v2/orders[?orderId…&offset&pageSize]`, `/api/v2/orders/{id}` | `OrderDto{id, orderDate, orderLines[{id, productId, currentStatus, fulfillments, placerOrderNumber, kitNumbers, …}]}`; pages are `{offset, pageSize, totalCount, items}` (pageSize capped at 500). |
| `GET /api/v2/orderLines/{id}` | The order-line detail with `kitStatusSummary` and sibling lines. |
| `GET /api/v2/kits`, `/api/v2/kits/{kitNumber}`, `/api/v2/kitorderlines[?kitNumbers\|orderId\|attributeTerm…]`, `/api/v2/kitorderlines/kits` | `KitDto{kitNumber, gender, currentStatuses[{status, errors, errorMessage, orderLineId, orderId, fulfillment, results, history}], attributes}` and the kit-order-line rows (`currentStatus, currentErrorMessage, cancelCodeId, kitReceivedDate, kitEffectiveDate`). |
| `GET /api/v2/fulfillments[?orderId]`, `POST …/actions/updateShipmentAddress` | Shipments with `isReturnShipment, address, trackingNumber, reference1, courier: null, courierService: null`. An address edit is visible on the next GET; a shipped (tracked) shipment refuses. |
| `PATCH /api/v2/kits/{kitNumber}/attributes` | `{kitNumber, attributes:[{name, value}]}` (names case-insensitive; `firstname, lastname, dateofbirth, gender, race, ethnicity, email, phone`). Unknown name → 400; bad `dateofbirth` (not `YYYYMMDD`) or `gender` (not `M/F/Unknown`) → 422; returns every attribute. |
| `DELETE /api/v2/fulfillments/{id}`, `/api/v2/kits/{kit}/orderLines`, `/api/v2/orderLines/{id}` | The three cancel layers: 204; a shipped or already-canceled fulfillment, or a kit/line already with the lab, is 400 "… not in a cancellable status"; unknown or already-canceled kits/lines are 404. Canceling a kit sends `Kit.KitOrderLine.Canceled`. |
| `GET /api/v2/results[?kitNumber]`, `/api/v2/kits/{kit}/results`, `/api/v2/results/search` | `{resultPayload: "s3://<bucket>/<kit>.<json\|pdf\|csv>", resultType, resultDisplayName, resultDate, orderLineId, orderId, kitNumber, resultId}`. |
| `GET /api/v2/results/results/presignedUrl?resultId&kitNumber&resultType` | `{presignedUrl, resultId, kitNumber, resultType, expiresAt}`; the URL is `GET {mock}/__blob/<key>?X-Amz-…` and answers the bytes, or 403 `AccessDenied` (bad signature, expired on the mock clock, or the `presigned_access_denied` preset). |
| `GET /api/v2/attributes`, `/api/v2/eventTypes` | The attribute definitions and event types. |
| `GET/POST /api/v2/notificationSubscriptions`, `GET/PATCH/DELETE …/{id}` | `{id, endPoint, events, secret, active, …}`. `secret` is returned **only** by POST. Accepts `application/json-patch+json`. `Kit.KitOrderLine.Canceled` in `events` is 400 "Valid event type is required."; a second subscription for the same endpoint is 400. |

Every API route needs `Authorization: Bearer <token>`; a missing, expired, revoked
(`POST /__admin/tokens/revoke`) or blocked-client token is an empty 401 with
`WWW-Authenticate: Bearer error="invalid_token"`, so our client invalidates and retries once.
Handler errors are `ErrorDto{statusCode, message, payload, errorType}`; model-binding failures are
ASP.NET problem details with `errors`.

### Webhooks

Notifications go to every active subscription for its events, signed with that subscription's
secret, and to `--webhook-url` (all events) signed with `--webhook-secret`:

- `gxg-signature: sha512=<hex HMAC-SHA512(secret, rawBody)>`, `gxg-eventtype: <event>`,
  `gxg-notificationid: <uuid>`.
- Events: `GxG.Nucleus.Order.Created` (`OrderGuid`, `OrderType`, `OrderItems` — the real
  `OrderGuid` shape, which our receiver's `OrderId` extractor misses: kept on purpose),
  `.Order.KitNumbersGenerated`, `.Order.Shipped`, `.Kit.Received`, `.Kit.Completed` (one per
  result-bearing order line: JSON + PDF on the report line, CSV on the raw-data line),
  `.Kit.Error` (`ErrorCode` 4 "10 Day Delay", 19 "New collection requested"), and
  `.Kit.KitOrderLine.Canceled`. Bodies are PascalCase with the keys of the recorded samples
  (`GXG/docs/webhook-events.json`).
- Retries: immediately, 10 s, 1 min, 5 min (GxG retries up to three times).
  `GET /__admin/webhooks`, `…/events`, `POST …/flush`, `…/:id/replay` as usual.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `POST /__admin/kits/:kitNumber/transition` | `{to, errorCode?, errorMessage?, fixture?}`. `to`: `Not Received`, `Received` (Kit.Received), `In Lab`, `In QC Analysis`, `QC Analysis Complete`, `Results Completed` / `Completed` (writes results, then Kit.Completed), `Error` (Kit.Error, code default 4), `Canceled`. |
| `PUT /__admin/results/:kitNumber` | Stage what `Completed` publishes: `{fixture: "normal" \| "pgx" \| "ancestry"}` or a custom `{json?, csv?, pdfBase64?}`. |
| `POST /__admin/orders/:id/ship` | `{trackingNumber?, returnTrackingNumber?}`: tracking numbers, closeout date, lines `Shipped`/`Processing`, `Order.Shipped`. |
| `POST /__admin/orders/:id/kit-numbers` | Mint kit numbers for an order placed without them (`KitNumbersGenerated`). |
| `PUT /__admin/settings` | `{tokenTtlSeconds?, clients?, blockedClients?: {"<client_id>": "invalid_client" \| "unauthorized" \| "forbidden"}, generateKitNumbers?, presignedUrlTtlSeconds?, resultsBucket?}`. |
| `POST /__admin/tokens/revoke` | Every token issued so far answers 401. |
| `GET /__admin/orders`, `/__admin/kits` | The namespace's records. |

Result fixtures: `normal` is our consumer's own comprehensive-report fixture (synthetic "Jane
Doe", trimmed to one item per section); `pgx` and `ancestry` are synthetic reports in the same
schema. Every fixture also publishes the raw-data CSV and a one-page PDF.

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?, "latencyMs"?}`):
`invalid_client`, `token_unauthorized`, `token_forbidden`, `token_revoked`, `rate_limited`,
`shipping_empty_500`, `address_not_validated`, `slow_orders` (5 s on `POST /orders`),
`no_kit_numbers`, `cancel_conflict` (409), `presigned_access_denied`, `server_error`,
`webhook_duplicate`, `webhook_reorder`, `webhook_drop`.

### Namespaces

`x-mockingbird-namespace`, a `/ns/<name>` prefix on both `GENE_BY_GENE_API_URL` and the token
URL, or by client id: `PUT /__admin/credentials {"credentials": {"<client_id>": "<namespace>"}}`
(tokens carry the client id they were issued to). Kit numbers and result keys are salted per
namespace, so parallel workers never collide in the shared results bucket.

### Deliberately not modelled

- The 21 operations our consumer never calls (HL7 `ehr/*`, single-attribute edits, CSV/document
  uploads, `resetSecret`, bulk kit-order-line cancel, …): `supported: false` in `openapi.yaml`.
- Server-side subscription filters (GxG creates them on request), invoicing, insurance.
- Real carrier behaviour: shipping prices and tracking numbers are fixed-format synthetics.
- A live `corpus pull`: the catalog is the consumer's recorded `gxg-list-products-dev.json`;
  attribute definitions and event types are synthesised from the consumer's code (no recording
  exists), because no staging credentials are configured.
- Nothing moves on its own: every lab step is an admin transition.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `GeneByGeneAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `transition(kit, {to, errorCode?, fixture?})`, `ship(orderId)`, `generateKitNumbers(orderId)`, `setPendingResults(kit, source)`, `orders()`, `kits()`, `order(id)`, `kit(kit)`, `activeSubscriptions()`. Options: `sqlite`, `now`, `namespace`, `products`, `settings`, `onWebhook`, `resultsS3`, `publicNamespace`. |
| `createRuntime` | function | The mock with the full service contract. Options: `webhooks: {url?, secret?, events?, retryDelaysMs?, fetch?}`, `resultsS3: {endpoint, bucket, region?, accessKeyId?, secretAccessKey?}`, `products`, `settings`, `clock`, `seed`, `adminKey`, `onLog`. |
| `GENEBYGENE_PRESETS` | object | Every named fault preset. |
| `GENEBYGENE_NAMESPACE` | string | The service name, `"genebygene"`. |
| `tokenCredential` | function | The client id a bearer token was issued to (credential → namespace). |
| `KIT_STATUSES`, `MAX_ADDRESS_LINE` | values | The kit status ladder; the 35-character address-line limit. |
| `GXG_EVENTS`, `KIT_ERROR_MESSAGES` | values | Notification event names; the `Kit.Error` messages for codes 4 and 19. |
| `gxgSigner`, `signGxgWebhookBody` | functions | The GxG webhook signer and `sha512=<hex>` signature. |
| `STAGING_PRODUCTS`, `PRODUCT_CODES`, `CORPUS_VERSION`, `ATTRIBUTE_DEFINITIONS`, `EVENT_TYPES`, `SHIPPING_OPTIONS` | values | The corpus. |
| `RESULT_FIXTURES`, `NORMAL_REPORT`, `PGX_REPORT`, `ANCESTRY_REPORT`, `RAW_DATA_CSV`, `resultFiles`, `minimalPdf` | values | Result fixtures and the files a completed kit publishes. |
| `DEFAULT_SETTINGS`, `netIso` | values | Default per-namespace settings; .NET-style instant formatting. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target; port 8788. |

## Development

```bash
bun test                           # self-parity, acceptance through test/consumer.ts, contract, served-over-HTTP
bun scripts/vendor-openapi.ts      # re-vendor openapi.yaml from ~/geviti-monorepo, then bun run generate
bun run parity                     # live parity against GxG staging; exits 2 without
                                   # MOCKINGBIRD_GENEBYGENE_CLIENT_ID / _CLIENT_SECRET (env / .env.local)
```

Part of [mockingbird](https://github.com/crvouga/mockingbird).
