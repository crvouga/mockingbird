# Fullscript API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **10**
- supported by the mock: **10**
- parity enabled: **8**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `OAuthToken` | `POST /api/oauth/token` | ✅ supported | ✅ |  |
| `OAuthRevoke` | `POST /api/oauth/revoke` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetClinic` | `GET /api/clinic` | ✅ supported | ✅ |  |
| `CreateSessionGrant` | `POST /api/clinic/embeddable/session_grants` | ✅ supported | ✅ |  |
| `ListLabOrders` | `GET /api/clinic/labs/orders` | ✅ supported | ✅ |  |
| `GetLabOrder` | `GET /api/clinic/labs/orders/{orderId}` | ✅ supported | ✅ |  |
| `ListLabOrderEvents` | `GET /api/events/lab_orders` | ✅ supported | ✅ |  |
| `GetEvent` | `GET /api/events/{eventId}` | ✅ supported | ✅ |  |
| `Authorize` | `GET /oauth/authorize` | ✅ supported | ❌ disabled | Browser redirect flow; covered by acceptance tests. |
| `GetResultPdf` | `GET /results/{artifactId}` | ✅ supported | ❌ disabled | Binary PDF behind an expiring signed URL; covered by acceptance tests. |
