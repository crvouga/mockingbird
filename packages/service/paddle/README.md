# @crvouga/mockingbird-service-paddle

Stateful mock of the **Paddle Billing** API for test suites. Customers, addresses, businesses,
products and prices behave as Paddle's do (validation, `invalid_field` errors, `include=`,
cursor pagination). Transactions carry **computed totals**. Subscriptions are created the way
Paddle creates them, when a transaction with recurring prices is paid, and the mock's admin
routes stand in for the hosted checkout and the billing engine: **pay a transaction, complete a
checkout in one call, run a renewal, fail a payment**. Every change produces the event Paddle
would emit, listed at `GET /events` and delivered as a `Paddle-Signature` webhook that the
official SDK's `paddle.webhooks.unmarshal` verifies.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/paddle/SUPPORT.md)
- `openapi.yaml` is hand-authored from Paddle's API reference and the wire types of
  `@paddle/paddle-node-sdk@3.10.0`.

## Install

```bash
npm install -D @crvouga/mockingbird-service-paddle
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-paddle serve`, `createServer` from `./server` (Node), or `createRuntime` with
any Fetch server.

## Usage

The SDK maps `environment` to a base URL and otherwise uses the value verbatim, so point it at
the mock by passing the mock's URL as the environment. Give the app the same `pdl_ntfset_…`
secret as `--webhook-secret`.

```bash
npx mockingbird-paddle serve --port 8795 --fixtures \
  --webhook-url http://127.0.0.1:3000/webhooks/paddle \
  --webhook-secret "$PADDLE_WEBHOOK_SECRET" \
  --payment-link https://pay.example.com/checkout
PADDLE_API_BASE_URL=http://127.0.0.1:8795 node app.js
```

```js
import { createServer } from "@crvouga/mockingbird-service-paddle/server"
import { Paddle } from "@paddle/paddle-node-sdk"

const mock = await createServer({ paymentLink: "https://pay.example.com/checkout" })
// In TypeScript: `{ environment: mock.url as Environment }`.
const paddle = new Paddle("pdl_sdbx_apikey_test", { environment: mock.url })

const product = await paddle.products.create({ name: "Pro plan", taxCategory: "saas" })
const price = await paddle.prices.create({
  productId: product.id,
  description: "Pro monthly",
  unitPrice: { amount: "2900", currencyCode: "USD" },
  billingCycle: { interval: "month", frequency: 1 },
})
const customer = await paddle.customers.create({ email: "ada@example.com" })
const address = await paddle.addresses.create(customer.id, { countryCode: "US" })
const transaction = await paddle.transactions.create({
  items: [{ priceId: price.id, quantity: 2 }],
  customerId: customer.id,
  addressId: address.id,
})
// transaction.status === "ready", transaction.details.totals.grandTotal === "5800",
// transaction.checkout.url === "https://pay.example.com/checkout?_ptxn=txn_…"

// The customer pays on the hosted checkout: the mock's admin route stands in for it.
await fetch(`${mock.url}/__admin/transactions/${transaction.id}/pay`, { method: "POST" })
const [subscription] = await paddle.subscriptions.list({ customerId: [customer.id] }).next()
// subscription.status === "active", subscription.nextBilledAt one month out
await mock.close()
```

Without the SDK, the same over HTTP:

```ts
import { createServer } from "@crvouga/mockingbird-service-paddle/server"

const mock = await createServer({ fixtures: true })
const headers = { authorization: "Bearer pdl_sdbx_apikey_test", "content-type": "application/json" }
const { data: products } = await (await fetch(`${mock.url}/products?include=prices`, { headers })).json()
const checkout = await (
  await fetch(`${mock.url}/__admin/checkout`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "new@example.com", items: [{ price_id: products[0].prices[0].id }] }),
  })
).json()
// checkout.transaction.status === "completed", checkout.subscription.status === "active"
await mock.close()
```

### Routes

Every response is Paddle's envelope: `{data, meta: {request_id}}`, lists add
`meta.pagination: {per_page, next, has_more, estimated_total}`. Lists take `after=<id>` (the
cursor in `next`, an absolute URL the SDK follows as-is), `per_page` (default 50, max 200;
transactions 30; more than the maximum gets the maximum, as Paddle documents) and
`order_by=id[ASC]|id[DESC]` (default newest first). Errors are
`{error: {type, code, detail, documentation_url, errors?: [{field, message}]}, meta}`.

