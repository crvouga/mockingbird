# FirstPromoter API v2 (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **17**
- supported by the emulator: **17**
- parity enabled: **17**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `TrackSignup` | `POST /v2/track/signup` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListPromoters` | `GET /v2/company/promoters` | ✅ supported | ✅ |  |
| `CreatePromoter` | `POST /v2/company/promoters` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ArchivePromoters` | `POST /v2/company/promoters/archive` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetPromoter` | `GET /v2/company/promoters/{id}` | ✅ supported | ✅ |  |
| `UpdatePromoter` | `PUT /v2/company/promoters/{id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `IframeLogin` | `POST /v2/promoters/iframe_login` | ✅ supported | ✅ |  |
| `ListReferrals` | `GET /v2/company/referrals` | ✅ supported | ✅ |  |
| `GetReferral` | `GET /v2/company/referrals/{id}` | ✅ supported | ✅ |  |
| `ListCommissions` | `GET /v2/company/commissions` | ✅ supported | ✅ |  |
| `FulfillCommissions` | `POST /v2/company/commissions/mark_fulfilled` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DestroyCommissions` | `DELETE /v2/company/commissions/destroy` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `UpdateCommission` | `PUT /v2/company/commissions/{id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListBatchProcesses` | `GET /v2/company/batch_processes` | ✅ supported | ✅ |  |
| `BatchProcessProgress` | `GET /v2/company/batch_processes/progress` | ✅ supported | ✅ |  |
| `GetBatchProcess` | `GET /v2/company/batch_processes/{id}` | ✅ supported | ✅ |  |
| `TrackSale` | `POST /v2/track/sale` | ✅ supported | ⚠️ unsafe (opt-in) |  |
