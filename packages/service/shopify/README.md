# @crvouga/mockingbird-service-shopify

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful emulator of the Shopify Admin GraphQL API for a backend that fulfils orders through
Shopify: it creates orders (directly or through draft orders), reads their fulfilment status and
tracking, looks up product variants, sets metafields and manages webhook subscriptions. Order and
fulfilment webhooks go to the store's own subscriptions, signed with `X-Shopify-Hmac-Sha256`.
Status: **wip**.

## Install

```bash
npm install -D @crvouga/mockingbird-service-shopify
```

ESM only. Node >= 22 or Bun >= 1.2. Serve with `npx mockingbird-shopify serve`, `createServer`
from `./server`, or mount `createRuntime()` in any Fetch-compatible process.

## Usage

Shopify's official [`@shopify/admin-api-client`](https://www.npmjs.com/package/@shopify/admin-api-client)
always calls `https://<storeDomain>`, so point its `customFetchApi` at the emulator. Any non-empty
`X-Shopify-Access-Token` authenticates unless `PUT /__admin/settings {"accessTokens": [...]}`
restricts it.

```ts
import { createAdminApiClient } from "@shopify/admin-api-client"
import { createServer } from "@crvouga/mockingbird-service-shopify/server"

const server = await createServer()
const storeDomain = "mockingbird-test.myshopify.com"

// The application's own client. Only the transport changes: requests to the store go to the
// emulator instead of Shopify.
const shopify = createAdminApiClient({
  storeDomain,
  apiVersion: "2026-10",
  accessToken: "shpat_test",
  customFetchApi: (url, init) => fetch(url.replace(`https://${storeDomain}`, server.url), init),
})

const { data } = await shopify.request(
  `mutation Create($order: OrderCreateOrderInput!) {
    orderCreate(order: $order) {
      order { id name displayFulfillmentStatus }
      userErrors { field message code }
    }
  }`,
  {
    variables: {
      order: {
        email: "buyer@example.test",
        lineItems: [{ variantId: "gid://shopify/ProductVariant/41000000001", quantity: 1 }],
      },
    },
  },
)
console.log(data.orderCreate.order)
// → {id: "gid://shopify/Order/5000000001", name: "#1001", displayFulfillmentStatus: "UNFULFILLED"}

// Test setup: mark the order shipped, as the warehouse would.
await fetch(`${server.url}/__admin/orders/5000000001/fulfill`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ trackingCompany: "UPS", trackingNumber: "1Z0000000000000001" }),
})

