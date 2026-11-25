# LifeFile API v2, vendored for Mockingbird — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **18**
- supported by the emulator: **18**
- parity enabled: **18**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `IssueToken` | `POST /api/v2/auth/token` | ✅ supported | ✅ |  |
| `RevokeCurrentToken` | `DELETE /api/v2/auth/token` | ✅ supported | ⚠️ unsafe (opt-in) | Revokes the bearer token the run is using. |
| `CurrentApiUser` | `GET /api/v2/auth/me` | ✅ supported | ✅ |  |
| `RotateCurrentSecret` | `POST /api/v2/auth/secret/rotate` | ✅ supported | ⚠️ unsafe (opt-in) | Rotates the real API user's secret and revokes every token it holds. |
| `ListOrders` | `GET /api/v2/orders` | ✅ supported | ✅ |  |
| `CreateOrder` | `POST /api/v2/orders` | ✅ supported | ⚠️ unsafe (opt-in) | Places a real order with the pharmacy. |
| `ShowOrder` | `GET /api/v2/orders/{orderId}` | ✅ supported | ✅ |  |
| `GetOrderStatus` | `GET /api/v2/orders/{orderId}/status` | ✅ supported | ✅ |  |
| `UpdateOrderStatus` | `PUT /api/v2/orders/{orderId}/status` | ✅ supported | ⚠️ unsafe (opt-in) | Moves a real order through the pharmacy's workflow. |
| `GetOrderShipping` | `GET /api/v2/orders/{orderId}/shipping` | ✅ supported | ✅ |  |
| `UpdateOrderShipping` | `PUT /api/v2/orders/{orderId}/shipping` | ✅ supported | ⚠️ unsafe (opt-in) | Changes where a real order ships. |
| `ListLocations` | `GET /api/v2/locations` | ✅ supported | ✅ |  |
| `ShowLocation` | `GET /api/v2/locations/{locationId}` | ✅ supported | ✅ |  |
| `ListLocationShippingConfigurations` | `GET /api/v2/locations/{locationId}/shipping-configurations` | ✅ supported | ✅ |  |
| `ListShippingServices` | `GET /api/v2/shipping-services` | ✅ supported | ✅ |  |
| `ListPracticeShippingServices` | `GET /api/v2/practices/{practiceId}/shipping-services` | ✅ supported | ✅ |  |
| `ListStatuses` | `GET /api/v2/statuses` | ✅ supported | ✅ |  |
| `Ping` | `GET /api/v2/ping` | ✅ supported | ✅ |  |