| Route | Behaviour |
| --- | --- |
| `GET/POST /customers`, `GET/PATCH /customers/{id}` | `{email, name?, custom_data?, locale?}`; a second customer with the same email is 409 `customer_already_exists`. Filters: `id`, `email`, `search`, `status`. `PATCH {status: "archived"}` archives. |
| `GET /customers/{id}/credit-balances` | Always `[]` (no credit is modelled). |
| `POST /customers/{id}/auth-token` | `{customer_auth_token: "pca_…", expires_at}` (30 minutes out). |
| `…/customers/{id}/addresses`, `…/businesses` (+`/{id}`) | Nested under their customer, as in Paddle; another customer's address is 404. `country_code` is required on an address, `name` on a business. |
| `GET/POST /products`, `GET/PATCH /products/{id}` | `{name, tax_category, description?, image_url?, custom_data?}`; `include=prices` embeds prices. |
| `GET/POST /prices`, `GET/PATCH /prices/{id}` | `{product_id, description, unit_price: {amount, currency_code}, billing_cycle?, trial_period?, quantity?, unit_price_overrides?, tax_mode?}`; `include=product`. Filters: `product_id`, `recurring`, `type`, `status`. |
| `POST /transactions` | `{items: [{price_id \| price: {…non-catalog}, quantity}], customer_id?, address_id?, business_id?, currency_code?, collection_mode?, billing_details?, status?, custom_data?}`. Status is `ready` with a customer and address, else `draft`; `collection_mode: manual` needs `billing_details.payment_terms` and can be created `billed` (invoice number, `billed_at`). `details` holds line items and totals; `checkout.url` is `<paymentLink>?_ptxn=<id>` when a payment link is configured. Recurring items must share one billing cycle; prices must match the transaction currency; an address or business must belong to the customer. Non-catalog `price` objects create `type: custom` prices (and products), only once the whole request has validated. |
| `GET /transactions`, `GET /transactions/{id}` | Filters: `id`, `customer_id`, `subscription_id`, `status`, `origin`, `collection_mode`, `invoice_number`, `created_at[GTE]`-style datetime bounds (`LT`, `LTE`, `GT`, `GTE` on `created_at`, `billed_at`, `updated_at`); `include=customer,address,business`. |
| `PATCH /transactions/{id}` | `draft` and `ready` transactions take every create field again (totals are recomputed); `billed` and `past_due` ones only `{status: "canceled"}`; anything else is 400 `transaction_immutable`. |
| `POST /transactions/preview` | Totals for `{items, customer_id?, address_id?, currency_code?, address?: {country_code}}` without storing anything (non-catalog `price` objects are priced, not created); `include_in_totals: false` items are listed, not summed. |
| `GET /transactions/{id}/invoice` | `{url}` for `billed`, `paid` and `completed` transactions; else 400 `transaction_invoice_not_available`. |
| `GET /subscriptions`, `GET /subscriptions/{id}` | Filters: `id`, `customer_id`, `address_id`, `price_id`, `status`, `collection_mode`, `scheduled_change_action`; `include=next_transaction,recurring_transaction_details` embeds the previews. `management_urls` are placeholder links on the mock's origin. |
| `PATCH /subscriptions/{id}` | `custom_data`, `next_billed_at`, `collection_mode` + `billing_details`, `customer_id`/`address_id`/`business_id`, `scheduled_change: null` (removes a scheduled pause or cancel), and `items` with a required `proration_billing_mode`: `*_immediately` modes bill what the change adds (new prices, quantity increases) in full at once as a `subscription_update` transaction, with no proration and no credit for what it removes; the other modes bill nothing now. Canceled subscriptions are 400 `subscription_update_when_canceled`. |
| `POST /subscriptions/{id}/activate` | `trialing` → `active`: bills the first period now and starts the billing cycle. |
| `POST /subscriptions/{id}/pause` | `{effective_from?: next_billing_period (default) \| immediately, resume_at?}`. Scheduled: `scheduled_change: {action: "pause", effective_at: next_billed_at}`. Immediate: `paused`, `paused_at`, no `next_billed_at`; with `resume_at` a `resume` change is scheduled. |
| `POST /subscriptions/{id}/resume` | `{effective_from: "immediately" \| <datetime>, on_resume?}`. Immediate: `active` with a fresh billing period, billed now; a datetime schedules the resume. On an active subscription with a scheduled pause, it removes the pause. |
| `POST /subscriptions/{id}/cancel` | `{effective_from?: next_billing_period (default) \| immediately}`. Scheduled: `scheduled_change: {action: "cancel", effective_at: next_billed_at}`, applied by the next renewal. Immediate: `canceled`, `canceled_at`, items `inactive`. |
| `POST /subscriptions/{id}/charge` | `{effective_from: immediately \| next_billing_period, items}` of non-recurring prices. Immediate: a completed `subscription_charge` transaction; otherwise the items are added to the next renewal's transaction. |
| `GET /events` | Every event the account produced, newest first: `{event_id, event_type, occurred_at, notification_id: null, data}`. |