await server.close()
```

With plain `fetch`, call `POST ${server.url}/admin/api/2026-10/graphql.json` with
`X-Shopify-Access-Token` and a `{query, variables}` body.

### GraphQL surface

`POST /admin/api/{version}/graphql.json` executes any document that validates against the subset
schema (`SHOPIFY_SDL`, with Shopify's own type, field, enum and input names) using the reference
`graphql` implementation, so aliases, fragments, variables and validation errors behave like the
real API. `version` is a quarterly version (`2026-10`) or `unstable`.

| Field | Behaviour |
| --- | --- |
| `shop` | The store's name, `myshopifyDomain` and currency (settings). |
| `orderCreate(order, options)` | Line items reference a `variantId` (price from the variant unless `priceSet` overrides it) or are custom (`title` + `priceSet`). Stores email, phone, note, tags, currency, `financialStatus` (default `PAID`), shipping address and metafields; the order starts `UNFULFILLED`, named `#1001`, `#1002`, …. Problems come back as `userErrors { field message code }` (`["order", "lineItems", "0", "variantId"]` / `NOT_FOUND`, an empty or non-positive line `BLANK`/`INVALID`) and nothing is stored. Announces `orders/create`. |
| `draftOrderCreate(input)` | An `OPEN` draft (`#D1`, …) with variant or custom (`originalUnitPrice`) lines and metafields. |
| `draftOrderComplete(id, paymentPending, sourceName)` | Turns the draft into an order (`PAID`, or `PENDING` with `paymentPending: true`), sets `status: COMPLETED` and `order`. Completing twice, or an unknown draft, is a `userError`. |
| `order(id)` / `draftOrder(id)` | `displayFulfillmentStatus`, `displayFinancialStatus`, `cancelledAt`, `cancelReason`, prices (`totalPriceSet`), `lineItems`, `fulfillments { status displayStatus trackingInfo { company number url } }`, `shippingAddress`, `metafield(namespace, key)` and `metafields`. A malformed gid is a GraphQL error (`Invalid global id`); an unknown one is `null`. |
| `productVariants(first/last, after/before, query, reverse)` / `productVariant(id)` | The seeded catalogue. `query` takes `sku:`, `product_id:`, `title:`, `barcode:`, `id:` and free text; another search field is an explicit `MOCKINGBIRD_UNSUPPORTED` GraphQL error. |
| `metafieldsSet(metafields)` | Upserts by owner + namespace + key on orders, draft orders, products and variants. At most 25 per call. Validates `single_line_text_field`, `multi_line_text_field`, `number_integer`, `number_decimal`, `boolean`, `date`, `date_time`, `url` and `json` values; any error (with `elementIndex`) rejects the whole call. A missing namespace is the app-reserved `app--<appId>`. |
| `webhookSubscriptionCreate(topic, webhookSubscription)` / `webhookSubscriptionDelete(id)` / `webhookSubscriptions(…)` / `webhookSubscription(id)` | Topics `ORDERS_CREATE`, `ORDERS_FULFILLED`, `ORDERS_CANCELLED`, `FULFILLMENTS_CREATE`, `FULFILLMENTS_UPDATE`. `callbackUrl` (or `uri`) must be an http(s) URL; the same topic and address twice answers `Address for this topic has already been taken`. `includeFields` trims the delivered body. Filters `topics` and `callbackUrl`. |

Connections require `first` or `last` (at most 250) and page with opaque cursors. Every response
carries `extensions.cost` (`requestedQueryCost`, `actualQueryCost`, `throttleStatus`).

A missing or unknown token answers HTTP 401
`{"errors": "[API] Invalid API key or access token (unrecognized login or wrong password)"}`; a
body without `query` answers 400 `{"errors": {"query": "Required parameter missing or invalid"}}`.

Seed fixtures: products `gid://shopify/Product/7000000001` (Mockingbird Tee; variants
`…/ProductVariant/41000000001` `MB-TEE-S` and `…/41000000002` `MB-TEE-M`, 25.00) and
`…/Product/7000000002` (Mockingbird Mug; variant `…/41000000003` `MB-MUG`, 12.50).

### Webhooks

Webhooks are delivered to the subscriptions the application creates with
`webhookSubscriptionCreate`, as Shopify's REST JSON (`snake_case` order or fulfilment bodies with
`admin_graphql_api_id`). Each delivery carries `X-Shopify-Topic`, `X-Shopify-Hmac-Sha256` (base64
HMAC-SHA256 of the raw body under the app's client secret, setting `apiSecret`, default
`mockingbird_shopify_api_secret`), `X-Shopify-Shop-Domain`, `X-Shopify-API-Version` (the version
the subscription was created with), `X-Shopify-Webhook-Id`, `X-Shopify-Event-Id` and
`X-Shopify-Triggered-At`.

| Topic | When |
| --- | --- |
| `orders/create` | `orderCreate`, `draftOrderComplete` |
| `fulfillments/create`, then `orders/fulfilled` | `POST /__admin/orders/:id/fulfill` |
| `fulfillments/update` | `POST /__admin/fulfillments/:id/update` |
| `orders/cancelled` | `POST /__admin/orders/:id/cancel` |

An endpoint added with `PUT /__admin/webhook-endpoints` also receives a copy of each delivery.
`GET /__admin/webhooks/events`, replay, flush and the delivery-fault presets work as for every
emulator.

