# @crvouga/mockingbird-service-stripe

Stateful drop-in mock of the [Stripe API](https://docs.stripe.com/api): customers, products, prices, PaymentIntents, SetupIntents, PaymentMethods, charges, refunds, subscriptions, invoices, Checkout, billing portal, and the Stripe.js Elements session used by Payment Element.

Point official Stripe SDKs at this server (`host` / `protocol` on stripe-node, or any client that can set the API base URL). Publishable keys are accepted on the client routes Stripe.js calls (`/v1/elements/sessions`, `/v1/confirmation_tokens`, `/v1/payment_methods`, payment-intent confirm). Test cards (`4242424242424242`, `pm_card_visa`, `tok_visa`, and the documented decline numbers) behave like Stripe test mode.

- Stripe API reference: https://docs.stripe.com/api
- Test / sandbox keys: https://docs.stripe.com/keys
- Upstream OpenAPI: https://github.com/stripe/openapi
- Coverage: [SUPPORT.md](./SUPPORT.md)

```ts
import { StripeAPI } from "@crvouga/mockingbird-service-stripe"

const stripe = new StripeAPI()
```

Live parity against Stripe test mode:

```bash
bun run parity
# MOCKINGBIRD_STRIPE_SECRET_KEY=sk_test_... bun run parity
```
