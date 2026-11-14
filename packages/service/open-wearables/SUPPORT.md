# Open Wearables (Mockingbird WIP subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **14**
- supported by the emulator: **6**
- parity enabled: **6**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `ListProviders` | `GET /api/v1/oauth/providers` | ✅ supported | ✅ |  |
| `CreateUser` | `POST /api/v1/users` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetUser` | `GET /api/v1/users/{user_id}` | ✅ supported | ✅ |  |
| `ListConnections` | `GET /api/v1/users/{user_id}/connections` | ✅ supported | ✅ |  |
| `DisconnectProvider` | `DELETE /api/v1/users/{user_id}/connections/{provider}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `QueueSync` | `POST /api/v1/providers/{provider}/users/{user_id}/sync` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `AuthorizeProvider` | `GET /api/v1/oauth/{provider}/authorize` | ❌ unsupported | — | No verified public upstream equivalent or browser OAuth implementation; explicitly rejected with 501. |
| `DeploymentCreateUser` | `POST /api/v1/sdk/users` | ❌ unsupported | — | No verified public upstream equivalent or browser OAuth implementation; explicitly rejected with 501. |
| `DeploymentRegister` | `POST /api/v1/providers/{provider}/users/{user_id}/register` | ❌ unsupported | — | No verified public upstream equivalent or browser OAuth implementation; explicitly rejected with 501. |
| `DeploymentDeregister` | `DELETE /api/v1/providers/{provider}/users/{user_id}/deregister` | ❌ unsupported | — | No verified public upstream equivalent or browser OAuth implementation; explicitly rejected with 501. |
| `DeploymentReceipt` | `GET /api/v1/providers/{provider}/users/{user_id}/sync/{task_id}/receipt` | ❌ unsupported | — | No verified public upstream equivalent or browser OAuth implementation; explicitly rejected with 501. |
| `DeploymentAppleUpload` | `POST /api/v1/sdk/users/{user_id}/sync/apple/healthion` | ❌ unsupported | — | No verified public upstream equivalent or browser OAuth implementation; explicitly rejected with 501. |
| `PairUser` | `GET /users/{user_id}/pair` | ❌ unsupported | — | No verified public upstream equivalent or browser OAuth implementation; explicitly rejected with 501. |
| `PairProvider` | `GET /users/{user_id}/pair/{provider}` | ❌ unsupported | — | No verified public upstream equivalent or browser OAuth implementation; explicitly rejected with 501. |
