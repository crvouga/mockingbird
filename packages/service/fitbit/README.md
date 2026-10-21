# @crvouga/mockingbird-service-fitbit

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

WIP Fitbit legacy Web API emulator: OAuth 2.0 authorization code with PKCE, refresh rotation and revoke, the profile, the activity log list, the sleep log by date and the daily activity summary, over synthetic data. Fitbit announced the end of support for the legacy Web API on 2026-09-30 and its shutdown on 2026-10-30 (migration target: the Google Health API); this emulator keeps the documented legacy contract testable after that.

## Install

`bun add @crvouga/mockingbird-service-fitbit`

## Usage

```ts
import { createServer } from "@crvouga/mockingbird-service-fitbit/server"

// Test setup: a local Fitbit. One origin serves the API, token, revoke and authorize routes, so it
// replaces https://api.fitbit.com and https://www.fitbit.com in the application.
const server = await createServer({
  activityLogs: [
    {
      userId: "ABC123",
      log: { logId: 1, activityName: "Walk", startTime: "2026-09-02T06:00:00.000-07:00", steps: 3000 },
    },
  ],
})
const baseUrl = server.url

// Application code: the requests it sends to Fitbit (default synthetic user ABC123 and its token).
const response = await fetch(
  `${baseUrl}/1/user/-/activities/list.json?afterDate=2026-09-01&sort=asc&limit=20&offset=0`,
  { headers: { authorization: "Bearer mock_fitbit_token", accept: "application/json" } },
)
const { activities, pagination } = await response.json()

await server.close()
```

Run `mockingbird-fitbit serve --port 12141`. Fitbit publishes no JS SDK and the consumer uses raw HTTP, so inject the emulator origin as the API origin, the token origin, the revoke origin and the authorize page origin (one local origin serves all four). A browser or simulator reaches the authorize page over HTTP, so use the served emulator rather than in-process `fetch` for the consent step.

## Routes

| Route | What it does |
| --- | --- |
| `GET /oauth2/authorize` | The consent page. Validates `client_id`, `redirect_uri`, `response_type=code`, `scope`, and the S256 `code_challenge`, then redirects (302) to the redirect URI with `code` and `state`, or with `error`, `error_description` and `state`. An unregistered client or redirect URI cannot be redirected and answers 400 HTML. |
| `POST /oauth2/token` | Basic client auth, form body. `authorization_code` (with `redirect_uri` and `code_verifier`) and `refresh_token` grants. Answers `access_token`, `refresh_token`, `expires_in: 28800`, `token_type: "Bearer"`, `scope`, `user_id`. |
| `POST /oauth2/revoke` | Basic client auth, form `token=<access or refresh token>`. 200; every token of that user for the client is gone. |
| `GET /1/user/{-\|encodedId}/profile.json` | `{ user: { encodedId, displayName, ... } }`. Scope `profile`. |
| `GET /1/user/-/activities/list.json` | `afterDate` (with `sort=asc`) or `beforeDate` (with `sort=desc`), `limit` (1 to 100), `offset`. Scope `activity`. |
| `GET /1/user/-/activities/date/{date}.json` | `{ activities, goals, summary }`. Scope `activity`. |
| `GET /1/user/-/sleep/date/{date}.json` and `/1.2/...` | `{ sleep, summary }`. Scope `sleep`. Both path versions serve the same data. |

Authorization codes are single use and last 10 minutes; access tokens last 28800 seconds on the emulator clock. A refresh issues a new access and refresh token for the same user and scopes and removes the previous pair (single-use rotation, so the old access token answers 401 and the old refresh token answers `invalid_grant`). A failed code exchange (wrong verifier, wrong redirect URI) does not consume the code. The default client is `mock_client` / `mock_client_secret` (any redirect URI unless `redirectUris` is seeded); the default user is `ABC123` with bearer `mock_fitbit_token` and refresh token `mock_fitbit_refresh`, all scopes, never expiring until the clock passes year 2100.

Data semantics: activity logs are filtered and ordered by the local wall-clock part of `startTime` (`afterDate` includes, `beforeDate` excludes); `pagination.next` is a full URL on the emulator origin with the next `offset` and is an empty string on the last page; `previous` likewise. A sleep log belongs to the day in `dateOfSleep` (else the date of `endTime`), so a log that began the previous evening is returned on the day it ended; `summary` totals `minutesAsleep` and `timeInBed` and sums `levels.summary.{deep,light,rem,wake}.minutes` into `summary.stages` when any log carries them. A day with no sleep logs is 200 with `{ sleep: [], summary: { totalMinutesAsleep: 0, totalSleepRecords: 0, totalTimeInBed: 0 } }`; a day with no activity data is 200 with zeroed `summary`, default `goals` and `activities: []`. Dates are `YYYY-MM-DD` (real calendar dates) or `today`. Logs are pass-through: every field you seed comes back.

## Test controls

Seed with `createRuntime`/`createServer` options (`users`, `clients`, `grants`, `codes`, `activityLogs`, `sleepLogs`, `dailySummaries`, `consent`) or the admin routes below (all relative to `/__admin`, relocatable via `adminPrefix`):

