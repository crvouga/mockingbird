# Polar AccessLink API v3 (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **5**
- supported by the emulator: **5**
- parity enabled: **4**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `Authorize` | `GET /oauth2/authorization` | ✅ supported | ❌ disabled | Browser redirect flow; covered by acceptance tests. |
| `OAuthToken` | `POST /v2/oauth2/token` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `RegisterUser` | `POST /v3/users` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListExercises` | `GET /v3/exercises` | ✅ supported | ✅ |  |
| `GetExercise` | `GET /v3/exercises/{id}` | ✅ supported | ✅ |  |
