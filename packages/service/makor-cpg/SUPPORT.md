# Legacy Makor AI API "CPG" (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **11**
- supported by the mock: **11**
- parity enabled: **11**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `GetCurrentCarePlan` | `GET /api/care-plans/current-care-plan-details/{userId}` | ✅ supported | ✅ |  |
| `UpdatePlusUser` | `PATCH /api/care-plans/plus-user/{userId}` | ✅ supported | ✅ |  |
| `BloodworkResultsReceived` | `POST /api/bloodwork/webhook` | ✅ supported | ✅ |  |
| `CancelSubscription` | `POST /api/subscription/cancel/{userId}` | ✅ supported | ✅ |  |
| `GetSubscriptionStatus` | `GET /api/subscription/status/{userId}` | ✅ supported | ✅ |  |
| `GetWholescriptsOrders` | `GET /api/wholescripts-orders/user/{userId}` | ✅ supported | ✅ |  |
| `GenerateUserSummary` | `POST /api/v2/generate-user-summary` | ✅ supported | ✅ |  |
| `GetUserSummary` | `GET /api/v2/user-summary/{cpgUserId}` | ✅ supported | ✅ |  |
| `GetReviewScript` | `GET /api/async-review-script/{userId}/{labTestId}` | ✅ supported | ✅ |  |
| `GenerateReviewScript` | `POST /api/async-review-script/generate` | ✅ supported | ✅ |  |
| `RegenerateReviewScript` | `POST /api/async-review-script/regenerate/{userId}/{labTestId}` | ✅ supported | ✅ |  |
