# WHOOP v2 emulator — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **7**
- supported by the emulator: **7**
- parity enabled: **7**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `ListWorkout` | `GET /developer/v2/activity/workout` | ✅ supported | ✅ |  |
| `ListSleep` | `GET /developer/v2/activity/sleep` | ✅ supported | ✅ |  |
| `ListRecovery` | `GET /developer/v2/recovery` | ✅ supported | ✅ |  |
| `ListCycle` | `GET /developer/v2/cycle` | ✅ supported | ✅ |  |
| `GetProfileBasic` | `GET /developer/v2/user/profile/basic` | ✅ supported | ✅ |  |
| `OAuthAuthorize` | `GET /oauth/oauth2/auth` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `OAuthToken` | `POST /oauth/oauth2/token` | ✅ supported | ⚠️ unsafe (opt-in) |  |
