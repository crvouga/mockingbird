# Docker Engine (Mockingbird) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **13**
- supported by the mock: **12**
- parity enabled: **8**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `ContainerList` | `GET /containers/json` | ✅ supported | ✅ |  |
| `ContainerCreate` | `POST /containers/create` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ContainerInspect` | `GET /containers/{id}/json` | ✅ supported | ✅ |  |
| `ContainerStart` | `POST /containers/{id}/start` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ContainerStop` | `POST /containers/{id}/stop` | ✅ supported | ❌ disabled | Explicit completion controls and pending responses require deterministic termination tests, not unbounded generated walks. |
| `ContainerKill` | `POST /containers/{id}/kill` | ✅ supported | ❌ disabled | Explicit completion controls and pending responses require deterministic termination tests, not unbounded generated walks. |
| `ContainerAttach` | `POST /containers/{id}/attach` | ❌ unsupported | — | Unsupported through Fetch. The Node server supports non-TTY streaming attach, verified by raw-wire tests and selected real Engine comparisons. |
| `ContainerWait` | `POST /containers/{id}/wait` | ✅ supported | ❌ disabled | Requires deterministic completion and cancellation; verified by lifecycle tests instead of unbounded generated waits. |
| `ContainerDelete` | `DELETE /containers/{id}` | ✅ supported | ❌ disabled | Explicit completion controls and pending responses require deterministic termination tests, not unbounded generated walks. |
| `SystemInfo` | `GET /info` | ✅ supported | ✅ |  |
| `SystemVersion` | `GET /version` | ✅ supported | ✅ |  |
| `SystemPing` | `GET /_ping` | ✅ supported | ✅ |  |
| `SystemPingHead` | `HEAD /_ping` | ✅ supported | ✅ |  |
