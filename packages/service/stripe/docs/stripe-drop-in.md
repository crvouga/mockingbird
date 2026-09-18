# Stripe mock drop-in: scope and proof

The mock is a **server-side** Stripe replacement for a consumer's end-to-end suites: REST plus
webhook delivery, driven by the vendored contract, with per-API-key account isolation.

## What "drop-in" means here

- Every operation the e2e suites reach is implemented with Stripe-faithful shapes, pagination
  (`limit`/`starting_after`/`ending_before`/`has_more`), expansions, error taxonomy and idempotency.
- Two test API keys behave like two accounts: an object created with one is `resource_missing` on
  the other.
- Webhook events are recorded and delivered with a `Stripe-Signature` header the official SDK
  accepts; `GET /v1/events` serves the ledger for replay sweeps.
- Not covered: browser Stripe.js and hosted checkout (`js.stripe.com`, `checkout.stripe.com`) —
  UI-level checkout scenarios keep using real Stripe test mode.

## Proof

All offline, no credentials:

```bash
bun test                                  # self-parity + auth/idempotency + namespace suites
bun test stripe.qa.seed.property.test.ts
bun run mock:server                       # serve over HTTP (port 12111)
bun run client-parity                     # stripe-node client smoke + webhook signature check
```

`stripe.qa.seed.property.test.ts` warms a reference instance with coverage-guided dynamic walks,
hands its state to a fresh instance (`seedMock`), then walks both in lockstep and fails on any
divergence or non-conforming response. It also asserts that **every operation needing no
pre-existing resource** (35 of the 88 supported operations: all creates and lists) is exercised;
measured coverage with a 400-step budget is 52 of 88, the remainder being by-id operations that
appear opportunistically as the walk creates ids. `scripts/client-parity.ts` drives the mock through
stripe-node with `{host, port, protocol}` — the same construction a Node service uses — and verifies
a delivered webhook with `stripe.webhooks.constructEventAsync`.

Live differential parity stays opt-in (it needs a real `sk_test_` key and mutates a shared test
account):

```bash
MOCKINGBIRD_STRIPE_SECRET_KEY=sk_test_… bun run parity
MOCKINGBIRD_STRIPE_SECRET_KEY=sk_test_… bun run parity -- --only GetPrices,GetProducts
```

Seeded live parity (`--mode seed`) is **not** implemented: it would need an account-import path the
mock does not have, so a seeded run would compare against an unseeded mock. Webhook parity is not
implemented either (it needs a publicly reachable receiver).

## Serving it for a suite

```bash
PORT=12111 \
MOCKINGBIRD_STRIPE_WEBHOOK_TARGETS='[{"apiKey":"sk_test_mso","url":"http://127.0.0.1:3100/billing/webhooks/stripe/mso","secret":"whsec_…"},{"apiKey":"sk_test_pc","url":"http://127.0.0.1:3100/billing/webhooks/stripe/pc","secret":"whsec_…"}]' \
bun run mock:server
```

Events are matched to a target by the API key that produced them. Without a matching target the
event is still recorded (and readable through `GET /v1/events`) but not delivered.
`MOCKINGBIRD_STRIPE_WEBHOOK_URL` + `MOCKINGBIRD_STRIPE_WEBHOOK_SECRET` configure a single fallback
target. Signing uses the `whsec_` secret verbatim, exactly as the official SDK verifies it.

Wiring a consumer onto this server is the checklist in [qa-followon.md](./qa-followon.md).
