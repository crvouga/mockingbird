# @crvouga/mockingbird-service-genebygene

Stateful mock of **Gene by Gene's Nucleus API v2** (and its OAuth auth host) for test suites:
client-credentials tokens with the credential-blocking failures, both recorded product catalogs,
zone-priced shipping quotes, the production split between a quote that succeeds and a place that
answers `Address Not Found`, order placement (shipped and quantity-only, plus orders for existing
kits), order lines, fulfillments and address edits, kits and their demographics attributes, the
three-layer cancel, results with presigned downloads, notification subscriptions, and GxG-signed
notifications. Kits move along the lab's status ladder only when a test says so (or when the
happy-path scenario runs on the mock clock), so genomics suites that serialised on one staging
slot with 15 s sleeps and 300 s waits resolve in milliseconds.

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
- Status: **ready**. Live parity (`bun run parity`, or `bun run parity:remote -- genebygene`) passes
  against `staging-api.genebygene.com`: the catalog, the 35-address corpus
  (`corpus/address-parity.json`), the recorded error shapes and query validation
  (`corpus/live-errors.json`), the recorded catalogs (`src/corpus/live-catalogs.json`), and 25
  random walks over the safe operations. The acceptance suite replays those recordings, so CI
  holds the mock to them without credentials.

## Install

```bash
npm install -D @crvouga/mockingbird-service-genebygene
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-genebygene serve` (default port 8788), `createServer` from `./server` (Node), or
`createRuntime` with any Fetch server.

## Usage

The mock serves the API **and** the auth host on one port. Point the app at it; nothing else
changes:

| App env | Value |
| --- | --- |
| `GENE_BY_GENE_API_URL` (alias `GENE_BY_GENE_API_BASE_URL`) | `http://127.0.0.1:8788` (or `…/ns/<namespace>`) |
| `GENE_BY_GENE_API_ACCESS_TOKEN_URL` | `http://127.0.0.1:8788/connect/token` (or `…/ns/<namespace>/connect/token`) |
| `GENE_BY_GENE_API_KEY` / `GENE_BY_GENE_API_CLIENT_SECRET` | anything, unless `--client-id/--client-secret` pin a pair |
| `GENE_BY_GENE_RESULTS_S3_*` | the stack's s3rver, matching `--results-s3-endpoint/--results-s3-bucket` |

