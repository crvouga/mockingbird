# @crvouga/mockingbird-service-stripe

Stateful, in-process mock of the [Stripe API](https://docs.stripe.com/api) for test suites: accounts
chosen by API key, customers and balances, payment methods, payment and setup intents, charges,
refunds, disputes, checkout (with a hosted page and a Stripe.js stand-in), invoices, subscriptions
that renew when the clock moves, subscription schedules, coupons, promotion codes, products,
prices, test clocks, webhook endpoints, the balance ledger and the event log — with signed webhooks
fanned out to every matching endpoint. Responses are rendered at the caller's `Stripe-Version`
(`2024-06-20`, `2025-02-24.acacia`, or the vendored latest), and the whole surface is verified by
differential property tests against Stripe test mode.

- Operation coverage (111 of 115 operations in the vendored spec, with reasons for each gap):
  [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/stripe/SUPPORT.md)
- Stripe API reference: https://docs.stripe.com/api · Upstream OpenAPI: https://github.com/stripe/openapi

## Install

```bash
npm install -D @crvouga/mockingbird-service-stripe
```

ESM only. Requires Node >= 22 or Bun >= 1.2. No native dependencies: state lives in an in-memory
SQLite engine (pure TypeScript, bundled in).

## Usage

```bash
npx mockingbird-stripe serve                  # http://127.0.0.1:12111
npx mockingbird-stripe serve --accounts accounts.json --admin-key local-admin
npx mockingbird-stripe serve --config mockingbird.json   # every service in one process
```

```js
import Stripe from "stripe"
import { createServer } from "@crvouga/mockingbird-service-stripe/server"

const server = await createServer({
  accounts: [
    // Legacy STRIPE_API_KEY, STRIPE_MSO_API_KEY and the EMR key all act as MSO and share state.
    { id: "acct_mso", keys: ["sk_test_legacy", "sk_test_mso", "sk_test_emr", "pk_test_mso"], corpus: true },
    { id: "acct_pc", keys: ["sk_test_pc"] },
    { id: "acct_pp", keys: ["sk_test_pp"], apiVersion: "2025-02-24.acacia" },
  ],
})
const url = new URL(server.url)
const stripe = new Stripe("sk_test_mso", {
  apiVersion: "2024-06-20",
  host: url.hostname,
  port: Number(url.port),
  protocol: "http",
})
const customer = await stripe.customers.create({ email: "qa@example.com" })
await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id }) // a new pm_ id
await server.close()
```

Or over raw HTTP, the way any Stripe client talks to it:

```ts
import { createServer } from "@crvouga/mockingbird-service-stripe/server"

const server = await createServer()
const response = await fetch(`${server.url}/v1/customers`, {
  method: "POST",
  headers: {
    authorization: "Bearer sk_test_mso",
    "content-type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams({ email: "qa@example.com" }),
})
const customer = (await response.json()) as { id: string; email: string }
await server.close()
```

### Pointing the app at it

stripe-node accepts `host`, `port` and `protocol`; route every `new Stripe(...)` through one options
factory reading `STRIPE_API_HOST` / `STRIPE_API_PORT` / `STRIPE_API_PROTOCOL` (the catalog's G-S1),
and give raw `fetch('https://api.stripe.com…')` call sites the same base URL. Keys must look like
test keys (`sk_test_…`, `rk_test_…`; `pk_test_…` for the Stripe.js stand-in). Point the browser at
the mock's `GET /v3` instead of `https://js.stripe.com/v3` (G-S3); `session.url` already points at
the mock's hosted page.

### Accounts and namespaces

State is partitioned by **account**, and the account is chosen by API key:

- `PUT /__admin/accounts {"accounts": [{id, keys, apiVersion?, webhookSecrets?, corpus?, displayName?}]}`
  (also `createRuntime({accounts})` / `serve --accounts <json|file>`). Every key listed on an
  account acts as it. Any other test key is an account of its own (`accountOfKey(key)`), so an MSO
  key reading a PC object gets Stripe's exact `404 resource_missing` (`No such payment_intent: 'pi_…'`).
- `apiVersion` is the account's default version (requests without `Stripe-Version`) and the version
  its webhook payloads render at (default `2024-06-20`, what every backend receiver of ours pins).
- `webhookSecrets: {"<receiver url>": "whsec_…"}` delivers every event of the account there.
- `corpus: true` seeds the recorded catalog (below).

**Namespaces** isolate parallel workers; each namespace has its own copy of every account. Carriers:
the `x-mockingbird-namespace` header, the `/ns/<namespace>/…` path prefix, or **by API key**:
`PUT /__admin/credentials {"credentials": {"sk_test_worker1": "w1"}}` (stripe-node cannot add
headers). Hosted-page URLs carry the `/ns/<namespace>` prefix so the browser lands in the same one.

### API versions

`Stripe-Version` picks the shape. `2024-06-20` (and anything before 2024-09-30) returns
`invoice.discount` (with the coupon embedded), `invoice.charge` / `payment_intent` / `subscription` /
`paid` / `subscription_details`, `subscription.current_period_*` and `subscription.discount`, and
invoice lines with `price` objects; `2025-02-24.acacia` adds `total_pretax_credit_amounts`;
2025-03-31.basil and later (the vendored latest) drop those and use `parent`, `pricing`,
`discount.source` and item-level periods. `charge.refunds` appears only with `expand[]=refunds` at
every one of these versions. `GET /v1/invoices/upcoming` answers at the older versions and returns
Stripe's "deprecated" 404 at basil and later. Expansion is generic (any path through ids the mock
holds, ancestors included); Stripe's own rules are enforced: a non-expandable first segment is
`This property cannot be expanded (metadata).` and more than four levels is
`property_expansion_max_depth` (verified against test mode at all three versions).

### Webhooks

Every state change records an event in the account's log (`GET /v1/events`, filterable by
`types[]` and `created`) and publishes it through the shared webhook hub, signed
`Stripe-Signature: t=<wall-clock unix>,v1=<hex HMAC-SHA256(secret, "t.body")>` over the exact bytes —
`stripe.webhooks.constructEvent` verifies them.

