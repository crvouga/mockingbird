# Stripe mock coverage catalog

What this mock serves, and what it deliberately does not, for the server-side Stripe usage a
consumer's end-to-end suites rely on. Compiled from a sweep of Stripe call sites, dev-tools
commands, catalog sweeps and webhook handlers in the applications this mock is built to stand in
for (September 2026).

This catalog describes the mock's own contract. It never names the consuming projects: they are
reference points for what had to be modelled, not dependencies of this repository.

- Contract: [`openapi.yaml`](../openapi.yaml) and the generated [`SUPPORT.md`](../SUPPORT.md)
  operation table.
- Proof: `stripe.qa.seed.property.test.ts` (seeded lockstep walk over every supported operation,
  asserting divergence-free behaviour and coverage of all resource-free operations) and
  `scripts/client-parity.ts` (stripe-node client-level smoke, including webhook signature
  verification).

## Consumer call patterns

| Pattern | What it does | Mock coverage |
| --- | --- | --- |
| Billing adapter | MSO/PC clients; charge, refund, customer, balance adjustment | customers, payment methods, payment intents, refunds, customer balance transactions |
| Shop checkout command | PaymentIntent create/confirm/cancel/retrieve, settlement | payment intents (incl. `resource_missing` customer recovery), refunds |
| Stored-card charge command | off-session charge, credit application | payment intents with `confirm`/`off_session`, `pm_card_*` tokens, customer balance transactions, refunds |
| Credit adjustment commands | customer credit adjustments | `customers.createBalanceTransaction`, `customers.retrieve` |
| Customer delete command | cascade delete (schedules, subscriptions, payment methods, customer) | subscriptions, subscription schedules, payment methods, customer delete |
| Purchase listing command | paid-order listing | `invoices.list`, `checkout.sessions.list`, `paymentIntents.list` (with `expand:["data.latest_charge"]`) |
| Catalog service | catalog + coupon sweep, invoice retrieval | products (list/search/retrieve/update), prices (list/retrieve/update), coupons, promotion codes, invoices |
| Catalog dev-tools | catalog repair, offering activation, lab-routing metadata | product/price list+retrieve+update with `has_more` paging, metadata patches |
| Coupon validation service | promotion-code lookup, redemption caps, first-time-transaction probe | promotion codes (`code`/`active`/`limit`), coupons (`applies_to`, `currency_options`), `invoices.list`, `paymentIntents.list` |
| Product/price webhook intake | catalog sync from webhooks | `product.*` / `price.*` events are emitted on mock mutations |
| Webhook controller | webhook dispatch | `payment_intent.succeeded\|canceled\|payment_failed`, `checkout.session.completed\|expired`, `setup_intent.succeeded`, `customer.subscription.created\|updated\|deleted`, `invoice.created\|paid`, `refund.created\|updated`, `product.*`, `price.*`, `customer.*` |
| Event replay worker | replay sweep | `events.list` with `types[]` + `created.gte`, `events/{id}` |
| Direct SDK confirm | `paymentIntents.confirm` | confirm with `pm_card_visa` |
| Account-isolation test | `paymentMethods.create({card:{token}})`, stored-card charge, cross-account 404 | per-key accounts (identical ids are `resource_missing` across keys), `tok_*` tokens |

## Deliberate gaps

See the README's "Deliberately not modelled" section. In short: Connect, tax, shipping, Radar,
mandates, non-card payment methods, smart retries/dunning beyond the first `past_due`, exact
proration arithmetic, per-endpoint webhook API versions, and Stripe.js features our UI does not
call. Hosted checkout, the Stripe.js stand-in, test clocks, webhook endpoints, the balance ledger,
`invoice.payment_failed`, `invoice.upcoming`, `refund.failed` (admin) and
`charge.dispute.created` (admin or `tok_createDispute`) are now modelled.

Re-sweep the consumer whenever a new Stripe call site appears.