| Admin route | Does |
| --- | --- |
| `PUT /consent` `{ mode: "approve" \| "deny" \| "error", userId? }` / `GET /consent` | What the authorize page does next, and which seeded user the code belongs to. |
| `POST /users` `{ encodedId, profile? }` | Seed a user; `profile` fields come back on the profile route. |
| `POST /activity-logs` / `POST /sleep-logs` `{ userId?, logs: [...] }` | Seed logs (`logId` and `startTime` are required; sleep also `endTime`). A repeated `logId` replaces the log. |
| `POST /daily-summaries` `{ userId?, date, activities?, goals?, summary? }` | Seed one day; fields merge over the defaults. |
| `POST /tokens/expire` `{ userId }` | Expire the user's access tokens now, without moving the clock; refresh tokens still work. |
| `POST /tokens/revoke` `{ userId }` | Revoke every token of the user, so the next refresh is `invalid_grant`. |

`POST /clock {"advance": ms}` moves the namespace clock: an access token older than 28800 seconds then answers 401 `expired_token`, and a code older than 10 minutes is refused. Standard `/__admin/health`, `/state` (collections `users`, `clients`, `grants`, `codes`, `activity_logs`, `sleep_logs`, `daily_summaries`, `settings`), `/reset`, `/requests`, Timeline checkpoints and faults are available. The header `x-mockingbird-namespace`, `/__admin/ns/<name>` paths and credential mappings (bearer token or Basic client id) isolate data. Journals contain metadata, never token or health payloads.

Presets (`POST /__admin/faults {"preset": "<name>", "count": n}`): `unauthorized` (401 `expired_token`), `forbidden` (403 `insufficient_scope`), `rate_limited` (429 with `Retry-After: 2` and `fitbit-rate-limit-*` headers), `rate_limited_no_retry_after`, `server_error` (500), `connection_drop`. No webhooks: the Subscription API is not modelled.

## Evidence and best guesses

Nothing here was observed against a live Fitbit account (the legacy API has no sandbox and needs a consenting user). The contract follows the vendor reference at <https://dev.fitbit.com/build/reference/web-api/> (authorize, token, refresh, revoke, activity list, sleep by date, profile). Everything below is a **best guess, not oracle-verified** and is tracked in the issue as `needs-oracle-check`:

- the `{"errors":[{"errorType","message","fieldName"?}],"success":false}` envelope and the `errorType` names (`invalid_client`, `invalid_grant`, `invalid_request`, `unsupported_grant_type`, `invalid_token`, `expired_token`, `insufficient_scope`, `insufficient_permissions`, `validation`, `too_many_requests`), and their messages and statuses (401 for bad client credentials and bad or expired bearer tokens, 400 for bad grants and parameters, 403 for scope or another user's id);
- single-use refresh rotation killing the previous access token, and not consuming an authorization code on a failed exchange;
- `offset` above 0 being honored (the reference documents `Supported: 0` and builds `next` for the following page), `next` being an empty string on the last page, and `next` using the next `offset` rather than a moved `afterDate`;
- the `afterDate`/`sort` pairing rules and the `limit` 1 to 100 bound being enforced as 400 `validation`;
- `/1/` and `/1.2/` sleep serving identical data, including `levels.summary` stage totals;
- revoke answering 200 `{}` and an unknown token also 200 (RFC 7009), an unknown user id in the path answering 403;
- the 429 body and header set, and the defaults for profile, goals and an empty day.

## Oracle and tests

`bun test` runs the acceptance tests (one per numbered behavior of the service request, through `test/consumer.ts`, a port of the consumer's httpx client) and every-operation self-parity with divergence detection. `bun run parity` needs `FITBIT_ACCESS_TOKEN`, performs safe read-only profile and activity-list envelope checks, and never prints health data or credentials.

## Deliberately not modelled

Intraday time series, heart-rate and SpO2 time series, devices, friends, subscriptions and webhooks, writes (create log, goals), the implicit and client-credentials grants, public (secretless) PKCE clients, `GET /1/user/-/activities/{id}.json` (not a documented per-user route), the TCX download, the Google Health API, a consent UI (consent is decided by the `consent` control and the browser is only redirected), the `#_=_` fragment the vendor appends to the redirect, rate-limit accounting (limits are only scripted through presets), real health data and device pairing.

## API

Root runtime exports: `FitbitAPI`, `FITBIT_NAMESPACE`, `FITBIT_SCOPES`, `ACCESS_TOKEN_SECONDS`, `CODE_SECONDS`, `fitbitError`, `createRuntime`, `FITBIT_PRESETS`, `document`, `operationIds`, `supportedOperationIds`. Types include `FitbitAPIOptions`, `Client`, `User`, `Grant`, `OAuthCode`, `ActivityLog`, `ActivityLogEntry`, `SleepLog`, `SleepLogEntry`, `DailySummary`, `Consent`, `FitbitRuntimeOptions`, `FitbitRuntime`, `OperationId`, `SupportedOperationId`.

`/server` exports `createServer`, `serveTarget`, `DEFAULT_PORT` and types `FitbitServerOptions`, `FitbitServer`.