- Endpoints: `PUT /__admin/webhook-endpoints [{account, url, secret, enabledEvents: ["*"|…]}]`
  (`account` is an account id or any of its keys; omit it to receive every account),
  `serve --webhook-url/--webhook-secret`, accounts' `webhookSecrets`, and endpoints created through
  `POST /v1/webhook_endpoints` (signed with the `whsec_` returned at creation). One event fans out to
  every matching endpoint, as on Stripe. Retries follow the hub's schedule.
- `GET /__admin/webhooks`, `/webhooks/events`, `POST /__admin/webhooks/:id/replay`, `/webhooks/flush`.
- Delivery faults: presets `webhook_duplicate` (same event id twice — our receiver's in-flight
  dedupe answers 500), `webhook_reorder` (the next two swapped), `webhook_drop` (never delivered,
  still in `GET /v1/events` for the replay worker).
- Metadata is copied verbatim, so the PC route's quarantine rule (`metadata.intent ∈ {pc_order,
  kb_membership, shop_purchase, stripe_membership}` or `source=supplement` + `billingInvoiceId`)
  only fires for sessions that would trip it on Stripe.

Events emitted: `customer.*`, `payment_method.attached|detached|updated`,
`payment_intent.created|succeeded|payment_failed|canceled|requires_action|amount_capturable_updated`,
`charge.succeeded|failed|captured|refunded|dispute.created`, `setup_intent.created|succeeded|setup_failed|canceled|requires_action`,
`checkout.session.completed|expired|async_payment_succeeded`,
`invoice.created|finalized|updated|paid|payment_succeeded|payment_failed|voided|deleted|upcoming`,
`invoiceitem.created`, `customer.subscription.created|updated|deleted` (with
`data.previous_attributes`), `subscription_schedule.*`, `refund.created|updated|failed`,
`product.*`, `price.*` (with `previous_attributes`), `coupon.*`, `promotion_code.*`,
`test_helpers.test_clock.*`.

### Lifecycles and the clock

`POST /__admin/clock {"advance": "32d"}` (or `set`) moves the mock clock and immediately runs every
clock-driven lifecycle, so their webhooks fire at once; the served mock also ticks every second.

- **Renewals**: past `current_period_end` a subscription cycles — a `subscription_cycle` invoice is
  finalized and charged off-session to the default payment method, then `invoice.paid` +
  `customer.subscription.updated` (`previous_attributes.current_period_end`), or
  `invoice.payment_failed` and `past_due`. Trials end into a cycle; `cancel_at_period_end` cancels
  (`customer.subscription.deleted`). `invoice.upcoming` fires 3 days before renewal.
- `incomplete` subscriptions become `incomplete_expired` after 23 h (their invoice is voided).
- Checkout Sessions expire at `expires_at` (`checkout.session.expired`).
- Schedule phases advance; the last one releases or cancels per `end_behavior`.
- **Test clocks**: customers created with `test_clock` live on the clock's time;
  `POST /v1/test_helpers/test_clocks/:id/advance` runs their lifecycles and the clock reads `ready`
  on the next retrieve.
- `POST /__admin/tick` runs the lifecycle without moving the clock.

Payment behaviour: `payment_behavior` omitted (`allow_incomplete`) charges the default payment method
now and returns `incomplete` on a decline; `error_if_incomplete` fails the call with the 402;
`default_incomplete` leaves the first invoice's PaymentIntent (with its `client_secret`) for the
customer, and paying it through Stripe.js activates the subscription. `trial_end`,
`backdate_start_date` + `billing_cycle_anchor` + `proration_behavior=none` (a $0 first invoice),
item updates with `always_invoice` (billed now) or `create_prorations` (next invoice), and
discounts with stable `di_` ids (`discounts=""` clears) are modelled. A $0 invoice is `paid` on
finalize; a customer credit balance is applied at finalize; `void` works only on open invoices
(`You can only pass in open invoices. This invoice isn't open.`).

