# Junction Lab reference

This directory is the local contract notebook for the Junction Lab Testing API implemented by this service. It is intentionally curated from the public Junction documentation and does not claim to implement every Junction product or endpoint.

## Sources

- [Lab introduction](https://docs.junction.com/lab/overview/introduction)
- [Orders and results](https://docs.junction.com/lab/overview/orders-and-results)
- [Create order](https://docs.junction.com/api-reference/lab-testing/create-order)
- [Get order](https://docs.junction.com/api-reference/lab-testing/get-order)
- [Get order transaction](https://docs.junction.com/api-reference/lab-testing/order-transactions/get-order-transaction)
- [Get transaction results](https://docs.junction.com/api-reference/lab-testing/results/get-order-transaction-results)
- [Webhook introduction](https://docs.junction.com/webhooks/introduction)
- [Webhook event structure](https://docs.junction.com/webhooks/event-structure)
- [Webhook retry policy](https://docs.junction.com/webhooks/retry-policy)
- [Rate limiting](https://docs.junction.com/api-details/rate_limiting)

## Contents

- [Behavior](./behavior.md) — concepts, lifecycle rules, status semantics, and integration guidance
- [Support matrix](./support-matrix.md) — modeled, synthetic, and intentionally unsupported behavior
- [geviti coverage](./geviti-coverage.md) — catalog of geviti-monorepo Junction call sites and mock coverage

## Scope

The service focuses on the team-scoped user and Lab Testing workflow. Wearables, Sense, Junction Connect, Management API, ETL pipelines, and provider-specific lab account administration remain outside this package's implementation scope.

The mock uses deterministic identifiers and an injected clock. Result data, physician data, catalog entries, and the fixed team identifier are synthetic fixtures suitable for tests, not production data.
