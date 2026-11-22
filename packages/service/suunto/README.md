# @crvouga/mockingbird-service-suunto

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

WIP Suunto Cloud API emulator: the OAuth 2.0 authorization-code flow, workouts, and the 24/7 sleep, activity and daily-statistics samples, behind the API management gateway's subscription key.

**Evidence.** The public onboarding page ([apizone.suunto.com/how-to-start](https://apizone.suunto.com/how-to-start)) documents the authorize and token exchange (Basic client authentication), the JWT access token with its `user` claim, and the `Ocp-Apim-Subscription-Key` header. Everything else (every data path, field, status, error body, window limit and `since` rule) comes from the consumer request in issue #547, whose per-operation schemas are not public. It is a **best guess, not oracle-verified**; each such choice is marked below. Nothing here has been observed against a live Suunto account.

## Install

`bun add @crvouga/mockingbird-service-suunto`

## Usage

```ts
import { createServer } from "@crvouga/mockingbird-service-suunto/server"

// Test setup: a local Suunto. Its URL replaces both https://cloudapi.suunto.com (data) and
// https://cloudapi-oauth.suunto.com (authorize and token) in the application.
const server = await createServer({
  workouts: [
    { workoutId: 1001, activityId: 3, startTime: 1788307200000, stopTime: 1788310800000, totalTime: 3600 },
  ],
  settings: { subscriptionKey: "my-subscription-key" },
})

// Application code: the OAuth redirect, then the requests it sends to Suunto.
const consent = await fetch(
  `${server.url}/oauth/authorize?response_type=code&client_id=mock_client&redirect_uri=http://localhost:8000/callback&state=abc`,
  { redirect: "manual" },
)
const code = new URL(consent.headers.get("location") ?? "").searchParams.get("code") ?? ""
const token = (await (
  await fetch(`${server.url}/oauth/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa("mock_client:mock_client_secret")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://localhost:8000/callback",
    }),
  })
).json()) as { access_token: string }
const response = await fetch(`${server.url}/v3/workouts/?since=0&limit=100&offset=0`, {
  headers: {
    authorization: `Bearer ${token.access_token}`,
    "ocp-apim-subscription-key": "my-subscription-key",
  },
})
const { payload } = (await response.json()) as { payload: { workoutId: number }[] }

await server.close()
```

Run `mockingbird-suunto serve --port 12141`. The consumer hard-codes both origins; give it a setting for the data origin, the authorize URL and the token URL and point all three at this server (`/oauth/authorize`, `/oauth/token`, everything else on the same origin). Serve it over HTTP on a loopback port when a browser must reach the authorize page. `test/consumer.ts` is a port of the consumer's httpx client (Basic token calls, JWT claim reads, one refresh on 401, one wait on 429, a top-level `code`/`error` read as a failure); the acceptance tests run through it.

## Routes

| Route | Behavior |
| --- | --- |
| `GET /oauth/authorize` | Needs `client_id` and `redirect_uri` (an unregistered client or URI is a 400 JSON error, never a redirect). Redirects to `redirect_uri?code=<one-time code>&state=<state unchanged>`. `scope` and PKCE are ignored. Consent mode `deny` redirects with `error=access_denied`, mode `error` with `error=server_error` (both with `error_description` and the state). A `response_type` other than `code` redirects with `error=unsupported_response_type`. |
| `POST /oauth/token` | Form body, `Authorization: Basic base64(client_id:client_secret)`. Wrong or missing credentials are a 401 `invalid_client`. `authorization_code` needs `code` and the same `redirect_uri`; a reused, expired or other client's code is a 400 `invalid_grant`. `refresh_token` returns a new access token. Answers `{access_token, token_type: "bearer", refresh_token, expires_in: 86400, scope: "workout"}`. Access and refresh tokens are JWTs; the access token carries `sub` (subject id), `user` (Suunto username), `client_id`, `scope`, `iat`, `exp` and `jti`. The signature is a deterministic stand-in: consumers decode, never verify. |
| `GET /v3/workouts/` | `{"error": null, "payload": [...]}` for the token's user, oldest first, with `since`, `limit` (default 100), `offset` and `filter-by-modification-time`. Each item is the seeded workout plus `workoutKey`. |
| `GET /v3/workouts/{workoutKey}` | `{"error": null, "payload": {...}}`; an unknown key or another user's is a 404 `{"error", "code": 404}`. |
| `GET /247samples/sleep`, `GET /247samples/activity` | `from` and `to` (epoch milliseconds, `from` inclusive, `to` exclusive). A top-level array of `{timestamp, entryData}` in timestamp order. |
| `GET /247/daily-activity-statistics` | `startdate` and `enddate` (`YYYY-MM-DDTHH:MM:SS`, read as UTC; same window rule). A top-level array with one entry per `Name`, each with `Aggregation` and `Sources[].Samples[]` of `{Value, TimeISO8601}`. |

Data routes go through the gateway first. With a `subscriptionKey` set, a missing or wrong `Ocp-Apim-Subscription-Key` (or `subscription-key` query parameter) is a 401 `{"statusCode": 401, "message": "Access denied due to ... subscription key ..."}` before the token is looked at. Without one configured the key is not required. An unknown, expired or missing token is a 401 `{"statusCode": 401, "message": "Unauthorized. Access token is missing or invalid."}`. The token is read with or without the word `Bearer` (the vendor's own curl example omits it). An unknown path is a gateway-style 404. The workouts list is served at `/v3/workouts/` with the trailing slash only.

API errors (a malformed or missing window, `since`, `limit`, `offset`) are `{"error": "<message>", "code": 400, "payload": null}`, so the consumer's read of a top-level `code` and `error` sees them.

### Best guesses (not oracle-verified)

- The gateway wording (`statusCode`/`message` bodies) is Azure API Management's usual form, taken from its documentation, not from a Suunto response.
- `since` is epoch seconds as the consumer sends it; a value of 1e11 or more (a millisecond timestamp, which the `/v2` documentation is believed to use) is read as milliseconds. `since=0` or omitted means all; otherwise a workout is returned when it is strictly after `since`. With `filter-by-modification-time=true` the compared time is the workout's `modifiedAt` (default: its `stopTime`), otherwise its `startTime`. Results are ordered by that time, then `workoutId`, and `limit`/`offset` slice that order.
- The 24/7 routes reject a window longer than `maxWindowDays` (default 28; the consumer chunks at 20 and 14 days) with a 400 `{"error": "The time range must not be longer than 28 days", "code": 400}`. `to` is exclusive so consecutive chunks never repeat a sample.
- The refresh token is reusable and returned unchanged by default; set `rotateRefreshTokens` to spend it and issue a new one on each refresh.
- `error_in_body` answers a 200 with `{"error": "rate_limited", "code": 429}`; whether the real gateway ever does is unknown.
- A daily statistic's `Aggregation` defaults to `Sum` and its source to `Suunto`.

## Test setup

Everything below is the test's, not the application's.

- **Seed.** Constructor options and `createServer` take `users` (`{subject, username}`; default `mock_user`), `clients` (`{clientId, clientSecret, redirectUris}`; default `mock_client` / `mock_client_secret`, any redirect URI), `workouts` (`workoutId`, `activityId`, `startTime`, `stopTime`, `totalTime` required, any other field passed through; optional `subject`, `modifiedAt`, `workoutKey`), `sleepSamples` and `activitySamples` (`{subject?, timestamp, entryData}`), `dailyStatistics` (`{subject?, name, time, value, aggregation?, source?}`) and `settings`. Seeds without a `subject` belong to the first user. At runtime: `POST /__admin/users`, `/workouts`, `/samples/sleep`, `/samples/activity`, `/daily-statistics` with the same bodies.
- **Tokens.** `mock_suunto_token` (refresh `mock_suunto_refresh`) belongs to the first user and does not expire, so a test needs no OAuth round trip. `POST /__admin/tokens {username?, subject?, clientId?}` mints a JWT pair for a user. `POST /__admin/tokens/expire {accessToken?}` expires one token, or all, now; the clock controls expiry otherwise (`expires_in` is `accessTokenTtlSeconds`).
- **Settings.** `GET` and `PUT /__admin/settings`: `subscriptionKey` (`null` accepts requests without one), `accessTokenTtlSeconds`, `codeTtlSeconds`, `consent` (`approve`, `deny`, `error`), `consentUser` (the username consent approves as; default the first user), `scope`, `rotateRefreshTokens`, `maxWindowDays`.
- **Presets** (`POST /__admin/faults {"preset": "<name>", "count": N}`, on the workouts and 24/7 routes only): `unauthorized` (401), `invalid_subscription_key` (401), `rate_limited` (429 with `Retry-After: 2`, API Management body `Rate limit is exceeded. Try again in 2 seconds.`), `rate_limited_no_retry_after`, `server_error` (500), `error_in_body` (200 with `{"error": "rate_limited", "code": 429}`), `connection_drop`. Generic faults add latency. The 429 and 500 bodies are scripted fixtures.
- **Standard controls.** `/__admin/health`, `/state`, `/reset`, `/requests`, `/clock`, Timeline checkpoints and faults live under `/__admin` (relocatable with `adminPrefix`). `x-mockingbird-namespace`, `/__admin/ns/<name>` and credential mappings isolate users, tokens, workouts, samples and settings. The journal holds metadata only, never tokens, codes or secrets.

## Oracle and tests

`bun test` runs the acceptance tests (every numbered behavior of issue #547, through `test/consumer.ts`) and every-operation self-parity with divergence detection. `bun run parity` needs `SUUNTO_ACCESS_TOKEN` and `SUUNTO_SUBSCRIPTION_KEY` (an approved API Zone subscription and a Suunto App account with synced watch data), reads one workouts page, checks only the envelope and never prints data; without them it exits 2.

## Deliberately not modelled

Webhook notifications (Suunto documents them for new workouts; the consumer does not receive them), route and FIT file downloads, `/247samples/recovery`, SuuntoPlus, writes, and the `/v2/workouts` family (not served, not aliased). Also not modelled: a consent page UI (consent is a redirect decided by `consent`), `scope` negotiation, PKCE, refresh-token expiry, per-subscription rate limits, and Suunto's field validation of workout and sample content (records are synthetic pass-through fixtures). No claim that the private consumer itself was exercised.

## API

Root runtime exports: `SuuntoAPI`, `SUUNTO_NAMESPACE`, `DEFAULT_ACCESS_TOKEN`, `DEFAULT_REFRESH_TOKEN`, `DEFAULT_USER`, `DEFAULT_CLIENT`, `DEFAULT_SETTINGS`, `accessToken`, `parseDate`, `gatewayError`, `apiError`, `oauthError`, `createRuntime`, `SUUNTO_PRESETS`, `document`, `operationIds`, `supportedOperationIds`. Types include `SuuntoAPIOptions`, `User`, `Client`, `Settings`, `Grant`, `RefreshGrant`, `AuthorizationCode`, `Workout`, `WorkoutFields`, `SeedWorkout`, `Sample`, `SeedSample`, `DailyStatistic`, `SeedDailyStatistic`, `SuuntoRuntimeOptions`, `SuuntoRuntime`, `OperationId`, `SupportedOperationId`.

`/server` exports `createServer`, `serveTarget`, `DEFAULT_PORT` and types `SuuntoServerOptions`, `SuuntoServer`.
