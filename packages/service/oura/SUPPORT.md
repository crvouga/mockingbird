# Oura v2 emulator — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **10**
- supported by the emulator: **10**
- parity enabled: **10**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `ListWorkout` | `GET /v2/usercollection/workout` | ✅ supported | ✅ |  |
| `ListSleep` | `GET /v2/usercollection/sleep` | ✅ supported | ✅ |  |
| `ListHeartrate` | `GET /v2/usercollection/heartrate` | ✅ supported | ✅ |  |
| `ListDailyActivity` | `GET /v2/usercollection/daily_activity` | ✅ supported | ✅ |  |
| `ListDailySpo2` | `GET /v2/usercollection/daily_spo2` | ✅ supported | ✅ |  |
| `ListDailyReadiness` | `GET /v2/usercollection/daily_readiness` | ✅ supported | ✅ |  |
| `ListDailySleep` | `GET /v2/usercollection/daily_sleep` | ✅ supported | ✅ |  |
| `GetPersonalInfo` | `GET /v2/usercollection/personal_info` | ✅ supported | ✅ |  |
| `OAuthToken` | `POST /oauth/token` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `OAuthAuthorize` | `GET /oauth/authorize` | ✅ supported | ⚠️ unsafe (opt-in) |  |
