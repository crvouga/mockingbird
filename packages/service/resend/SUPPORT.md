# Resend API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **5**
- supported by the mock: **5**
- parity enabled: **5**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `SendEmail` | `POST /emails` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetEmail` | `GET /emails/{email_id}` | ✅ supported | ✅ |  |
| `GetReceivedEmail` | `GET /emails/receiving/{email_id}` | ✅ supported | ✅ |  |
| `ListReceivedEmailAttachments` | `GET /emails/receiving/{email_id}/attachments` | ✅ supported | ✅ |  |
| `DownloadReceivedAttachment` | `GET /downloads/inbound/{attachment_id}` | ✅ supported | ✅ |  |
