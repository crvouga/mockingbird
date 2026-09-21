# Customer.io CDP + App API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **10**
- supported by the mock: **10**
- parity enabled: **10**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `CdpIdentify` | `POST /v1/identify` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CdpTrack` | `POST /v1/track` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CdpBatch` | `POST /v1/batch` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `SendEmail` | `POST /v1/send/email` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `SendSms` | `POST /v1/send/sms` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `SendInboxMessage` | `POST /v1/send/inbox_message` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListTransactionalMessages` | `GET /v1/transactional` | ✅ supported | ✅ |  |
| `GetTransactionalMessage` | `GET /v1/transactional/{transactional_id}` | ✅ supported | ✅ |  |
| `FollowClick` | `GET /click/{linkId}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ReportClick` | `POST /click/{linkId}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
