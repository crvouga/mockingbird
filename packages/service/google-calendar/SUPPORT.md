# Google Calendar v3 + Google OAuth (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **12**
- supported by the mock: **12**
- parity enabled: **12**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `OAuthToken` | `POST /token` | ✅ supported | ✅ |  |
| `OAuthRevoke` | `POST /revoke` | ✅ supported | ✅ |  |
| `UserInfo` | `GET /oauth2/v3/userinfo` | ✅ supported | ✅ |  |
| `CalendarListList` | `GET /calendar/v3/users/me/calendarList` | ✅ supported | ✅ |  |
| `CalendarsInsert` | `POST /calendar/v3/calendars` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `EventsList` | `GET /calendar/v3/calendars/{calendarId}/events` | ✅ supported | ✅ |  |
| `EventsInsert` | `POST /calendar/v3/calendars/{calendarId}/events` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `EventsGet` | `GET /calendar/v3/calendars/{calendarId}/events/{eventId}` | ✅ supported | ✅ |  |
| `EventsUpdate` | `PUT /calendar/v3/calendars/{calendarId}/events/{eventId}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `EventsDelete` | `DELETE /calendar/v3/calendars/{calendarId}/events/{eventId}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `EventsWatch` | `POST /calendar/v3/calendars/{calendarId}/events/watch` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ChannelsStop` | `POST /calendar/v3/channels/stop` | ✅ supported | ⚠️ unsafe (opt-in) |  |
