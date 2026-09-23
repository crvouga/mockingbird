# OTLP/HTTP collector and OpenObserve search (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **7**
- supported by the mock: **7**
- parity enabled: **7**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `ExportTraces` | `POST /v1/traces` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ExportLogs` | `POST /v1/logs` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ExportMetrics` | `POST /v1/metrics` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListOrganizations` | `GET /api/organizations` | ✅ supported | ✅ |  |
| `ListStreams` | `GET /api/{org}/streams` | ✅ supported | ✅ |  |
| `GetStreamSchema` | `GET /api/{org}/streams/{stream}/schema` | ✅ supported | ✅ |  |
| `Search` | `POST /api/{org}/_search` | ✅ supported | ✅ |  |
