# @crvouga/mockingbird-service-flex

Stateful mock of the **Flex** (withflex.com) HSA/FSA payments API for test suites: products
(answered from a recorded catalog corpus), checkout sessions in `payment` (one-time),
`subscription`, `off_session` and `setup` modes, subscriptions, customers, setup intents,
refunds, the **hosted checkout page**, and the Svix-signed webhooks Flex posts back. A UI checkout that drove the real
`checkout.withflex.com` page and then waited on a 5-minute reconciler settles here in
milliseconds: the page is local, and the signed webhook reaches the app as soon as the card is
accepted.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/flex/SUPPORT.md)
- Flex publishes no machine-readable spec: the contract (`openapi.yaml`) is hand-authored from
  the wire shapes our consumer reads and writes (`B/billing/flex/`), and every field its zod
  schemas require is served. Subscription mode, `price_data.recurring` and the subscription
  object follow the [Flex API reference](https://docs.withflex.com/api-reference) (there is
  no sandbox recording).

## Install

```bash
npm install -D @crvouga/mockingbird-service-flex
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-flex serve`, `createServer` from `./server` (Node), or `createRuntime` with any
Fetch server.

## Usage

Point the app at the mock:

| Env | Value |
| --- | --- |
| `FLEX_API_BASE_URL` | `http://127.0.0.1:8792` (or `…/ns/<namespace>`) |
| `FLEX_API_KEY` | any `fsk_test_…` key (test mode); `fsk_…` is live mode; other formats get 401 |
| `FLEX_WEBHOOK_SECRET` | the same value as `--webhook-secret`: `fwhsec_<base64>` or `whsec_<base64>` |

```bash
npx mockingbird-flex serve --port 8792 \
  --webhook-url http://127.0.0.1:3000/billing/webhooks/flex \
  --webhook-secret "$FLEX_WEBHOOK_SECRET"
```

```ts
import { createRuntime } from "@crvouga/mockingbird-service-flex"

const flex = createRuntime({
  webhooks: {
    url: "http://127.0.0.1:3000/billing/webhooks/flex",
    secret: "fwhsec_ZmxleC1tb2NrLXNpZ25pbmcta2V5",
  },
})
const post = (path: string, body: unknown) =>
  flex.fetch(
    new Request(`http://flex.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fsk_test_suite" },
      body: JSON.stringify(body),
    }),
  )

const { checkout_session } = (await (
  await post("/v1/checkout/sessions", {
    checkout_session: {
      success_url: "https://app.test/done?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://app.test/cart",
      client_reference_id: "attempt-1",
      line_items: [
        { price_data: { product: "fprod_01m0tgysj4ahvf8fas60c2ef2d", unit_amount: 4500 }, quantity: 1 },
      ],
    },
  })
).json()) as { checkout_session: { checkout_session_id: string; url: string } }
// …open checkout_session.url in the browser and pay with 4000 0512 3000 0072, or:
await post(`/__admin/sessions/${checkout_session.checkout_session_id}/complete`, {})
```

### Browser E2E suites

Run `npx mockingbird-flex serve` on a port, point `FLEX_API_BASE_URL` at it, and the browser
lands on the mock's page instead of `checkout.withflex.com`: no network, no shared Flex
account, and the signed webhook reaches the app as soon as Pay is clicked. The page URL takes
the mock's origin, or `--public-url` when given. A suite that finds the Flex tab by host
(`/\bcheckout\.withflex\.com\b/`) keeps working with
`--public-url http://checkout.withflex.com.localhost:8792`: Chromium resolves every
`*.localhost` name to loopback. Other browsers may need a hosts entry.

### Routes

All API bodies are wrapped: `{product: {…}}`, `{checkout_session: {…}}`, `{customer: {…}}`,
`{setup_intent: {…}}`, `{products: […], has_more}`, `{checkout_sessions: […], has_more}`.
Errors are `{error: {type, message, param?}}`.

