# @crvouga/mockingbird-service-stripe

Stateful mock of the [Stripe API](https://docs.stripe.com/api) driven by its OpenAPI contract and
verified by differential property tests: customers, payment methods, payment/setup intents, charges,
refunds, disputes, checkout sessions, invoices, subscriptions, coupons and promotion codes, plus a
webhook event ledger with signed delivery.

- Stripe API reference: https://docs.stripe.com/api
- Test / sandbox keys: https://docs.stripe.com/keys
- Upstream OpenAPI: https://github.com/stripe/openapi
- Coverage: [SUPPORT.md](./SUPPORT.md) · [QA coverage](./docs/qa-coverage.md)
- Scope and proof: [drop-in scope](./docs/stripe-drop-in.md) · [consumer wiring](./docs/qa-followon.md)

```ts
import { StripeAPI } from "@crvouga/mockingbird-service-stripe"

const stripe = new StripeAPI()
await stripe.fetch(
  new Request("https://mock.stripe.local/v1/customers", {
    body: new URLSearchParams({ email: "qa@example.com" }),
    headers: {
      authorization: "Bearer sk_test_mockingbird",
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  }),
)
```

State is partitioned per bearer key: two test keys behave like two accounts, so an object created
with one is `resource_missing` on the other.

Serve it over HTTP and deliver its webhooks:

```bash
PORT=12111 MOCKINGBIRD_STRIPE_WEBHOOK_TARGETS='[{"apiKey":"sk_test_mso","url":"http://127.0.0.1:3100/billing/webhooks/stripe/mso","secret":"whsec_…"}]' bun run mock:server
bun run client-parity   # stripe-node smoke proof, including webhook signature verification
```

Live parity against Stripe test mode:

```bash
bun run parity
# MOCKINGBIRD_STRIPE_SECRET_KEY=sk_test_... bun run parity
```
