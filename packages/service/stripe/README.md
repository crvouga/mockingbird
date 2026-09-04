# @crvouga/mockingbird-service-stripe

Stateful mock of the [Stripe API](https://docs.stripe.com/api) (customers, products, prices).

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