### Admin controls

| Route | Effect |
| --- | --- |
| `POST /__admin/orders/:id/fulfill` `{trackingCompany?, trackingNumber?, trackingUrl?}` | Fulfils every line (`displayFulfillmentStatus: FULFILLED`), records a `SUCCESS` fulfilment with its tracking. `:id` is the numeric id or the URL-encoded gid. 409 when cancelled or already fulfilled. |
| `POST /__admin/fulfillments/:id/update` `{displayStatus?, trackingCompany?, trackingNumber?, trackingUrl?}` | Moves the shipment (`IN_TRANSIT`, `OUT_FOR_DELIVERY`, `DELIVERED`, …) or replaces its tracking. |
| `POST /__admin/orders/:id/cancel` `{reason?}` | Cancels an unfulfilled order (`CUSTOMER`, `DECLINED`, `FRAUD`, `INVENTORY`, `STAFF`, `OTHER`; default `OTHER`). |
| `GET /__admin/orders/:id` | The order as its webhook body renders it. |
| `POST /__admin/fail-next-mutation` `{"kind": "userErrors", message?, field?, code?}` or `{"kind": "throttled"}` | The next mutation document (queries are unaffected) answers that `userError` on every mutation field, or the `THROTTLED` error, without changing state. |
| `GET/PUT /__admin/settings` | `accessTokens`, `apiSecret`, `shopName`, `shopDomain`, `currency`, `appId`. |

Presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`): `throttled` (HTTP 200,
`errors[{message: "Throttled", extensions: {code: "THROTTLED"}}]`, `actualQueryCost: null`),
`invalid_access_token` (401), `server_error` (500), `webhook_duplicate`, `webhook_reorder` and
`webhook_drop`, plus the standard ones.

Namespaces use `x-mockingbird-namespace`, `/__admin/ns/<name>/admin/api/…`, or the access token
through `PUT /__admin/credentials {"credentials": {"<token>": "<namespace>"}}`.

## API

The main entry exports `ShopifyAPI`, `ShopifyState`, `createRuntime`, `SHOPIFY_NAMESPACE`,
`SHOPIFY_PRESETS`, `SHOPIFY_SDL`, `shopifySchema`, `DEFAULT_SETTINGS`, `ACCESS_TOKEN_HEADER`,
`THROTTLE_STATUS`, `accessTokenOf`, `shopifyTimestamp`, `signWebhook`, `gid`, `parseGid`,
`restOrder`, `restFulfillment`, `restTopic`, the generated `document`, `operationIds` and
`supportedOperationIds`, and the record, settings and option types.
`@crvouga/mockingbird-service-shopify/server` exports `createServer`, `serveTarget`,
`DEFAULT_PORT`, and the server option/result types.

## Deliberately not modelled

- Every behaviour above is a **best guess from Shopify's Admin GraphQL documentation, not
  oracle-verified** against a development store: the exact `userErrors` messages and codes, the
  default `financialStatus` of `orderCreate`, and the query cost numbers in particular.
- Query cost calculation and the leaky bucket: the cost is 1 per query field and 10 per mutation
  field, and the bucket is never drained; use the `throttled` preset or
  `POST /__admin/fail-next-mutation` to exercise throttling.
- Payments, transactions, refunds, inventory reservation, taxes, discounts, shipping lines,
  customers, and fulfilment orders or fulfilment services; fulfilments are created only through
  the admin control, never by a mutation.
- Webhook topics other than the five above, XML webhooks (an explicit `MOCKINGBIRD_UNSUPPORTED`
  error), Pub/Sub and EventBridge endpoints, and HMAC verification of the app's own OAuth flow.
  Shopify requires `https` callback addresses; the emulator also accepts `http` so a local
  receiver works.
- The REST Admin API, the Storefront API, bulk operations and GraphQL subscriptions.
- Metafield definitions, `compareDigest`, and list or reference metafield types.
