# Notion database subset — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **4**
- supported by the emulator: **4**
- parity enabled: **4**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `OAuthToken` | `POST /v1/oauth/token` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `Search` | `POST /v1/search` | ✅ supported | ✅ |  |
| `CreatePage` | `POST /v1/pages` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetBlockChildren` | `GET /v1/blocks/{block_id}/children` | ✅ supported | ✅ |  |