### Hosted Checkout page and Stripe.js

- `GET /c/pay/:sessionId` — the page `session.url` points to, laid out like Stripe's hosted
  Checkout (order summary beside the payment form, stacked on narrow screens): card number,
  expiry, CVC, ZIP and Pay/Cancel with `data-testid`s `stripe-mock-card`, `stripe-mock-exp`,
  `stripe-mock-cvc`, `stripe-mock-zip`, `stripe-mock-pay`, `stripe-mock-cancel` (a decline shows
  `stripe-mock-error`), plus optional email, cardholder name and country. A **Test cards** panel
  has one button per test card number (`stripe-mock-test-card`, `data-test-card="<number>"`):
  succeeding brands, declines (generic, insufficient funds, expired, attach-then-fail), 3D Secure
  and dispute. Each button fills every field, and with “Pay immediately after filling” ticked it
  submits the form too. Pay completes the session (creating the customer, the PaymentIntent with
  `payment_intent_data.metadata`, the Subscription with `subscription_data.metadata`, or the
  SetupIntent), emits `checkout.session.completed` and 302s to `success_url` with
  `{CHECKOUT_SESSION_ID}` substituted raw and `%7B…%7D`-encoded; Cancel 302s to `cancel_url`.
- `POST /__admin/checkout/sessions/:id/complete {"card": "4242…"}` does the same without a browser;
  `…/expire` and `…/async_payment_succeeded` too.
- `GET /v3` — the Stripe.js stand-in: `Stripe(pk)`, `elements()` → `create("payment"|"card")`,
  `confirmPayment`, `confirmSetup`, `confirmCardPayment`, `confirmCardSetup`,
  `retrievePaymentIntent`, `retrieveSetupIntent`, `createPaymentMethod`, `handleCardAction`. It calls
  `POST /v1/{payment,setup}_intents/:id/confirm` with the publishable key and `client_secret` (the
  requests UI suites already wait for); 3-D Secure cards are authenticated in place.

A publishable key may only confirm or read an intent whose `client_secret` it presents, and create
payment methods; anything else is Stripe's 401.

### Test values

- Payment methods: `pm_card_visa`, `pm_card_mastercard`, `pm_card_amex`, `pm_card_discover`,
  `pm_card_visa_debit`, `pm_card_chargeDeclined`, `pm_card_chargeDeclinedInsufficientFunds`,
  `pm_card_chargeDeclinedExpiredCard`, `pm_card_chargeCustomerFail`,
  `pm_card_authenticationRequired`, `pm_card_threeDSecure2Required`, `pm_card_createDispute` —
  each use clones a new `pm_`.
- Tokens: `tok_visa`, `tok_chargeCustomerFail` (attaches, then every charge declines),
  `tok_chargeDeclinedInsufficientFunds`, `tok_chargeDeclinedExpiredCard`, `tok_createDispute`, …
