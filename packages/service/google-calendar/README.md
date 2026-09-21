# @crvouga/mockingbird-service-google-calendar

Stateful mock of **Google Calendar v3** and **Google OAuth 2.0** for test suites, covering what
our EMR backend calls: `calendarList.list`, `calendars.insert`, `events.list` (time windows,
`q`, `orderBy`, paging, incremental sync with 410 `fullSyncRequired`), `events.get/insert/
update/delete`, `events.watch` with real push notifications to the channel's address, and
`channels.stop`; plus the token endpoint (authorization code and refresh grants), revoke, and
OpenID userinfo. Practitioners connect, sync EMR appointments and receive calendar pushes
without a Google account.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/google-calendar/SUPPORT.md)
- The contract (`openapi.yaml`) is trimmed from Google's Calendar v3 discovery document and
  OAuth docs to what `google-calendar-service.ts`, `authorize.business.ts` and the webhook
  controller use.

## Install

```bash
npm install -D @crvouga/mockingbird-service-google-calendar
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-google-calendar serve`, `createServer` from `./server` (Node), or
`createRuntime` with any Fetch server.

## Usage

Seams (the app hardcodes Google today): give the calendar client a `rootUrl`
(`google.calendar({version: "v3", auth, rootUrl: "<mock>/"})`), give `OAuth2Client`
`endpoints: {oauth2TokenUrl: "<mock>/token", oauth2RevokeUrl: "<mock>/revoke"}`, and point the
userinfo fetch at `<mock>/oauth2/v3/userinfo`. `GOOGLE_WEBHOOK_URL` can stay as it is: the mock
posts pushes to whatever `address` the app registers (http is allowed unless
`--require-https-webhooks`).

```bash
npx mockingbird-google-calendar serve --port 8820 --client "$GOOGLE_CLIENT_ID:$GOOGLE_CLIENT_SECRET"
```

```js
import { auth, calendar } from "@googleapis/calendar"
import { OAuth2Client } from "google-auth-library"
import { createServer } from "@crvouga/mockingbird-service-google-calendar/server"

const google = await createServer()
const oauth = new OAuth2Client({
  clientId: "c",
  clientSecret: "s",
  redirectUri: "postmessage",
  endpoints: { oauth2TokenUrl: `${google.url}/token`, oauth2RevokeUrl: `${google.url}/revoke` },
})
// Authorization code "4/mock-<name>" signs in <name>@example.com ("4/mock-<email>" for others).
const { tokens } = await oauth.getToken("4/mock-dr.house")
const client = new auth.OAuth2()
client.setCredentials({ access_token: tokens.access_token ?? null })
const cal = calendar({ version: "v3", auth: client, rootUrl: `${google.url}/` })
await cal.events.insert({
  calendarId: "primary",
  requestBody: { summary: "Rounds", start: { dateTime: "2026-10-01T15:00:00Z" }, end: { dateTime: "2026-10-01T16:00:00Z" } },
})
```

An event created "in Google's UI" (admin route) is what the app then lists and syncs:

```ts
import { createServer } from "@crvouga/mockingbird-service-google-calendar/server"

const google = await createServer()
await fetch(`${google.url}/__admin/events`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email: "dr.house@example.com",
    event: { summary: "Rounds", start: { dateTime: "2026-10-01T15:00:00Z" }, end: { dateTime: "2026-10-01T16:00:00Z" } },
  }),
})
const stored = await (await fetch(`${google.url}/__admin/events?email=dr.house@example.com`)).json()
await google.close()
```

### Routes

| Route | Behaviour |
| --- | --- |
| `POST /token` | Form-encoded (`client_secret_post` or Basic). `authorization_code`: `4/mock-<name or email>` → `{access_token, expires_in: 3599, refresh_token, scope, token_type, id_token}`; codes are single-use; anything else is 400 `invalid_grant`. `refresh_token` → a new access token (+ `id_token`); revoked or foreign tokens are `invalid_grant`. Unknown client (with `clients` set) 401 `invalid_client`. |
| `POST /revoke?token=` | Revokes an access or refresh token; unknown / already revoked 400 `invalid_token`. |
| `GET /oauth2/v3/userinfo` | `{sub, email, email_verified, name, given_name, family_name, picture}` (derived from the email, or set with `PUT /__admin/users/:email`). |
| `GET /calendar/v3/users/me/calendarList` | The account's primary calendar (id = email) and its secondary calendars. |
| `POST /calendar/v3/calendars` | Create a secondary calendar (`…@group.calendar.google.com`). |
| `GET /calendar/v3/calendars/{id}/events` | `timeMin`/`timeMax` (overlap), `q`, `showDeleted`, `singleEvents`, `orderBy` (`startTime` needs `singleEvents`), `updatedMin`, `maxResults` (≤ 2500) with `nextPageToken`; the last page carries `nextSyncToken` (not with `q`/`orderBy`/`updatedMin`). `syncToken` returns only changes since, deletions as `{id, status: "cancelled"}`; combined with a window or `q` it is 400; invalid or invalidated it is 410 `fullSyncRequired`. |
| `POST …/events`, `GET/PUT/DELETE …/events/{eventId}` | Base32hex ids (client ids allowed; duplicates 409). Missing start/end 400, an empty range 400 `timeRangeEmpty`. `PUT` replaces (sequence +1 when the time moves). `DELETE` 204, again 410 `deleted`. |
| `POST …/events/watch` | `{id, type: "web_hook", address, token?, expiration?}` → `{kind: "api#channel", id, resourceId, resourceUri, expiration}` (capped at 30 days). A `sync` push follows immediately. Duplicate live channel ids are 400. |
| `POST /calendar/v3/channels/stop` | `{id, resourceId}` → 204; unknown 404. |

