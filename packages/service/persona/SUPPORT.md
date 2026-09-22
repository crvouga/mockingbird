# Persona API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **5**
- supported by the mock: **5**
- parity enabled: **3**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `ListInquiries` | `GET /inquiries` | ✅ supported | ✅ |  |
| `CreateInquiry` | `POST /inquiries` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetInquiry` | `GET /inquiries/{inquiryId}` | ✅ supported | ✅ |  |
| `HostedFlow` | `GET /verify` | ✅ supported | ❌ disabled | A browser page that mutates state; exercised by the acceptance tests. |
| `HostedFlowComplete` | `GET /verify/complete` | ✅ supported | ❌ disabled | A browser redirect that mutates state; exercised by the acceptance tests. |
