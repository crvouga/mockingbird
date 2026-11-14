# Customer.io CDP + App API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **24**
- supported by the emulator: **24**
- parity enabled: **24**

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
| `ListReportingWebhooks` | `GET /v1/reporting_webhooks` | ✅ supported | ✅ | Best guess from vendor docs, not oracle-verified. |
| `ListSubscriptionTopics` | `GET /v1/subscription_topics` | ✅ supported | ✅ | Best guess from vendor docs, not oracle-verified. |
| `ExportCustomers` | `POST /v1/exports/customers` | ✅ supported | ⚠️ unsafe (opt-in) | Best guess from vendor docs, not oracle-verified. |
| `GetExport` | `GET /v1/exports/{export_id}` | ✅ supported | ✅ | Best guess from vendor docs, not oracle-verified. |
| `DownloadExport` | `GET /v1/exports/{export_id}/download` | ✅ supported | ✅ | Best guess from vendor docs, not oracle-verified. |
| `ListSnippets` | `GET /v1/snippets` | ✅ supported | ✅ | Best guess from vendor docs, not oracle-verified. |
| `ListCampaigns` | `GET /v1/campaigns` | ✅ supported | ✅ | Best guess from vendor docs, not oracle-verified. |
| `ListNewsletters` | `GET /v1/newsletters` | ✅ supported | ✅ | Best guess from vendor docs, not oracle-verified. |
| `ListSenderIdentities` | `GET /v1/sender_identities` | ✅ supported | ✅ | Best guess from vendor docs, not oracle-verified. |
| `FollowClick` | `GET /click/{linkId}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ReportClick` | `POST /click/{linkId}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
