# Nucleus API v2.0 (Gene by Gene), vendored for Mockingbird — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **51**
- supported by the mock: **30**
- parity enabled: **29**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `ListAttributeDefinitions` | `GET /api/v2/attributes` | ✅ supported | ✅ |  |
| `ListAttributeDefinitionsByEntityType` | `GET /api/v2/attributes/{entityType}` | ❌ unsupported | — | Our consumer never calls this endpoint (GXG/transport/gxg-client.ts). |
| `ListAttributeGroups` | `GET /api/v2/attributes/groups` | ❌ unsupported | — | Our consumer never calls this endpoint (GXG/transport/gxg-client.ts). |
| `GetAttributeGroup` | `GET /api/v2/attributes/groups/{name}` | ❌ unsupported | — | Our consumer never calls this endpoint (GXG/transport/gxg-client.ts). |
| `CreateEhrOrder` | `POST /api/v2/ehr/order` | ❌ unsupported | — | HL7 ORM ordering path; our consumer orders through POST /api/v2/orders only. |
| `GetEhrResults` | `GET /api/v2/ehr/results` | ❌ unsupported | — | HL7 ORU results path; our consumer reads results through /api/v2/results. |
| `ListEventTypes` | `GET /api/v2/eventTypes` | ✅ supported | ✅ |  |
| `ListFulfillments` | `GET /api/v2/fulfillments` | ✅ supported | ✅ |  |
| `UpdateShipmentAddress` | `POST /api/v2/fulfillments/actions/updateShipmentAddress` | ✅ supported | ⚠️ unsafe (opt-in) | Unsafe against a real tenant: changes where a real kit ships. |
| `CancelFulfillment` | `DELETE /api/v2/fulfillments/{id}` | ✅ supported | ⚠️ unsafe (opt-in) | Unsafe against a real tenant: cancels a real fulfillment. |
| `GetShippingOptions` | `POST /api/v2/fulfillments/actions/getShippingOptions` | ✅ supported | ✅ |  |
| `ListKitOrderLines` | `GET /api/v2/kitorderlines` | ✅ supported | ✅ |  |
| `CancelKitOrderLinesBulk` | `DELETE /api/v2/kitorderlines` | ❌ unsupported | — | Our consumer cancels per kit (DELETE /api/v2/kits/{kitNumber}/orderLines), never in bulk. |
| `ListKitOrderLineKits` | `GET /api/v2/kitorderlines/kits` | ✅ supported | ✅ |  |
| `DownloadKitOrderLines` | `GET /api/v2/kitorderlines/download` | ❌ unsupported | — | Our consumer never calls this endpoint (GXG/transport/gxg-client.ts). |
| `ListKits` | `GET /api/v2/kits` | ✅ supported | ✅ |  |
| `GetKit` | `GET /api/v2/kits/{kitNumber}` | ✅ supported | ✅ |  |
| `DeleteKit` | `DELETE /api/v2/kits/{kitNumber}` | ❌ unsupported | — | Our consumer never calls this endpoint (GXG/transport/gxg-client.ts). |
| `CancelKitOrderLines` | `DELETE /api/v2/kits/{kitNumber}/orderLines` | ✅ supported | ⚠️ unsafe (opt-in) | Unsafe against a real tenant: cancels a real kit. |
| `SetKitGender` | `PATCH /api/v2/kits/{kitNumber}/gender/{gender}` | ❌ unsupported | — | Superseded by PATCH /api/v2/kits/{kitNumber}/attributes, which our consumer uses. |
| `ListKitOrders` | `GET /api/v2/kits/{kitNumber}/orders` | ❌ unsupported | — | Our consumer never calls this endpoint (GXG/transport/gxg-client.ts). |
| `GetKitResults` | `GET /api/v2/kits/{kitNumber}/results` | ✅ supported | ✅ |  |
| `ClearKitAttributes` | `DELETE /api/v2/kits/{kitNumber}/attributes` | ❌ unsupported | — | Our consumer never calls this endpoint (GXG/transport/gxg-client.ts). |
| `SetKitAttributes` | `PATCH /api/v2/kits/{kitNumber}/attributes` | ✅ supported | ⚠️ unsafe (opt-in) | Unsafe against a real tenant: writes demographics onto a real kit. |
| `SetKitAttribute` | `PATCH /api/v2/kits/{kitNumber}/attributes/{name}={value}` | ❌ unsupported | — | Our consumer never calls this endpoint (GXG/transport/gxg-client.ts). |
| `DeleteKitAttribute` | `DELETE /api/v2/kits/{kitNumber}/attribute/{attributeName}` | ❌ unsupported | — | Our consumer never calls this endpoint (GXG/transport/gxg-client.ts). |
| `UploadKitAttributesCsv` | `POST /api/v2/kits/actions/uploadKitAttributesCSV` | ❌ unsupported | — | Our consumer never calls this endpoint (GXG/transport/gxg-client.ts). |
| `UploadKitDocument` | `POST /api/v2/kits/actions/{kitNumber}/uploadDocuments/{documentType}` | ❌ unsupported | — | Our consumer never calls this endpoint (GXG/transport/gxg-client.ts). |
| `ListNotificationSubscriptions` | `GET /api/v2/notificationSubscriptions` | ✅ supported | ✅ |  |
| `CreateNotificationSubscription` | `POST /api/v2/notificationSubscriptions` | ✅ supported | ⚠️ unsafe (opt-in) | Unsafe against a real tenant: registers a live webhook on the shared tenant. |
| `GetNotificationSubscription` | `GET /api/v2/notificationSubscriptions/{id}` | ✅ supported | ✅ |  |
| `DeleteNotificationSubscription` | `DELETE /api/v2/notificationSubscriptions/{id}` | ✅ supported | ⚠️ unsafe (opt-in) | Unsafe against a real tenant: deletes a live webhook. |
| `UpdateNotificationSubscription` | `PATCH /api/v2/notificationSubscriptions/{id}` | ✅ supported | ⚠️ unsafe (opt-in) | Unsafe against a real tenant: repoints a live webhook. |
| `ResetNotificationSubscriptionSecret` | `POST /api/v2/notificationSubscriptions/{id}/actions/resetSecret` | ❌ unsupported | — | Our consumer rotates a secret by deleting and re-creating the subscription. |
| `ListUserNotificationSubscriptions` | `GET /api/v2/notificationSubscriptions/user/{id}/tenant/{tenantId}` | ❌ unsupported | — | Our consumer never calls this endpoint (GXG/transport/gxg-client.ts). |
| `GetOrderLine` | `GET /api/v2/orderLines/{id}` | ✅ supported | ✅ |  |
| `CancelOrderLine` | `DELETE /api/v2/orderLines/{id}` | ✅ supported | ⚠️ unsafe (opt-in) | Unsafe against a real tenant: cancels a real order line. |
| `ListOrderLineKits` | `GET /api/v2/orderLines/{id}/kits` | ❌ unsupported | — | Our consumer never calls this endpoint (GXG/transport/gxg-client.ts). |
| `ListOrders` | `GET /api/v2/orders` | ✅ supported | ✅ |  |
| `CreateOrder` | `POST /api/v2/orders` | ✅ supported | ⚠️ unsafe (opt-in) | Unsafe against a real tenant: places a real order (and ships a kit). |
| `GetOrder` | `GET /api/v2/orders/{id}` | ✅ supported | ✅ |  |
| `CreateOrderForExistingKits` | `POST /api/v2/orders/actions/createOrderForExistingKits` | ✅ supported | ⚠️ unsafe (opt-in) | Unsafe against a real tenant: places a real lab order. |
| `ListProducts` | `GET /api/v2/products` | ✅ supported | ✅ |  |
| `ListResults` | `GET /api/v2/results` | ✅ supported | ✅ |  |
| `AddKitResult` | `POST /api/v2/results` | ❌ unsupported | — | Lab-side result ingestion; the mock publishes results through POST /__admin/kits/:kitNumber/transition. |
| `SearchResults` | `GET /api/v2/results/search` | ✅ supported | ✅ |  |
| `DownloadResultsCsv` | `GET /api/v2/results/csvDownloads` | ❌ unsupported | — | Our consumer never calls this endpoint (GXG/transport/gxg-client.ts). |
| `GetResultUrl` | `GET /api/v2/results/results/{resultId}/url` | ❌ unsupported | — | Our consumer never calls this endpoint (GXG/transport/gxg-client.ts). |
| `GetResultPresignedUrl` | `GET /api/v2/results/results/presignedUrl` | ✅ supported | ✅ |  |
| `PostConnectToken` | `POST /connect/token` | ✅ supported | ✅ |  |
| `GetResultBlob` | `GET /__blob/{key}` | ✅ supported | ❌ disabled | Mock-only route; the real presigned URL points at S3, not the API host. |