Auth is `Authorization: Bearer <key>`; any key works. No header is 403 `authentication_missing`,
a non-Bearer header is 403 `authentication_malformed`. Validation failures are 400
`invalid_field` with `errors: [{field, message}]` (`email: required field`); a malformed JSON
body is 400 `invalid_json`; unknown entities are 404 `not_found` (`Entity ctm_… not found`).
Ids look like Paddle's (`ctm_01…`, `pri_01…`, `txn_01…`, `sub_01…`, `evt_01…`: a prefix and 26
lower-case alphanumerics) and are deterministic for a given history.

### Checkout and billing (admin)

Paddle has no API to pay a transaction or create a subscription: the hosted checkout does
that, and the billing engine renews. These routes stand in for them (all under `/__admin`,
namespaced like everything else):

| Route | Effect |
| --- | --- |
| `POST /__admin/transactions/:id/pay` `{card?: {type, last4, expiry_month, expiry_year, cardholder_name}}` | A `ready`, `billed` or `past_due` transaction is paid: a captured card payment, `completed`, an invoice number. Recurring items create the **subscription** (`trialing` when a price has a `trial_period`, else `active`, with `current_billing_period` and `next_billed_at`); a `past_due` renewal being paid returns its subscription to `active`. → `{transaction, subscription}` |
| `POST /__admin/checkout` `{email \| customer_id, name?, country_code?, postal_code?, address_id?, business_id?, items: [{price_id, quantity?}], custom_data?}` | A hosted-checkout completion in one call: finds or creates the customer (by email) and an address, creates a `web` transaction and pays it. → 201 `{transaction, subscription}` |
| `POST /__admin/subscriptions/:id/renew` | Runs the next billing date. A scheduled cancel or pause takes effect instead (`{subscription, transaction: null}`); a paused subscription with a scheduled resume resumes, billed from its `effective_at`; otherwise a completed `subscription_recurring` transaction for the recurring items (plus queued one-time charges), the billing period advances, and a trial ends into `active`. |
| `POST /__admin/subscriptions/:id/payment-failed` | The renewal's payment is declined: a `past_due` transaction with an `error` payment attempt, and the subscription goes `past_due`. Pay that transaction to recover. |
| `POST /__admin/seed` | The fixture account (below). → 201 with every created record. |
| `GET /__admin/events?type=` | The events list, oldest first, optionally one type. |

`--fixtures` (or `createRuntime({fixtures: true})`) seeds every namespace on first use, and again
after every reset, with:
Ada Lovelace (`ada@example.com`, a US address, a business), a **Pro plan** product with
monthly ($29), yearly ($290) and one-time onboarding ($99) prices, a **Starter plan** with a
14-day trial ($19/month), an active monthly subscription, a trialing Starter subscription
(Grace Hopper, `grace@example.com`), an unpaid `ready` transaction and a `billed` manual
invoice. `seedFixtures()` returns the records; seeding a namespace twice clashes on the emails.
Fixture events are listed (`GET /events`) but never delivered as notifications: they are the
account's pre-existing state, not activity.

### Webhooks

Every event is published to the configured endpoints as Paddle's notification body:

```json
{"event_id": "evt_01…", "event_type": "subscription.created", "occurred_at": "…",
 "notification_id": "ntf_01…", "data": {"id": "sub_01…", "status": "active", "transaction_id": "txn_01…", "items": [ … ], … }}
```

