# Kill Bill Billing API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **5**
- supported by the mock: **5**
- parity enabled: **5**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `ReadResource` | `GET /1.0/kb/{resource}` | ✅ supported | ✅ |  |
| `CreateResource` | `POST /1.0/kb/{resource}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetResource` | `GET /1.0/kb/{resource}/{id}` | ✅ supported | ✅ |  |
| `UpdateResource` | `PUT /1.0/kb/{resource}/{id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteResource` | `DELETE /1.0/kb/{resource}/{id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
