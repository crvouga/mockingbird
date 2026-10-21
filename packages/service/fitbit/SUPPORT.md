# Fitbit legacy Web API emulator — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **8**
- supported by the emulator: **8**
- parity enabled: **7**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `Authorize` | `GET /oauth2/authorize` | ✅ supported | ❌ disabled | Interactive consent redirects are exercised by the acceptance tests through the consumer. |
| `OAuthToken` | `POST /oauth2/token` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `RevokeToken` | `POST /oauth2/revoke` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetProfile` | `GET /1/user/{userId}/profile.json` | ✅ supported | ✅ |  |
| `ListActivityLogs` | `GET /1/user/{userId}/activities/list.json` | ✅ supported | ✅ |  |
| `GetDailyActivitySummary` | `GET /1/user/{userId}/activities/date/{date}.json` | ✅ supported | ✅ |  |
| `GetSleepByDate` | `GET /1/user/{userId}/sleep/date/{date}.json` | ✅ supported | ✅ |  |
| `GetSleepByDateV12` | `GET /1.2/user/{userId}/sleep/date/{date}.json` | ✅ supported | ✅ |  |
