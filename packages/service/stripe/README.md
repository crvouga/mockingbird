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

## What is modelled

- Customers, products and prices: create, retrieve, update, delete (customers keep a
  `deleted: true` tombstone; a product with prices cannot be deleted), cursor pagination with
  `limit`, `starting_after` / `ending_before`, and every list filter of the pinned API version.
- Stripe's form-body validation envelope: unknown parameters, missing and empty parameters,
  per-parameter validation order, the wording of every error the differential runner has met.
- Inline `product_data` on price creation, `transfer_lookup_key` on price create/update,
  metadata limits, decimal amounts, recurring interval caps.
- [Idempotent requests](https://docs.stripe.com/api/idempotent_requests): the first response for
  an `Idempotency-Key` on a POST is replayed (with `Idempotent-Replayed: true`) for identical
  retries; reusing the key with different parameters is an `idempotency_error`.

Not modelled (parameters are marked `x-mockingbird-unsupported` in `openapi.yaml` and the
generator never sends them): expansion, payment sources and methods, tax ids and tax codes,
test clocks, tiered / metered / multi-currency pricing, `default_price`, search endpoints.

## Verification

- `bun test` — self-parity walks (two instances must agree on every random walk and every
  response must match the spec), plus invariant suites for documented list, write, idempotency
  and request-envelope semantics.
- `bun run parity` — the same walk shape against Stripe test mode (`MOCKINGBIRD_STRIPE_SECRET_KEY`
  or Vault). Behaviour added without a live run is listed under "modelled from the docs" below
  until a parity run confirms it.

Modelled from the docs, not yet confirmed live: `product_data` / `transfer_lookup_key`
(including the wording when both `product` and `product_data` are sent), idempotency replay
and its error wording, and the 401 for unauthenticated requests to unknown paths.

```bash
bun run parity
# MOCKINGBIRD_STRIPE_SECRET_KEY=sk_test_... bun run parity
# FC_SEED=1530596075 bun test            # replay a walk
```
