# Customer.io CDP + App API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **15**
- supported by the emulator: **15**
- parity enabled: **15**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `CdpIdentify` | `POST /v1/identify` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CdpTrack` | `POST /v1/track` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CdpBatch` | `POST /v1/batch` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `SendEmail` | `POST /v1/send/email` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `SendSms` | `POST /v1/send/sms` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `SendPush` | `POST /v1/send/push` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `SendInboxMessage` | `POST /v1/send/inbox_message` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListTransactionalMessages` | `GET /v1/transactional` | ✅ supported | ✅ |  |
| `GetTransactionalMessage` | `GET /v1/transactional/{transactional_id}` | ✅ supported | ✅ |  |
| `GetCustomerAttributes` | `GET /v1/customers/{customer_id}/attributes` | ✅ supported | ✅ |  |
| `ListOptOuts` | `GET /v1/optouts` | ✅ supported | ✅ |  |
| `GetCustomerOptOuts` | `GET /v1/customers/{customer_id}/optouts` | ✅ supported | ✅ |  |
| `GetMessage` | `GET /v1/messages/{message_id}` | ✅ supported | ✅ |  |
| `FollowClick` | `GET /click/{linkId}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ReportClick` | `POST /click/{linkId}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
