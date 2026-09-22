# Flex HSA/FSA payments API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **13**
- supported by the mock: **13**
- parity enabled: **10**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `ListProducts` | `GET /v1/products` | ✅ supported | ✅ |  |
| `CreateProduct` | `POST /v1/products` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetProduct` | `GET /v1/products/{productId}` | ✅ supported | ✅ |  |
| `UpdateProduct` | `PATCH /v1/products/{productId}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListCheckoutSessions` | `GET /v1/checkout/sessions` | ✅ supported | ✅ |  |
| `CreateCheckoutSession` | `POST /v1/checkout/sessions` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetCheckoutSession` | `GET /v1/checkout/sessions/{sessionId}` | ✅ supported | ✅ |  |
| `RefundCheckoutSession` | `POST /v1/checkout/sessions/{sessionId}/refund` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CreateCustomer` | `POST /v1/customers` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetSetupIntent` | `GET /v1/setup_intents/{setupIntentId}` | ✅ supported | ✅ |  |
| `HostedCheckoutPage` | `GET /pay/{sessionId}` | ✅ supported | ❌ disabled | A browser-facing HTML page; covered by the acceptance suite, not by JSON walks. |
| `SubmitHostedCheckout` | `POST /pay/{sessionId}` | ✅ supported | ❌ disabled | A browser form post; covered by the acceptance suite. |
| `CancelHostedCheckout` | `GET /pay/{sessionId}/cancel` | ✅ supported | ❌ disabled | A browser navigation to cancel_url; covered by the acceptance suite. |
