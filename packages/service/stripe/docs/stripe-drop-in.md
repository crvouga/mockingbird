# Stripe mock drop-in: scope and proof

The mock replaces Stripe for a consumer's end-to-end suites: the REST API (at `2024-06-20`,
`2025-02-24.acacia` and the vendored latest version), accounts chosen by API key, signed webhook
delivery, clock-driven renewals and expiries, a hosted Checkout page and a Stripe.js stand-in.

## Proof

All offline, no credentials:

```bash
bun test                        # everything below
bun test stripe.property.test.ts        # self-parity; pinned walks exercise every parity-enabled op
bun test stripe.qa.seed.property.test.ts # seeded lockstep walks over the QA surface
bun test stripe.acceptance.test.ts      # catalog S1 acceptance through test/consumer.ts
bun test stripe.sdk.test.ts             # stripe-node 16.12 at both versions + 17.7: every S1.4 op
bun test stripe.contract.test.ts        # health, namespaces, presets, HMAC, journal hygiene
bun run client-parity                   # stripe-node smoke with webhook signature verification
```

- **Self-parity**: two independent instances agree on random OpenAPI-driven walks and every mock
  response conforms to the vendored contract; six pinned coverage-biased walks together exercise
  every parity-enabled operation.
- **Acceptance** drives the mock through a port of our backend's client logic
  (`test/consumer.ts`): legacy/MSO shared state, PC isolation with Stripe's exact 404, idempotency
  (replay, `idempotency_error`, 409 `idempotency_key_in_use`), webhooks verified with
  `stripe.webhooks.constructEvent` (and `checkout.session.completed` within 100 ms of the hosted
  page's Pay), a subscription cycle on clock advance, and `tok_chargeCustomerFail` declining with
  the `payment_intent` embedded.
- **SDK drop-in** walks every S1.4 operation with stripe-node pointed at the mock by
  `host`/`port`/`protocol` only, and checks the mock's request journal saw each one answer 2xx.

Live differential parity (`bun run parity`, `STRIPE_SECRET_KEY` from the
environment) walks the safe operations against Stripe test mode; `--include-unsafe` adds money movement.

## Serving it for a suite

```bash
npx mockingbird-stripe serve --accounts accounts.json
curl -X PUT localhost:12111/__admin/webhook-endpoints -H 'content-type: application/json' \
  -d '[{"account":"acct_mso","url":"http://127.0.0.1:3100/billing/webhooks/stripe/mso","secret":"whsec_…"},
       {"account":"acct_pc","url":"http://127.0.0.1:3100/billing/webhooks/stripe/pc","secret":"whsec_…"}]'
```

`bun run mock:server` (scripts/server.ts, `MOCKINGBIRD_STRIPE_WEBHOOK_TARGETS`) remains for
contributors. Wiring a consumer onto the mock is the checklist in [qa-followon.md](./qa-followon.md).