| Route | Behaviour |
| --- | --- |
| `GET /v1/products?limit=&starting_after=` | Oldest first; `limit` 1–100 (default 10). The corpus comes first, then created products. |
| `POST /v1/products` | `{product: {name, description?, url?, client_reference_id?, metadata?}}`. New products are active, `hsa_fsa_eligibility: null` until classified (`PUT /__admin/products/:id`). |
| `GET /v1/products/{id}` | `product_id, name, description, url, client_reference_id, hsa_fsa_eligibility, visit_type, active, test_mode, metadata, created_at`. |
| `PATCH /v1/products/{id}` | `{product: {active?, name?, description?, url?, metadata?}}`; emits `product.updated`. |
| `POST /v1/checkout/sessions` | `Idempotency-Key` honoured. `mode` `payment` (≥1 line item), `subscription` (≥1 line item whose `price_data.recurring` is `{interval: day\|week\|month\|year, interval_count?}`, else 400; optional `subscription_data: {cancel_at_period_end?, metadata?}`), `setup` (a customer and no line items, else 400), `off_session` (customer + a saved `payment_method`, charged before answering: the response is already `complete`, or its expanded payment intent is `requires_payment_method` / `requires_action` per `offSessionOutcome`). Unknown or inactive products, customers and payment methods are 400. `redirect_url` and `url` are the hosted page. |
| `GET /v1/checkout/sessions/{id}?expand_customer=true&expand_payment_intent=true` | The session; expansions return `customer` / `payment_intent` objects instead of ids. |
| `GET /v1/checkout/sessions?client_reference_id=&limit=&starting_after=` | Newest first (our ambiguous-create recovery). |
| `POST /v1/checkout/sessions/{id}/refund` | `Idempotency-Key` honoured. `{checkout_session: {}}` (full) or `{checkout_session: {amount}}`; 400 when unpaid or over-refunded. |
| `POST /v1/customers` | `Idempotency-Key` honoured. `{customer: {first_name, last_name, email, phone}}` (all required). |
| `GET /v1/setup_intents/{id}?expand=customer,payment_method` | `setup_intent_id, status, customer, payment_method`. |
| `GET /v1/subscriptions/{id}` | `{subscription: {subscription_id, status, items, customer, default_payment_method, cancel_at_period_end, current_period_start, current_period_end, canceled_at, metadata, test_mode, created_at}}`. A paid subscription-mode session starts one: `active`, `items` = its recurring line items, the period one interval of the first recurring item (month/year steps clamp to the month's last day), charged to the card just used; the session's `subscription` holds its id. |

Auth: `Authorization: Bearer fsk_test_…` or `fsk_…`; a missing key, or any other format
(`sk_test_…`, `whsec_…`), is 401 `authentication_error`. `test_mode` on created objects follows
the key. Same key + same body replays the stored response; same key + a different body is 400
`idempotency_error`; a concurrent request with an in-flight key is 409.

### Hosted page

`GET /pay/{sessionId}` renders a plain form (no scripts) with `data-testid`s
`flex-mock-email`, `-first-name`, `-last-name`, `-phone`, `-card`, `-exp`, `-cvc`, `-zip`,
`-pay`, `-cancel`, `-error`, `-amount`, and on the letter step `-lmn-submit`. Inputs also carry
the `name`s and placeholders our codecept locators look for (`cardNumber`, `expiry`, `cvc`,
`postalCode`, `email`, …). `POST /pay/{sessionId}` submits it:

| Card | Result |
| --- | --- |
| `4000 0512 3000 0072` | HSA card: succeeds. |
| `4242 4242 4242 4242` (or any other valid card) | Succeeds; if a line item's product is `letter_of_medical_necessity`, the session gets `next_action: {type: "collect_letter_of_medical_necessity", collect_letter_of_medical_necessity: {url}}` and the browser goes to that step; submitting it completes the payment. |
| `4000 0000 0000 0002` | Declines: 402 page with `<div role="alert">Your card was declined.</div>`; the payment intent is `requires_payment_method`. |

Success 302s to `success_url` with `{CHECKOUT_SESSION_ID}` substituted (raw and
`%7BCHECKOUT_SESSION_ID%7D`); `GET /pay/{id}/cancel` (the Cancel link) 302s to `cancel_url`,
leaving the session open. A contact email on a session without a customer creates one. In a
namespace the page URL carries `/ns/<name>` (the browser sends no headers); `publicUrl`
overrides the origin.

### Webhooks

Svix-signed (`svix-id`, `svix-timestamp` = wall clock, `svix-signature: v1,<base64
HMAC-SHA256(key, "<id>.<ts>.<body>")>`, key = base64-decoded secret after `fwhsec_`/`whsec_`).
Body: `{event: {event_id, event_type, object, event_dt, test_mode, created_at}}`.
Checkout events carry the session (so `object.checkout_session_id`), payment-intent events the
intent plus `checkout_session_id`, refund events `checkout_session` and `payment_intent`, and
`product.updated` the product (`object.product_id`).

| Event | When |
| --- | --- |
| `payment_intent.succeeded`, then `checkout.session.completed` | the page (or `…/complete`, or an off-session charge) settles a session |
| `customer.subscription.created` (the subscription), before those two | a subscription-mode session settles |
| `checkout.session.async_payment_succeeded` | settling a session whose intent was `processing` |
| `checkout.session.async_payment_failed` | a decline (page, admin, off-session) |
| `checkout.session.expired` | `…/expire`, or `expires_at` passing on the mock clock (default 24 h) |
| `refund.created`, `charge.refunded`, `checkout.session.refunded`, `refund.updated`, `charge.refund.updated` | each refund |
| `product.updated` | `PATCH /v1/products/{id}` and `PUT /__admin/products/:id` |
| `checkout_session.completed`, `checkout_session.expired` | the aliases, with `PUT /__admin/settings {"eventNaming": "underscored"}` |

`POST /__admin/events {type, session | product}` emits any type on demand. Non-2xx answers are
retried (immediately, 5 s, 5 min, 30 min, 2 h); `GET /__admin/webhooks`, `…/events`,
`POST /__admin/webhooks/flush`, `…/:id/replay`, `PUT /__admin/webhook-endpoints` as usual.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `PUT /__admin/products/:id` | `{hsa_fsa_eligibility?, active?, test_mode?, visit_type?, client_reference_id?, name?, metadata?}`; emits `product.updated`. |
| `POST /__admin/sessions/:id/complete` | `{card?}`: settle as if paid (HSA card unless `card` is `4242…`). |
| `POST /__admin/sessions/:id/decline` | Payment intent → `requires_payment_method`. |
| `POST /__admin/sessions/:id/expire` | Session → `expired`. |
| `POST /__admin/sessions/:id/require_action` | `{next_action_type?}`: `collect_letter_of_medical_necessity` (default), `provide_second_payment_method`, `provide_alternative_payment_method`, `payment_failed`. |
| `PUT /__admin/sessions/:id/payment-intent` | `{status, amount_received?}`: `requires_payment_method`, `requires_action`, `processing`, `succeeded`, `canceled`. |
| `GET /__admin/sessions`, `GET /__admin/sessions/:id` | The namespace's sessions. |
| `POST /__admin/events` | Emit any event type for a session or product. |
| `GET/PUT /__admin/settings` | `{eventNaming, offSessionOutcome, sessionTtlSeconds, lmnOnRegularCard, publicUrl}`. |
| `POST /__admin/tick` | Expire due sessions now (the served mock ticks every 100 ms). |

Every orchestrator state is reachable: pending (open), action_required (`require_action`, or an
intent `requires_action`), processing, canceled (intent `canceled`, or expired), failed
(`decline`), succeeded, refunded (full refund), quarantined (partial refund,
`amount_mismatch`, duplicate sessions).

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`; `GET /__admin/faults/presets`):
`create_4xx` (400, nothing created), `create_5xx` (creates, then 500: recovery adopts it),
`create_5xx_not_created`, `timeout` (creates, answers after 16 s, past the client's 15 s abort;
`params.delayMs` overrides), `invalid_shape` (no `redirect_url`/`url`), `amount_mismatch`
(`amount_total` + 100), `duplicate_sessions_for_client_reference` (two sessions, then 500),
`refund_4xx`, `server_error`, `webhook_duplicate`, `webhook_reorder`, `webhook_drop`.

### Namespaces

`x-mockingbird-namespace`, a `/ns/<name>` prefix on `FLEX_API_BASE_URL`, or by API key:
`PUT /__admin/credentials {"credentials": {"<FLEX_API_KEY>": "<namespace>"}}`.

### Corpus

`src/corpus/products.ts` is the product side of every row of the consumer's
`flexCatalogMappings` reference fixture (663 rows, regenerated with
`bun scripts/corpus.ts <fixture.json>`): product id, client reference, the `acme_purpose` /
`acme_merchant_product_id` / `acme_client_reference_id` metadata our catalog validation
compares, eligibility and visit type. Every product is active and test-mode, so our validation
reproduces each mapping row's own `active` flag. No sandbox recording exists (no credentials),
so product names are synthesised.

### Deliberately not modelled

- Real card processing, Stripe iframes and split-tender payments: the page is a plain form, and
  split payment is reachable only as `next_action: provide_second_payment_method`.
- The letter-of-medical-necessity questionnaire: one submit button stands in for it.
- Test/live data separation: a live key sees the same objects (only `test_mode` differs).
- Subscription lifecycle after checkout: renewals, invoices and the `invoice.*` events,
  trials, `customer.subscription.updated` / `.deleted`, and the subscription update/cancel
  routes. A subscription stays `active` for its first period. The Prices API (`price` ids in
  line items) is not modelled either: use inline `price_data`.
- Coupons, promotion codes (`allow_promotion_codes` is echoed only), partial captures,
  disputes.
- Flex's exact error texts and ids: shapes follow what our consumer reads; ids look like
  `fprod_01z…`, `fcs_01z…`, `fcus_…`, `fpi_…`, `fseti_…`, `fpm_…`, `fevt_…`.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `FlexAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `settle(id)`, `decline(id)`, `expire(id)`, `requireAction(id, type)`, `setPaymentIntent(id, patch)`, `applyRefund(id, amount)`, `putProduct(product)`, `emitFor(type, target)`, `tick()`, `sessions()`, `subscriptions()`, `present(session, view)`. Options: `sqlite`, `now`, `namespace`, `publicNamespace`, `products`, `settings`, `onEvent`. |
| `createRuntime` | function | The mock with the full service contract. Options: `webhooks: {url, secret, retryDelaysMs?, fetch?}`, `products`, `settings`, `tickMs`, `clock`, `seed`, `adminKey`, `onLog`. |
| `FLEX_PRESETS` | object | Every named fault preset. |
| `FLEX_NAMESPACE` | string | The service name, `"flex"`. |
| `FLEX_EVENT_TYPES` | array | Every webhook event type, aliases included. |
| `keyMode` | function | `"test"` for `fsk_test_…`, `"live"` for `fsk_…`, otherwise `undefined`. |
| `isNextActionType` | function | Whether a string is a next-action type. |
| `CARDS`, `classifyCard`, `substituteSessionId` | values | The hosted page's test cards, its card classifier, and the `{CHECKOUT_SESSION_ID}` substitution. |
| `CORPUS_ROWS`, `corpusProduct` | values | The recorded product corpus and its row → product mapping. |
| `DEFAULT_SETTINGS`, `ELIGIBILITIES`, `NEXT_ACTION_TYPES`, `PAYMENT_INTENT_STATUSES`, `SUBSCRIPTION_STATUSES` | values | Defaults and enums. |
| `periodEnd` | function | `periodEnd(startMs, {interval, interval_count?})`: the end of a billing period (epoch ms). |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http` (expiry ticks every 100 ms); the `serve` CLI target (`--webhook-url`, `--webhook-secret`, `--public-url`, `--event-naming`); port 8792. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
