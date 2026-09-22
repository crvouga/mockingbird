# AWS Elemental MediaConvert (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **4**
- supported by the mock: **4**
- parity enabled: **4**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `DescribeEndpoints` | `POST /2017-08-29/endpoints` | ✅ supported | ✅ |  |
| `CreateJob` | `POST /2017-08-29/jobs` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetJob` | `GET /2017-08-29/jobs/{id}` | ✅ supported | ✅ |  |
| `CancelJob` | `DELETE /2017-08-29/jobs/{id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