Types: `customer|address|business|product|price.created|updated`, `transaction.created|ready|
billed|paid|completed|canceled|payment_failed|past_due|updated`, `subscription.created|
activated|trialing|updated|paused|resumed|canceled|past_due`. Each delivery carries
`Paddle-Signature: ts=<unix seconds>;h1=<hex HMAC-SHA256(secret, "<ts>:<raw body>")>` with a
wall-clock `ts` (even when the mock clock moves), which `paddle.webhooks.unmarshal(body,
secret, signature)` and `isSignatureValid` accept. Non-2xx answers are retried (immediately,
5 s, 5 min, 30 min, 2 h). `GET /__admin/webhooks`, `…/events`, `…/flush`, `…/:id/replay` and
`PUT /__admin/webhook-endpoints` (per-namespace receivers, `events: ["subscription.*"]`-style
filters are exact types or `*`) come with the contract.

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`; `GET /__admin/faults/presets`):
`invalid_token` (403 on every request), `rate_limited` (429 `too_many_requests` with
`retry-after: 2`, the SDK's `ApiError.retryAfter`), `transactions_500` (`POST /transactions`
answers 500 `internal_error`), `bad_gateway_html` (reads answer a 502 HTML page),
`network_drop` (`POST /transactions` drops the connection), `webhook_duplicate`,
`webhook_reorder`, `webhook_drop`.

### Namespaces

`new Paddle(key)` cannot add a namespace header on its own (it can with `customHeaders`), so
map API keys to namespaces: `PUT /__admin/credentials {"credentials": {"<PADDLE_API_KEY>":
"<namespace>"}}`. Also `x-mockingbird-namespace`, or a `/ns/<name>` prefix on the base URL
(`meta.pagination.next` keeps it).

### Deliberately not modelled

- **Tax and discounts.** Totals carry `tax: "0"` and `discount: "0"` whatever the address or
  `tax_mode`; there are no discounts, discount groups or adjustments (refunds, credits), and no
  credit balances. `unit_price_overrides` are honoured for the address's country.
- **Proration.** Changing a subscription's items with a `*_immediately` mode bills what the
  change adds in full, credits nothing for what it removes; the next-period modes bill nothing now. `PATCH /subscriptions/{id}/preview` and
  `…/charge/preview` are unsupported.
- **The hosted checkout, customer portal and Paddle.js.** `checkout.url` and `management_urls`
  are links, not pages; `POST /__admin/checkout` and `…/pay` replace the checkout.
- **Payment methods and payment method changes**, payouts, reports, simulations, notification
  settings through the API (endpoints are configured on the mock), invoice revisions, the
  `imported` events, API key events and client tokens.
- **Time.** Nothing renews on its own: call `…/renew` (or `…/payment-failed`) when the test's
  clock reaches `next_billed_at`. Retry schedules for past-due subscriptions are not modelled.
- **Rate limits**, except through `rate_limited`. Legacy (pre-2025) API key formats are
  accepted like any other key.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `PaddleAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `events()`, `state`, and the billing methods the admin routes call: `createCustomer`, `createAddress`, `createBusiness`, `createProduct`, `createPrice`, `createTransaction`, `payTransaction`, `checkout`, `renewSubscription`, `failPayment`, `seedFixtures`. Options: `sqlite`, `now`, `namespace`, `publicNamespace`, `paymentLink`, `onEvent`, `fixtures`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, namespaces, credentials, presets, `Paddle-Signature` webhooks, checkout and billing routes). Options: `webhooks: {url, secret, events?, retryDelaysMs?, fetch?}`, `paymentLink`, `fixtures`, `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `paddleSigner` | function | The `Paddle-Signature` webhook signer (`ts=…;h1=…`). |
| `PADDLE_PRESETS` | object | Every named fault preset. |
| `PADDLE_NAMESPACE` | string | The service name, `"paddle"`. |
| `AUTH_TOKEN_TTL_MS` | number | The advertised lifetime of a customer auth token (30 min). |
| `PaddleError` | class | The error a billing method throws: `status`, `code`, `detail`, `errors?`, `toResponse(requestId)`. |
| `PaddleState` | class | The SQLite-backed collections (`customers`, `addresses`, `businesses`, `products`, `prices`, `transactions`, `subscriptions`, `events`) and `nextId(kind)`. |
| `ID_PREFIX` | object | Paddle's id prefix per entity (`customer: "ctm"`, `price: "pri"`, …). |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target (`--webhook-url`, `--webhook-secret`, `--payment-link`, `--fixtures`); port 8795. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