(Our backend's non-prod safety gate must allow loopback first: catalog item G-X1.)

```bash
npx mockingbird-genebygene serve --port 8788 \
  --webhook-url http://127.0.0.1:3000/webhooks/gene-by-gene --webhook-secret "$GXG_KV_SECRET" \
  --results-s3-endpoint http://127.0.0.1:4569 --results-s3-bucket acme-gxg-results-dev
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
// …the app quotes, then places POST /api/v2/orders with Authorization: Bearer <access_token>;
// orderLines[].kitNumbers carry the new kit (Order.Created + KitNumbersGenerated are sent)…

const admin = (path: string, body: unknown, method = "POST") =>
  call(`/__admin${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
await admin("/settings", { catalog: "production", kitAssociation: "deferred" }, "PUT")
await admin("/addresses/classify", { addressLine1: "501 N 5th St", city: "Phoenix", stateOrRegion: "AZ", postalCode: "85004", countryCode: "US", recipientName: "T", phone: "+15555550100" })
// → {quote: "options", place: "address-not-found", zone: 5, codes: [...], prices: {...}}
await admin("/scenario/happy-path", { orderId: "<orderId>" }) // associate → ship → … → Results Completed
await admin("/kits/WB3K9Q2X/transition", { to: "Error", errorCode: 19 }) // Kit.Error (new collection)
```

### Routes (vendor)

| Route | Behaviour |
| --- | --- |
| `POST /connect/token` | Form `grant_type=client_credentials, client_id, client_secret` → `{access_token, expires_in: 3600, token_type: "Bearer"}`. Blocked clients (`PUT /__admin/settings {blockedClients}`) get 400 `{"error":"invalid_client"}`, 401 or 403; a mismatch against pinned `clients` is 400 `invalid_client`. |
| `GET /api/v2/products[?productId\|productCode\|productType]` | The recorded catalog `settings.catalog` selects, byte for byte (`preassembly`, null `shippingQualified`, nested `components`). A GUID `productId` lists the product with that id or the bundles that contain it as a component (unknown → `[]`; a non-GUID is ignored); `productType` is a case-insensitive substring of the listed product's type. |
| `POST /api/v2/fulfillments/actions/getShippingOptions` | `{shippingAddress, quantity, productId}` → `{dutiesAndTaxesIncluded, errorMessages, shippingOptions[…]}`: the destination's menu, a 400 problem-details refusal, HTTP **200** `errorMessages`, or the carrier's 500 (see [Shipping and addresses](#shipping-and-addresses)). Nothing to ship or an unknown id → 400 "This product Id is not valid for shipping options."; a staging-only id against the production catalog → empty 500. |
| `POST /api/v2/orders` | Shipped form `{items:[{productId, placerOrderNumber, shipments:[{quantity, address, courierServiceCode, referenceId}]}], notes}` runs the place-time USPS check; quantity-only `{items:[{productId, placerOrderNumber, quantity}]}` skips it and never creates a fulfillment. Bundles expand into one order line per component (same `placerOrderNumber`, `bundleProductId`); the kit-material line carries one fulfillment (`Ordered`) with an outbound shipment and a return label, `courier`/`courierService`/`trackingNumber` null until ship; every line carries the kit number (`WB` + 6). `placerOrderNumber` is never deduped. |
| `POST /api/v2/orders/actions/createOrderForExistingKits` | `{items:[{productId, kitNumbers, samples[{kitNumber, attributes}]}]}`: a lab order on existing kits (`Order.Created` with `OrderType: 3`, no new kit, no `KitNumbersGenerated`); unknown kits → 400. |
| `GET /api/v2/orders[?orderId…&offset&pageSize]`, `/api/v2/orders/{id}` | `OrderDto{id, orderDate, orderLines[…]}`; pages are `{offset, pageSize, totalCount, items}` (pageSize defaults to 100 and is echoed from 1 to 100000; an offset past the end is an empty page with the true total). A non-GUID `{id}` is a 400. |
| `GET /api/v2/orderLines/{id}` | The order-line detail with `kitStatusSummary` and sibling lines. |
| `GET /api/v2/kits`, `/api/v2/kits/{kitNumber}`, `/api/v2/kitorderlines[?kitNumbers\|orderId\|attributeTerm…]`, `/api/v2/kitorderlines/kits` | `KitDto{kitNumber, gender, currentStatuses[{status, errors, errorMessage, orderLineId, orderId, fulfillment, results, history}], attributes}` and the kit-order-line rows (`currentStatus, currentErrorMessage, cancelCodeId, kitReceivedDate, kitEffectiveDate`). |
| `GET /api/v2/fulfillments[?orderId]`, `POST …/actions/updateShipmentAddress` | Shipments with `isReturnShipment, address, trackingNumber, reference1, courier: null, courierService: null`. The edit replaces the address (no merge), re-runs the place check, echoes the command, and is visible on the next GET; an instruction-only edit always goes through; after tracking (or once `Shipped`/`Canceled`/`Error`) it is 400 "The shipment address can not be updated". |
| `PATCH /api/v2/kits/{kitNumber}/attributes` | `{kitNumber, attributes:[{name, value}]}` (names matched case-insensitively against the recorded attribute catalog, stored lowercase: our consumer sends `firstname, lastname, dateofbirth, gender, race, ethnicity`). Unknown name → 400; bad `dateofbirth` (not `YYYYMMDD`) or `gender` (not `M/F/Unknown`) → 422; returns every attribute. |
| `DELETE /api/v2/fulfillments/{id}`, `/api/v2/kits/{kit}/orderLines`, `/api/v2/orderLines/{id}` | The three cancel layers: 204; a shipped or already-canceled fulfillment, or a kit/line already with the lab, is 400 "… not in a cancellable status"; unknown or already-canceled kits/lines are 404 `Resource not found.` (`Kit <kit> not found` for a kit). Canceling a fulfillment or a kit sends `Kit.KitOrderLine.Canceled`. |
| `GET /api/v2/results[?kitNumber]`, `/api/v2/kits/{kit}/results`, `/api/v2/results/search` | An unknown `kitNumber` filter is an empty page. `{resultPayload: "s3://<bucket>/<namespace>/<kit>.<json\|csv\|pdf>", resultType, resultDisplayName, resultDate, orderLineId, orderId, kitNumber, resultId}`. |
| `GET /api/v2/results/results/presignedUrl?resultId&kitNumber&resultType` | Needs a `resultId`, or a `kitNumber` with a `resultType` (400 `'Result Id' must not be empty.` …); none matching is 404 "There is no report assoicated with that result" (staging's spelling). `{presignedUrl, resultId, kitNumber, resultType, expiresAt}`; the URL is `GET {mock}/__blob/<key>?X-Amz-…` and answers the bytes, or 403 `AccessDenied` (bad signature, expired on the mock clock, or the `presigned_access_denied` preset). |
| `GET /api/v2/attributes[?entityType]`, `/api/v2/eventTypes[?name]` | The recorded live catalogs (`src/corpus/live-catalogs.json`): 240 attribute definitions and 12 event types `{name, payloadStructure, subscriptionTypes}`. A blank `name` lists them all. |
| `GET/POST /api/v2/notificationSubscriptions`, `GET/PATCH/DELETE …/{id}` | `{id, endPoint, events, secret, active, …}`. `secret` is returned **only** by POST. Accepts `application/json-patch+json`. `Kit.KitOrderLine.Canceled` (or any name the event-type list lacks) in `events` is 400 "Valid event type is required."; a second subscription for the same endpoint is 400; an unknown id is 404 `Invalid Id <id>` (the empty GUID: 400 `Valid Notification Subscription Id required.`) |

Every API route needs `Authorization: Bearer <token>`; a missing, expired (on the mock clock),
revoked (`POST /__admin/tokens/revoke`) or blocked-client token is an empty 401 with
`WWW-Authenticate: Bearer error="invalid_token"`, so our client invalidates and retries once.
Handler errors are `ErrorDto{statusCode, message, payload: {}, errorType: "ValidationError"}`; a
missing resource is `ErrorDto{statusCode: 404, message: "Resource not found.", payload: null,
errorType: null}`. Query and body validation is ASP.NET problem details with `errors`, binding and
validator messages together, as staging words them (`The value 'a' is not valid for Offset.`,
`'Page Size' must be between 1 and 100000. You entered 0.`, `'Offset' must be greater than or
equal to '0'.`, `'Status' has a range of values which does not include 'a'.`). `status`,
`productType` and `entityType` filters are enums (case and spaces ignored, digits refused).
`/api/v2/kitorderlines` answers an empty 500 for a `productType` or `attributesFilter` it cannot
parse, but only when rows remain to filter.

### Shipping and addresses

Two checks exist, and they do not agree — on purpose, because production does not. The quote is
what live parity recorded against staging (`corpus/address-parity.json`, 35 synthetic addresses,
replayed by the acceptance suite); where issue #122 listed different rules, the recording won.

1. **Quote** (`getShippingOptions`, `quoteVerdict`), in the order staging decides:
   - **Request validation**, HTTP 400 problem details keyed `shippingAddress.<Field>`: recipient,
     line1, city and state must not be empty (`'Shipping Address City' must not be empty.`);
     state and country must be exactly 2 characters (`'Shipping Address Country Code' must be 2
     characters in length. You entered 3 characters.`; a blank state fails both rules); a
     non-empty postal code needs 5 characters. Phone is not checked.
   - **Address rules**, HTTP 200 with `shippingOptions: []`: any of lines 1–3 over 35 UTF-16
     code units → `Address Lines cannot be longer than 35 characters.` (once); a US state that
     is not a state, DC or a territory (AE, ZZ) → `Invalid state or region for US domestic
     address.`
   - **The carrier's refusal**, HTTP 500 `ErrorDto` (null payload and type): a US postal code
     that is not `NNNNN` / `NNNNN-NNNN` → `Code: DESTINATION.POSTALCODE.MISSING.ORINVALID,…`; a
     state the ZIP3 → state table disagrees with (Beverly Hills `90210` in `TX`) →
     `Code: CRSVZIP.CODE.INVALID,Message: edEx service is not currently available…` (staging's
     typo kept).
   - **The menu**: DHL Expedited only for `PO Box` / `P.O. Box` (a spelled-out `Post Office Box`
     quotes like a street) and for territories (PR, VI, GU, AS, MP, ZIP3 006–009, 969); the FedEx
     international menu outside the US (`FEDEX_INTERNATIONAL_PRIORITY`, `…_CONNECT_PLUS`,
     `…_ECONOMY`); otherwise the zone's menu. A quote that passes returns its menu **even when
     place will say Address Not Found**.
2. **Place** (`POST /orders` with `shipments`, and `updateShipmentAddress`): what the quote would
   refuse, then USPS deliverability. Failures are 400 `ErrorDto` with `message` exactly
   `Shipping address(es) not validated: <addressLine1 as sent> : <reason>`, where the reason is
   the quote's first message or `Address Not Found`. Address Not Found when the quote's carrier
   refused the address, the ZIP3 is in `UNDELIVERABLE_ZIP3` (`000`, `590`), or line1 is a
   `quote-ok-place-not-found` corpus row. Live parity recorded the Address Not Found answer for
   `501 N 5th St`; the other place answers follow from the quote (placing is unsafe live). A
   courier code outside the address's menu (other than `DHL_DOMESTIC_RETURN`, the bundle's return
   leg, always accepted) is 400 "… not valid for shipping options".

Zones (from Houston, ZIP3 770) and deterministic prices:

| ZIP3 | Zone | Menu |
| --- | --- | --- |
| 770–778 | 2 | all four |
| 750–769, 779–799 | 3 | all four |
| 730–749 | 6 | all four (73938 is the recorded anchor: 6, 62.23, 14.91, 14.91) |
| 800–847, 850–865 | 5 | all four |
| 900–961, 100–149, 980–994 | 7 | all four |
| 967–968 (HI), 995–999 (AK) | 8 | all but Express Saver (as staging quotes Honolulu and Anchorage) |
| 006–009, 969 (territories) | 8 | DHL Expedited only |
| outside the US | 9 | the FedEx international menu (synthetic prices) |
| any other | 4 | all four |

The four domestic codes, in staging's order, are `DHL_PARCEL_EXPEDITED` (6),
`FEDEX_PRIORITY_OVERNIGHT` (62.23), `FEDEX_2_DAY_ONE_RATE` (14.91) and
`FEDEX_EXPRESS_SAVER_ONE_RATE` (14.91), each
`round(anchor × factor(zone), 2)` with factors 0.72, 0.80, 0.88, 0.94, 1.00, 1.12, 1.35 for zones
2–8, plus 0.50 on DHL for residential addresses (except the anchor ZIP). `estimatedShipDate` is
the next business morning, 08:00 America/Chicago; `estimatedDeliveryDate` adds the service's
business days (DHL `2 + ceil(zone / 2)`, Express Saver 3, 2Day 2, Overnight 1; zone 8 +2) at
17:00. `dutiesAndTaxesIncluded` is true on every US success; `attributes` values are strings.

The committed corpus (synthetic streets, no real person): `quote-ok-place-not-found` —
`1 Unlisted County Road 9`, Nowhere, MT 59001; `501 N 5th St`, Phoenix, AZ 85004;
`4440 County Road 000`, Valles Mines, MO 63087. `quote-ok-place-ok` — `1600 Amphitheatre Pkwy`,
Mountain View, CA 94043; `1445 N Loop W`, Houston, TX 77008; `350 Fifth Avenue`, New York, NY
10118; `1 Infinite Loop`, Cupertino, CA 95014. `PUT /__admin/addresses/corpus` adds rows for one
namespace.

Tracking numbers minted by `POST /__admin/orders/:id/ship` are a pure function of the shipment
id: DHL eCommerce `420` + destination ZIP5 + 26 digits (34 in all, the recorded production
length; return labels use the lab's `77008`), and 12 digits for a `FEDEX_*` outbound. The admin
call's `trackingNumber` / `returnTrackingNumber` override them.

### Catalogs and kit association

`PUT /__admin/settings {"catalog": …}` picks what `GET /api/v2/products` answers: `production`
(the recorded production catalog: the deluxe bundle `789af544-…` our consumer places, with its
kit component `b1949749-…` `shippingQualified: true, preassembly: true`), `staging` (the recorded
staging catalog), or `both` (default: production rows, then the staging rows production lacks).
`{"kitAssociation": "deferred"}` withholds a shipped place's kit numbers until
`POST /__admin/orders/:id/kit-numbers` (the production shape: the shipping desk associates a kit
within a business day or so); `immediate` (default) mints them in the create response.
Quantity-only places always get theirs immediately.

### Webhooks

Notifications go to every active subscription for its events, signed with that subscription's
secret, and to `--webhook-url` (all events) signed with `--webhook-secret`:

- `gxg-signature: sha512=<hex HMAC-SHA512(secret, rawBody)>`, `gxg-eventtype: <event>`,
  `gxg-notificationid: <uuid>`.
- Events: `GxG.Nucleus.Order.Created` (`OrderGuid`, `OrderType`, `OrderItems` — the real
  `OrderGuid` shape, which our receiver's `OrderId` extractor misses: kept on purpose),
  `.Order.KitNumbersGenerated`, `.Order.Shipped` (`CloseoutDate` as `M/D/YYYY` in Houston time),
  `.Kit.Received`, `.Kit.Completed` (one per result-bearing order line: the JSON report line and
  the raw-data line), `.Kit.Error` (`ErrorCode` 4 "10 Day Delay", 19 "New collection
  requested"), and `.Kit.KitOrderLine.Canceled`. Bodies are PascalCase with the keys of the
  recorded samples (`GXG/docs/webhook-events.json`).
- Retries: immediately, 10 s, 1 min, 5 min (GxG retries up to three times).
  `GET /__admin/webhooks`, `…/events`, `POST …/flush`, `…/:id/replay` as usual.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `POST /__admin/kits/:kitNumber/transition` | `{to, errorCode?, errorMessage?, fixture?, pdf?}`. `to`: `Not Received`, `Received` (Kit.Received), `In Lab`, `In QC Analysis`, `QC Analysis Complete`, `Results Completed` / `Completed` (writes the JSON report and raw-data CSV, plus a one-page PDF when `pdf: true`, then Kit.Completed), `Error` (Kit.Error, code default 4), `Canceled`. |
| `PUT /__admin/results/:kitNumber` | Stage what `Completed` publishes: `{fixture: "normal" \| "pgx" \| "ancestry"}` or a custom `{json?, csv?, pdfBase64?}`. |
| `POST /__admin/orders/:id/ship` | `{trackingNumber?, returnTrackingNumber?}`: tracking numbers, closeout date, fulfillment `Shipped`, kit-material line `Shipped`, `Order.Shipped`. |
| `POST /__admin/orders/:id/kit-numbers` | Associate kit numbers for an order placed without them (`KitNumbersGenerated`). |
| `POST /__admin/scenario/happy-path` | `{orderId, stepDelayMs?}`: associate (if deferred) → ship → `Received` → `In Lab` → `In QC Analysis` → `QC Analysis Complete` → `Results Completed`, with each step's webhooks. Step `i` runs once the mock clock reaches start + `i × stepDelayMs` (default 0: all now); later steps run on the next request after the clock passes them. The only automatic motion. |
| `POST /__admin/addresses/classify` | An `AddressDto` (or `{address, productId?, courierServiceCode?}`) → `{quote: "options" \| "validation" \| "errorMessages" \| "carrier" \| "http400" \| "http500", place: "ok" \| "address-not-found" \| "structural" \| "bad-courier", zone, codes, prices}`, without creating anything. |
| `PUT /__admin/addresses/corpus`, `GET …` | Append a synthetic `{kind: "quote-ok-place-not-found" \| "quote-ok-place-ok", addressLine1, city, stateOrRegion, postalCode}` row for this namespace. |
| `PUT /__admin/settings` | `{catalog?, kitAssociation?, tokenTtlSeconds?, clients?, blockedClients?: {"<client_id>": "invalid_client" \| "unauthorized" \| "forbidden"}, generateKitNumbers?, presignedUrlTtlSeconds?, resultsBucket?}`. |
| `POST /__admin/tokens/revoke` | Every token issued so far answers 401. |
| `GET /__admin/orders`, `/__admin/kits` | The namespace's records. |

Result fixtures: `normal` is our consumer's own comprehensive-report fixture (synthetic "Jane
Doe", trimmed to one item per section); `pgx` and `ancestry` are synthetic reports in the same
schema. Every fixture publishes the JSON report (`nutrigenomics_comprehensive_report_json`) and
the raw-data CSV (`nt_custom_agena_panel_data`, columns `RSID,CHROMOSOME,POSITION,RESULT`).

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?, "latencyMs"?}`):
`invalid_client`, `token_unauthorized`, `token_forbidden`, `token_revoked`, `rate_limited`
(429 `ErrorDto`), `shipping_empty_500`, `address_not_validated`, `address_not_found` (the next
shipped place answers Address Not Found even for a good street), `slow_orders` (5 s on
`POST /orders`), `no_kit_numbers`, `cancel_conflict` (409), `presigned_access_denied`,
`server_error`, `webhook_duplicate`, `webhook_reorder`, `webhook_drop`.

### Namespaces

`x-mockingbird-namespace`, a `/ns/<name>` prefix on both `GENE_BY_GENE_API_URL` and the token
URL, or by client id: `PUT /__admin/credentials {"credentials": {"<client_id>": "<namespace>"}}`
(tokens carry the client id they were issued to). Kit numbers and result keys are salted per
namespace, so parallel workers never collide in the shared results bucket.

### Deliberately not modelled

- The 21 operations our consumer never calls (HL7 `ehr/*`, single-attribute edits, CSV/document
  uploads, `resetSecret`, bulk kit-order-line cancel, …): `supported: false` in `openapi.yaml`.
- Server-side subscription filters (GxG creates them on request), invoicing, insurance.
- `productCode` and `productType` on `GET /api/v2/products`: staging matches them with SQL `LIKE`
  (`a` and `%` list every product code; `㏞` every type, under a collation that ignores it), and
  no response carries a code. The mock matches `productType` as a substring.
  `name` on `GET /api/v2/eventTypes` is the same kind of match (`ჷ` lists all 12); the mock
  matches a substring.
- The element shape of a non-empty `attributesFilter` array on `/api/v2/kitorderlines/kits`:
  staging answers anything that is not a JSON array with 400 "Invalid search filter value", and
  the one array shape recorded with an empty 500, which the mock returns for every non-empty
  array.
- No carrier, USPS (CASS), Google, FedEx or DHL call at runtime: the zone table, the ZIP3 → state
  table and the committed address corpus are the oracle. Live parity compares code sets and
  address classes, never prices or dates, which drift on the live host.
- Courier objects after ship: `courier` / `courierService` stay `null` (no recording shows
  their shipped shape).
- International prices and delivery dates: the codes and names are recorded, the prices are
  synthetic (live parity compares menus, never prices).
- Place-time answers other than Address Not Found are derived from the quote, not recorded:
  placing an order is unsafe against the live tenant.
- Nothing moves on its own except token and presigned-URL expiry (mock clock) and the
  happy-path scenario: every other lab step is an admin transition.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `GeneByGeneAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `quote(productId, address)`, `classify({address, productId?, courierServiceCode?})`, `transition(kit, {to, errorCode?, fixture?, pdf?})`, `ship(orderId)`, `generateKitNumbers(orderId)`, `startHappyPath(orderId, stepDelayMs?)`, `runDueScenarios()`, `setPendingResults(kit, source)`, `orders()`, `kits()`, `order(id)`, `kit(kit)`, `activeSubscriptions()`. Options: `sqlite`, `now`, `namespace`, `products`, `settings`, `onWebhook`, `resultsS3`, `publicNamespace`. |
| `createRuntime` | function | The mock with the full service contract. Options: `webhooks: {url?, secret?, events?, retryDelaysMs?, fetch?}`, `resultsS3: {endpoint, bucket, region?, accessKeyId?, secretAccessKey?}`, `products`, `settings`, `clock`, `seed`, `adminKey`, `onLog`. |
| `GENEBYGENE_PRESETS` | object | Every named fault preset. |
| `GENEBYGENE_NAMESPACE` | string | The service name, `"genebygene"`. |
| `tokenCredential` | function | The client id a bearer token was issued to (credential → namespace). |
| `KIT_STATUSES`, `MAX_ADDRESS_LINE` | values | The kit status ladder; the 35-character address-line limit. |
| `GXG_EVENTS`, `KIT_ERROR_MESSAGES` | values | Notification event names; the `Kit.Error` messages for codes 4 and 19. |
| `gxgSigner`, `signGxgWebhookBody` | functions | The GxG webhook signer and `sha512=<hex>` signature. |
| `PRODUCTION_PRODUCTS`, `STAGING_PRODUCTS`, `catalogProducts`, `CATALOGS`, `DELUXE_BUNDLE_ID`, `PRODUCT_CODES`, `CORPUS_VERSION`, `ATTRIBUTE_DEFINITIONS`, `EVENT_TYPES` | values | The catalog corpus (`catalogProducts(catalog)` is what a `catalog` setting answers). |
| `COURIER_SERVICES`, `INTERNATIONAL_SERVICES`, `RETURN_COURIER`, `ZONE_FACTORS`, `zoneFor`, `menuFor`, `priceFor`, `quoteMenu`, `stateForZip3` | values / functions | The courier menus, zone table and deterministic pricing. |
| `quoteVerdict`, `addressValidationErrors`, `placeCheck`, `ADDRESS_CORPUS`, `QUOTE_OK_PLACE_NOT_FOUND`, `QUOTE_OK_PLACE_OK`, `UNDELIVERABLE_ZIP3`, `trackingNumberFor` | values / functions | The two address checks, the committed address corpus, and tracking-number minting. |
| `RESULT_FIXTURES`, `NORMAL_REPORT`, `PGX_REPORT`, `ANCESTRY_REPORT`, `RAW_DATA_CSV`, `resultFiles`, `minimalPdf` | values | Result fixtures and the files a completed kit publishes. |
| `DEFAULT_SETTINGS`, `netIso` | values | Default per-namespace settings; .NET-style instant formatting. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target; port 8788. |

## Development

```bash
bun test                           # self-parity (incl. the address walk), acceptance B1–B52 through
                                   # test/consumer.ts, contract, served-over-HTTP
bun scripts/vendor-openapi.ts <gxg-openapi.json>  # re-vendor openapi.yaml, then bun run generate
bun run parity                     # live parity against GxG staging; exits 2 without
                                   # MOCKINGBIRD_GENEBYGENE_CLIENT_ID / _CLIENT_SECRET (env / .env.local);
                                   # compares and records corpus/address-parity.json, corpus/live-errors.json
                                   # and src/corpus/live-catalogs.json; MOCKINGBIRD_GENEBYGENE_UNSAFE=1
                                   # also places (and cancels) one real order on demo/staging
bun run parity:remote -- genebygene  # the same on GitHub Actions with the repo's secrets; download the
                                   # recordings with gh run download <run-id> -n parity-corpus
```

Part of [mockingbird](https://github.com/crvouga/mockingbird).
