# Nucleus API v2.0 (Gene by Gene), vendored for Mockingbird — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **51**
- supported by the emulator: **30**
- parity enabled: **29**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `ListAttributeDefinitions` | `GET /api/v2/attributes` | ✅ supported | ✅ |  |
| `ListAttributeDefinitionsByEntityType` | `GET /api/v2/attributes/{entityType}` | ❌ unsupported | — | This operation is outside the supported subset. |
| `ListAttributeGroups` | `GET /api/v2/attributes/groups` | ❌ unsupported | — | This operation is outside the supported subset. |
| `GetAttributeGroup` | `GET /api/v2/attributes/groups/{name}` | ❌ unsupported | — | This operation is outside the supported subset. |
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
| `DownloadKitOrderLines` | `GET /api/v2/kitorderlines/download` | ❌ unsupported | — | This operation is outside the supported subset. |
| `ListKits` | `GET /api/v2/kits` | ✅ supported | ✅ |  |
| `GetKit` | `GET /api/v2/kits/{kitNumber}` | ✅ supported | ✅ |  |
| `DeleteKit` | `DELETE /api/v2/kits/{kitNumber}` | ❌ unsupported | — | This operation is outside the supported subset. |
| `CancelKitOrderLines` | `DELETE /api/v2/kits/{kitNumber}/orderLines` | ✅ supported | ⚠️ unsafe (opt-in) | Unsafe against a real tenant: cancels a real kit. |
| `SetKitGender` | `PATCH /api/v2/kits/{kitNumber}/gender/{gender}` | ❌ unsupported | — | Superseded by PATCH /api/v2/kits/{kitNumber}/attributes, which our consumer uses. |
| `ListKitOrders` | `GET /api/v2/kits/{kitNumber}/orders` | ❌ unsupported | — | This operation is outside the supported subset. |
| `GetKitResults` | `GET /api/v2/kits/{kitNumber}/results` | ✅ supported | ✅ |  |
| `ClearKitAttributes` | `DELETE /api/v2/kits/{kitNumber}/attributes` | ❌ unsupported | — | This operation is outside the supported subset. |
| `SetKitAttributes` | `PATCH /api/v2/kits/{kitNumber}/attributes` | ✅ supported | ⚠️ unsafe (opt-in) | Unsafe against a real tenant: writes demographics onto a real kit. |
| `SetKitAttribute` | `PATCH /api/v2/kits/{kitNumber}/attributes/{name}={value}` | ❌ unsupported | — | This operation is outside the supported subset. |
| `DeleteKitAttribute` | `DELETE /api/v2/kits/{kitNumber}/attribute/{attributeName}` | ❌ unsupported | — | This operation is outside the supported subset. |
| `UploadKitAttributesCsv` | `POST /api/v2/kits/actions/uploadKitAttributesCSV` | ❌ unsupported | — | This operation is outside the supported subset. |
| `UploadKitDocument` | `POST /api/v2/kits/actions/{kitNumber}/uploadDocuments/{documentType}` | ❌ unsupported | — | This operation is outside the supported subset. |
| `ListNotificationSubscriptions` | `GET /api/v2/notificationSubscriptions` | ✅ supported | ✅ |  |
| `CreateNotificationSubscription` | `POST /api/v2/notificationSubscriptions` | ✅ supported | ⚠️ unsafe (opt-in) | Unsafe against a real tenant: registers a live webhook on the shared tenant. |
| `GetNotificationSubscription` | `GET /api/v2/notificationSubscriptions/{id}` | ✅ supported | ✅ |  |
| `DeleteNotificationSubscription` | `DELETE /api/v2/notificationSubscriptions/{id}` | ✅ supported | ⚠️ unsafe (opt-in) | Unsafe against a real tenant: deletes a live webhook. |
| `UpdateNotificationSubscription` | `PATCH /api/v2/notificationSubscriptions/{id}` | ✅ supported | ⚠️ unsafe (opt-in) | Unsafe against a real tenant: repoints a live webhook. |
| `ResetNotificationSubscriptionSecret` | `POST /api/v2/notificationSubscriptions/{id}/actions/resetSecret` | ❌ unsupported | — | Our consumer rotates a secret by deleting and re-creating the subscription. |
| `ListUserNotificationSubscriptions` | `GET /api/v2/notificationSubscriptions/user/{id}/tenant/{tenantId}` | ❌ unsupported | — | This operation is outside the supported subset. |
| `GetOrderLine` | `GET /api/v2/orderLines/{id}` | ✅ supported | ✅ |  |
| `CancelOrderLine` | `DELETE /api/v2/orderLines/{id}` | ✅ supported | ⚠️ unsafe (opt-in) | Unsafe against a real tenant: cancels a real order line. |
| `ListOrderLineKits` | `GET /api/v2/orderLines/{id}/kits` | ❌ unsupported | — | This operation is outside the supported subset. |
| `ListOrders` | `GET /api/v2/orders` | ✅ supported | ✅ |  |
| `CreateOrder` | `POST /api/v2/orders` | ✅ supported | ⚠️ unsafe (opt-in) | Unsafe against a real tenant: places a real order (and ships a kit). |
| `GetOrder` | `GET /api/v2/orders/{id}` | ✅ supported | ✅ |  |
| `CreateOrderForExistingKits` | `POST /api/v2/orders/actions/createOrderForExistingKits` | ✅ supported | ⚠️ unsafe (opt-in) | Unsafe against a real tenant: places a real lab order. |
| `ListProducts` | `GET /api/v2/products` | ✅ supported | ✅ |  |
| `ListResults` | `GET /api/v2/results` | ✅ supported | ✅ |  |
| `AddKitResult` | `POST /api/v2/results` | ❌ unsupported | — | Lab-side result ingestion; the mock publishes results through POST /__admin/kits/:kitNumber/transition. |
| `SearchResults` | `GET /api/v2/results/search` | ✅ supported | ✅ |  |
| `DownloadResultsCsv` | `GET /api/v2/results/csvDownloads` | ❌ unsupported | — | This operation is outside the supported subset. |
| `GetResultUrl` | `GET /api/v2/results/results/{resultId}/url` | ❌ unsupported | — | This operation is outside the supported subset. |
| `GetResultPresignedUrl` | `GET /api/v2/results/results/presignedUrl` | ✅ supported | ✅ |  |
| `PostConnectToken` | `POST /connect/token` | ✅ supported | ✅ |  |
| `GetResultBlob` | `GET /__admin/blobs/{key}` | ✅ supported | ❌ disabled | Mock-only route; the real presigned URL points at S3, not the API host. |