Errors use Google's envelope `{error: {errors: [{domain, reason, message}], code, message, status?}}`.
Invalid or expired access tokens are 401 `authError` (userinfo: `invalid_request`).

### Push notifications

Every change to a calendar's events (through the API or the admin plane) posts to each live
channel on that calendar: an empty body with `X-Goog-Channel-ID`, `X-Goog-Channel-Token` (when
set), `X-Goog-Channel-Expiration` (RFC 1123), `X-Goog-Message-Number` (1 for `sync`, then +1),
`X-Goog-Resource-ID`, `X-Goog-Resource-URI` and `X-Goog-Resource-State` (`sync`, then
`exists`). Stopped or expired (mock clock) channels get nothing. Non-2xx answers are retried
(immediately, 1 s, 10 s, 1 min, 10 min). `GET /__admin/webhooks` lists deliveries, and
`/__admin/webhooks/events`, `…/replay`, `…/flush` work as usual.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `POST /__admin/events` | `{email, calendarId?, event}`: create an event as the account would in Google's UI (pushes). |
| `PUT /__admin/events/:id` | `{email, calendarId?, event}`: replace it (pushes). |
| `DELETE /__admin/events/:id?email=&calendarId=` | Delete it (pushes). |
| `GET /__admin/events?email=` | Stored events (with change sequences). |
| `PUT /__admin/users/:email` | Set the userinfo profile. |
| `GET /__admin/channels` | Every channel with its message number, expiry and stopped flag. |
| `POST /__admin/sync-tokens/invalidate` | Every sync token issued so far answers 410. |
| `GET/PUT /__admin/settings` | `{clients?, tokenTtlSeconds?, requireHttpsWebhooks?, maxChannelTtlSeconds?, scope?}`. |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`): `invalid_grant`,
`token_expired`, `rate_limited` (403 rateLimitExceeded), `too_many_requests` (429),
`calendar_api_disabled` (403 accessNotConfigured), `insufficient_scopes`, `sync_token_gone`,
`backend_error` (503), `connection_drop`, `push_duplicate`, `push_drop`. gaxios retries 429 and
5xx itself, so pass a `count` above its budget (3 retries) to surface them.

### Namespaces

By account: access tokens carry their email, so
`PUT /__admin/credentials {"credentials": {"dr.house@example.com": "<namespace>"}}` routes every
calendar and userinfo call. `x-mockingbird-namespace` works as usual. A `/ns/<name>` prefix
works for the token, revoke and userinfo URLs (they are full URLs) but not for the calendar
client: googleapis resolves paths against `rootUrl`'s origin and drops a path prefix.

### SDK

The tests drive the real client stack of `googleapis@149`: `@googleapis/calendar@9.8.0` (the same
generated calendar module over googleapis-common 7 / gaxios 6; the full `googleapis` package is
~125 MB unpacked, so only the module is installed) and `google-auth-library@9.15.0`.

### Deliberately not modelled

- Recurring events (`recurrence` is stored, never expanded), attendees' responses and email
  invitations, Meet links, free/busy, ACLs, colors and settings.
- Real Google identity: `id_token`s are JWT-shaped but not signed with Google's keys.
- `X-Goog-Changed` (Google omits it for calendar event channels) and `not_exists` states.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `GoogleCalendarAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `user(email)`, `ensurePrimary(email)`, `resolveCalendar(email, id)`, `createEvent`, `updateEvent`, `deleteEvent`, `findEvent`, `notify(calendarId)`, `channels()`, `events(email?)`, `invalidateSyncTokens()`. Options: `sqlite`, `now`, `namespace`, `settings`, `onPush`, `onChannels`. |
| `createRuntime` | function | The mock with the full service contract and push delivery. Options: `settings`, `push: {retryDelaysMs?, fetch?}`, `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `GOOGLE_CALENDAR_PRESETS` | object | Every named fault preset. |
| `GOOGLE_CALENDAR_NAMESPACE` | string | The service name, `"google-calendar"`. |
| `DEFAULT_SCOPE` | string | The scope the token endpoint reports. |
| `pushHeaders` | function | The `X-Goog-*` headers of a push notification. |
| `issueAccessToken` | function | Mint an access token the mock accepts for an email. |
| `parseToken` | function | Decode a mock access or refresh token. |
| `accessTokenCredential` | function | The account an access token belongs to (how credentials map to namespaces). |
| `emailFromCode` | function | The account a `4/mock-…` authorization code signs in. |
| `googleError` | function | Build Google's error envelope. |
| `document`, `operationIds`, `supportedOperationIds` | values | The OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target (`--client`, `--require-https-webhooks`); port 8820. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
