# RxVortex (Strive) pharmacy API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **5**
- supported by the mock: **5**
- parity enabled: **5**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `GenerateAccessToken` | `POST /api/v1/generate-access-token` | ✅ supported | ✅ |  |
| `CreateOrder` | `POST /api/v1/orders` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetOrder` | `GET /api/v1/orders/{orderId}` | ✅ supported | ✅ |  |
| `CancelOrder` | `DELETE /api/v1/orders/{orderId}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListPresetCatalogItems` | `GET /api/v1/preset-catalog-items` | ✅ supported | ✅ |  |