- Card numbers (page, Stripe.js): `4242424242424242` succeeds, `4000000000000002` declines,
  `4000000000009995` insufficient funds, `4000002500003155` 3-D Secure, `4000051230000072` the HSA
  card (`funding: prepaid`, `issuer: OPTUM BANK`, what our HSA/FSA detection matches).
- Off-session declines answer 402 `card_error` with `charge`, `decline_code`, `advice_code`,
  `payment_method` and the failed `payment_intent` embedded, as Stripe does.
- Client secrets are `pi_<id>_secret_<x>` / `seti_<id>_secret_<x>`.

### Idempotency

POSTs with `Idempotency-Key` go through the shared `IdempotencyStore`, scoped per account: a
replay returns the stored response byte for byte (with `idempotent-replayed: true`); the same key
with different parameters is 400 `idempotency_error`; a concurrent request on an in-flight key is
409 `idempotency_key_in_use`, with Stripe's wording.

### Fault presets

`POST /__admin/faults {"preset": "<name>", "count"?: n}`: `card_declined`, `insufficient_funds`,
`expired_card`, `authentication_required` (the next charge attempt declines), `rate_limited` (429
`rate_limit`), `api_error` (500 `api_error`), `permission_error` (403), `connection_drop`,
`idempotency_in_flight` (500 ms processing, so a concurrent retry gets 409), `search_lag` (search
hides objects younger than 60 s — search is consistent otherwise), `webhook_duplicate`,
`webhook_reorder`, `webhook_drop`.

### Admin routes (beyond the standard contract)

`GET|PUT /__admin/accounts`, `PUT /__admin/webhook-endpoints`, `PUT /__admin/refunds/:id
{status, failure_reason}` (emits `refund.failed` / `refund.updated`), `POST /__admin/disputes
{payment_intent|charge, reason?, amount?}` (emits `charge.dispute.created`),
`POST /__admin/checkout/sessions/:id/complete|expire|async_payment_succeeded`,
`POST /__admin/setup_intents/:id/succeed`, `GET /__admin/charges/:id`, `POST /__admin/tick`. The
standard ones (`/health`, reset, snapshots, clock, faults, metrics, `GET /__admin/requests`,
credentials, webhooks) come from the shared runtime. The journal records operation, status and ids
only — never bodies, card numbers or emails.

### Corpus

`ACME_CORPUS` is the recorded test-mode catalog our seeded fixtures point at (reference-data
products and prices, catalog plans, shop fixtures, QA snapshots such as `prod_SNj3rQYHrHNS0H` /
`price_1StxtjGBBGmxLhdL8PzNSEgX`, and runbook coupons and promotion codes; 144 products, 172
prices). Accounts with `corpus: true` answer those ids byte for byte; customers, intents and
subscriptions are never recorded. The membership lookup keys our env expects
(`membership_<tier>_<interval>`, e.g. `membership_plus_annually`) are attached to the matching
recorded prices (listed in `synthesizedLookupKeys`). Pass your own with `createRuntime({corpus})`.

## API

`StripeAPI` is the engine; `createRuntime` wraps it in the service contract. From
`@crvouga/mockingbird-service-stripe`:

| Export | Description |
| --- | --- |
| `createRuntime` | `(options?) => StripeRuntime` — the mock with the full contract. Options: `accounts`, `webhooks {endpoints, retryDelaysMs, fetch}`, `corpus`, `publicUrl`, `webhookApiVersion`, `lifecycle`, `tickMs`, `sqlite`, `clock`, `seed`, `adminKey`, `onLog`, `onWebhook`. The runtime adds `webhooks`, `accounts`, `tick()`, `stop()`. |
| `StripeAPI` | Class; `new StripeAPI(options?)` implements `fetch(request)`. Members: `reset()`, `tick(force?)`, `webhookEvents(account?)`, `webhookDeliveryAttempts(account?)`, `apiWebhookEndpoints()`, `accountIds()`, `scopeFor(account)`, `importStateFrom(source)`, `accounts`, `app`, `sqlite`. |
| `STRIPE_PRESETS` | The named fault presets above. |
| `AccountDirectory` | Keys → accounts (`configure`, `accountFor`, `config`, `list`, `resolve`). |
| `DEFAULT_WEBHOOK_API_VERSION` | `"2024-06-20"`. |
| `accountOfKey` | `(key) => string` — the account id of an unconfigured key. |
| `accountOf` | `(request) => string` — the same, from a request's bearer key. |
| `STRIPE_API_VERSION` | The vendored latest version (`2026-08-26.dahlia`). |
| `LEGACY_API_VERSION` | `"2024-06-20"`. |
| `ACACIA_API_VERSION` | `"2025-02-24.acacia"`. |
| `ACME_CORPUS` | The bundled recorded catalog. |
| `TEST_TOKENS` | Every modelled `tok_…`. |
| `TEST_PAYMENT_METHOD_IDS` | Every modelled magic `pm_card_…`. |
| `TEST_CARD_NUMBERS` | Every modelled test card number. |
| `STRIPE_NAMESPACE` | `"stripe"` — SQLite namespace of every record. |
| `document` | The vendored OpenAPI document (Mockingbird subset). |
| `operationIds` | Every `operationId` in `document`. |
| `supportedOperationIds` | The ones the mock implements. |
| `QA_SURFACE_OPS` | Operations the parity walks cover (supported, minus the browser pages). |
| `QA_METADATA` | Pinned metadata values the parity walks send. |
| `QA_AMOUNTS` | Pinned amounts in cents. |
| `QA_CUSTOMER` | Pinned customer `email`, `name`, `phone`. |
| `QA_TEST_PAYMENT_METHODS` | Test payment methods the walks use. |
| `QA_TEST_CARD_TOKENS` | Test card tokens the walks use. |
| `QA_SEARCH_QUERIES` | Search queries the walks issue. |
| `QA_COUPON_CODES` | Promotion codes the walks use. |
| `reshapeQaCommand` | Parity-walk hook pinning sampled commands onto those values. |

From `@crvouga/mockingbird-service-stripe/server` (Node): `createServer(options?)` (runtime options
plus `port`, `host`; resolves `{url, port, runtime, close}`), `serveTarget` (the `serve` wiring:
`--accounts`, `--webhook-url`, `--webhook-secret`, `--public-url`) and `DEFAULT_PORT` (`12111`).

## Deliberately not modelled

- **Stripe.js internals**: the stand-in covers the calls our UI makes; Payment Element wallets,
  Link, `paymentRequest` (it reports no wallet) and Elements styling are not modelled. Native
  PaymentSheet cannot be redirected (member-app native keeps its fake provider).
- **Connect** (`Stripe-Account`, application fees, transfers), tax, shipping, Radar, mandates,
  meters, quotes, credit notes, payouts, and non-card payment methods (bank debits, wallets).
- **Smart retries / dunning**: a failed renewal goes `past_due` once; later automatic retries,
  `unpaid` and dunning emails are not run.
- **Proration arithmetic** is day-fraction approximate (Stripe prorates to the second);
  `auto_advance` drafts are not finalized an hour later.
- **Webhook endpoint `api_version`**: payloads render at the account's version, not per endpoint.
- **Live keys** (`sk_live_…`) are refused with Stripe's 401: the mock is test mode only.
- Operations marked unsupported in SUPPORT.md (charge create/update, checkout session update,
  dispute evidence).
- Rate-limit, 5xx and permission bodies come from presets, worded as Stripe words them but not
  recorded from traffic.

## Development

For contributors to the mockingbird repo only; these scripts are not shipped in the npm package.

```bash
bun test                   # self-parity, acceptance (via test/consumer.ts), stripe-node drop-in, contract
bun run parity             # live differential parity against Stripe test mode (safe operations)
bun run parity -- --include-unsafe --only PostCustomers,GetCustomers
bun run client-parity      # stripe-node smoke proof with webhook signature verification
bun run vendor             # re-vendor openapi.yaml from the pinned upstream spec
```

Live parity loads `MOCKINGBIRD_STRIPE_SECRET_KEY` (a `sk_test_` key) from the environment (`.env.local`,
or the repo secret via `bun run parity:remote -- stripe`) and exits 2 without one. By default it walks only safe operations and
leaves out account-global ones (account profile, lifetime balance, lingering test clocks and
webhook endpoints).

Part of [mockingbird](https://github.com/crvouga/mockingbird) — agent integration guide: [README](https://github.com/crvouga/mockingbird#readme) · [llms.txt](https://github.com/crvouga/mockingbird/blob/main/llms.txt) · [report an issue or request a feature](https://github.com/crvouga/mockingbird/blob/main/docs/REPORTING_ISSUES.md).
