# Garmin Health API — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **6**
- supported by the emulator: **6**
- parity enabled: **5**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `Authorize` | `GET /oauth2Confirm` | ✅ supported | ❌ disabled | Interactive consent redirects are exercised by the acceptance tests through the consumer. |
| `OAuthToken` | `POST /di-oauth2-service/oauth/token` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetUserId` | `GET /wellness-api/rest/user/id` | ✅ supported | ✅ |  |
| `RequestBackfill` | `GET /wellness-api/rest/backfill/{type}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteRegistration` | `DELETE /wellness-api/rest/user/registration` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetCallbackSummaries` | `GET /wellness-api/rest/{type}` | ✅ supported | ✅ |  |
