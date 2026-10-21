# Suunto Cloud API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **7**
- supported by the emulator: **7**
- parity enabled: **6**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `Authorize` | `GET /oauth/authorize` | ✅ supported | ❌ disabled | Browser redirect flow whose one-time codes only the acceptance tests can redeem. |
| `OAuthToken` | `POST /oauth/token` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ListWorkouts` | `GET /v3/workouts/` | ✅ supported | ✅ |  |
| `GetWorkout` | `GET /v3/workouts/{workoutKey}` | ✅ supported | ✅ |  |
| `ListSleepSamples` | `GET /247samples/sleep` | ✅ supported | ✅ |  |
| `ListActivitySamples` | `GET /247samples/activity` | ✅ supported | ✅ |  |
| `ListDailyActivityStatistics` | `GET /247/daily-activity-statistics` | ✅ supported | ✅ |  |
