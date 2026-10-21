# @crvouga/mockingbird-service-garmin-health

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

WIP Garmin Connect Developer Program Health API emulator for the scheduled-sync flow: OAuth 2.0 with PKCE, the user id, backfill requests (once per type and window), push and ping webhooks delivered to your app, and deregistration, over synthetic data. Garmin's endpoint specification is behind the approved-developer portal, so every wire detail is the contract a real consumer sends and parses (issue #545), not vendor-verified. See [Evidence and best guesses](#evidence-and-best-guesses).

## Install

`bun add @crvouga/mockingbird-service-garmin-health`

## Usage

```ts
import { createServer } from "@crvouga/mockingbird-service-garmin-health/server"

// Test setup: a local Garmin. One origin serves the API, token and consent routes, so it replaces
// https://apis.garmin.com, https://diauth.garmin.com and https://connect.garmin.com in the app. The
// emulator posts webhooks to your receiver, so tell it your webhook base URL.
const server = await createServer({
  webhooks: { baseUrl: "http://localhost:8000/api/v1/garmin/webhooks", clientId: "my-client-id" },
})
const garmin = server.url

// Application code: the requests it sends to Garmin (default user garmin-user-1 and its token).
const headers = { authorization: "Bearer mock_garmin_token", accept: "application/json" }
const me = (await (await fetch(`${garmin}/wellness-api/rest/user/id`, { headers })).json()) as {
  userId: string
}
const day = 1767225600 // 2026-01-01T00:00:00Z
const backfill = await fetch(
  `${garmin}/wellness-api/rest/backfill/sleeps?summaryStartTimeInSeconds=${day}&summaryEndTimeInSeconds=${day + 86400}`,
  { headers },
)
// 202 with an empty body; a POST to http://localhost:8000/api/v1/garmin/webhooks/push follows.
console.log(me.userId, backfill.status)

await server.close()
```

Run `mockingbird-garmin-health serve --port 12131 --webhook-base-url http://localhost:8000/api/v1/garmin/webhooks`. Garmin publishes no public JS SDK and the consumer uses raw HTTP: point its API origin, token URL and authorize URL (three settings) at the emulator origin. A browser reaches the consent page over HTTP, so use the served emulator rather than in-process `fetch` for that step. Without `--webhook-base-url` nothing is delivered until `PUT /__admin/webhook-base-url` sets one.

## Routes

| Route | What it does |
| --- | --- |
| `GET /oauth2Confirm` | The consent page (`https://connect.garmin.com/oauth2Confirm` on the vendor). Needs `response_type=code`, `client_id`, `redirect_uri`, `code_challenge` and `code_challenge_method=S256`; `state` is optional and echoed; no `scope`. Redirects (302) to `redirect_uri?code=<code>&state=<state>`, or `?error=access_denied&error_description=...&state=...` when the `denyConsent` setting is on. An unknown client or unregistered redirect URI is never redirected to (400 `invalid_request`). |
| `POST /di-oauth2-service/oauth/token` | Form body, client credentials in the body (`client_id`, `client_secret`; Basic is also accepted). `authorization_code` (with `redirect_uri` and `code_verifier`) and `refresh_token` grants. Answers 200 `access_token`, `token_type: "bearer"`, `expires_in` (integer seconds), `refresh_token`. A reused or expired code, a wrong verifier or a wrong `redirect_uri` is 400 `invalid_grant`; bad client credentials 400 `invalid_client` (401 with Basic); an unknown, retired or deregistered refresh token 400 `invalid_grant`. |
| `GET /wellness-api/rest/user/id` | `{ "userId": "<id>" }` for the user behind the bearer token. |
| `GET /wellness-api/rest/backfill/{type}` | `type` is `activities`, `sleeps`, `dailies`, `epochs`, `bodyComps` or `hrv`; `summaryStartTimeInSeconds` and `summaryEndTimeInSeconds` are integer seconds (end after start, at most 90 days apart). 202 with an empty body. The same user, type and window again is 409. Unknown type 404, bad bounds 400. |
| `DELETE /wellness-api/rest/user/registration` | 204 with no body. Every token of the user then answers 401 and the refresh tokens are `invalid_grant`. |
| `GET /wellness-api/rest/{type}?uploadStartTimeInSeconds=&uploadEndTimeInSeconds=&token=` | The `callbackURL` of a ping notification. Authenticated by its `token` query parameter, not by a header; 200 with a JSON array of the summaries, 401 for an unknown token, another type, or a deregistered user. |

API calls without a bearer token, or with an unknown, expired (on the emulator clock) or deregistered one, answer 401 `{"error":"unauthorized","message":...}`. Authorization codes are single use and last 10 minutes; access tokens last `tokenTtlSeconds` (default 86400) on the emulator clock; a refresh rotates the refresh token and retires the old one (`rotateRefreshTokens: false` keeps it and omits `refresh_token` from the response, so a consumer keeps the old one). A failed exchange (wrong verifier or redirect URI) does not consume the code. The default client is `mock_garmin_client` / `mock_garmin_secret` (any redirect URI unless `clients[].redirectUris` is seeded); the default user is `garmin-user-1` with bearer `mock_garmin_token` and refresh token `mock_garmin_refresh`, never expiring until the clock passes year 2100.

## Backfill and delivery

A backfill is accepted once per user, type and window (start and end seconds). When it is accepted the emulator selects that user's seeded summaries of the type whose time falls in `[start, end)` (`startTimeInSeconds`, or `measurementTimeInSeconds` for `bodyComps`) and delivers them according to the user's `delivery` mode:

- **push** (default): `POST <baseUrl>/push` with `{ "<type>": [ { "userId": ..., ...summary } ] }`, the summaries exactly as seeded plus `userId`.
- **ping**: `POST <baseUrl>/ping` with `{ "<type>": [ { "userId": ..., "callbackURL": "<emulator origin>/wellness-api/rest/<type>?uploadStartTimeInSeconds=S&uploadEndTimeInSeconds=E&token=<token>" } ] }`. The callback needs no `Authorization` header and serves the same summaries as a JSON array. In a namespace the URL carries `/__admin/ns/<name>` so it reaches the right data without a header. The `publicUrl` setting replaces the origin when the consumer reaches the emulator at another address than the backfill call did.

Every delivery carries the `garmin-client-id` header (the `clientId` option, default `mock_garmin_client`) and no signature. A window with no seeded summaries is still 202 and nothing is delivered; the window counts as requested. The default seed gives `garmin-user-1` one summary of each type on 2026-01-01 (UTC); the first window above covers all of them. Summaries are pass-through: an activity seeded without `durationInSeconds` is delivered without it and the consumer decides what to do.

Webhook paths are `/push`, `/ping`, `/deregistration` and `/permissions` under the base URL (`paths` overrides each). The standard webhook hub runs the deliveries: retries with its default back-off on a non-2xx answer (`retryDelaysMs` changes it), `GET /__admin/webhooks` lists each delivery with its state (`delivered`, `failed`, `dropped`) and the receiver's status per attempt, `GET /__admin/webhooks/events` the bodies, `POST /__admin/webhooks/:id/replay` and `/webhooks/flush` re-run them.

## Test controls

Seed with `createRuntime`/`createServer` options (`users`, `clients`, `grants`, `codes`, `summaries`, `settings`, `webhooks`) or the admin routes below (relative to `/__admin`, relocatable via `adminPrefix`):

| Admin route | Does |
| --- | --- |
| `GET`/`PUT /settings` | `autoDeliver` (false holds accepted notifications), `denyConsent`, `consentUserId` (whose account the consent page signs in; default the first user), `rotateRefreshTokens`, `tokenTtlSeconds`, `publicUrl`. |
| `GET`/`PUT /users` | List, or add or replace `{ userId, delivery: "push" \| "ping", registered?, permissions? }`. |
| `PUT /summaries` | Seed `[{ userId, type, data, key? }]`. `data` needs `startTimeInSeconds` (`measurementTimeInSeconds` for `bodyComps`); a repeated `key` replaces. |
| `GET /backfills` | The history of accepted backfill requests, and the notifications (id, type, mode, `pending`, `sent` or `dropped`, item count; never the body). |
| `POST /notifications/deliver` `{ ids? }` / `POST /notifications/drop` `{ ids? }` | Send, or never send, the held notifications (all or the named ones). |
| `PUT /webhook-base-url` `{ baseUrl, clientId?, paths? }` | Set a namespace's webhook endpoints. Endpoints set at boot (`webhooks.baseUrl`, `--webhook-base-url`) serve every namespace and are kept; these are added. |
| `POST /users/:userId/deregister` | Deregister the user as if they disconnected in Garmin Connect: their tokens stop working and `POST <baseUrl>/deregistration` carries `{ "deregistrations": [ { "userId", "userAccessToken" } ] }`. |
| `POST /users/:userId/permissions` `{ permissions: { "<name>": boolean } }` | Merge the user's permissions and `POST <baseUrl>/permissions` with `{ "userPermissionsChange": [ { "userId", "permissions" } ] }`. |
| `POST /users/:userId/expire-token` `{ revokeRefresh? }` | Expire the user's access tokens now without moving the clock; `revokeRefresh` also retires the refresh tokens. |

`POST /clock {"advance": "2h"}` moves the namespace clock: access tokens older than `expires_in` then answer 401, codes older than 10 minutes are refused. Standard `/__admin/health`, `/state` (collections `users`, `clients`, `grants`, `codes`, `summaries`, `backfills`, `notifications`, `callbacks`, `settings`), `/reset`, `/requests`, Timeline checkpoints and faults are available. The header `x-mockingbird-namespace`, `/__admin/ns/<name>` paths and credential mappings (bearer token) isolate users, summaries, tokens and backfill history per namespace. Journals contain metadata, never summaries or tokens.

Presets (`POST /__admin/faults {"preset": "<name>", "count": n}`): `unauthorized` (Health API 401), `conflict` (backfill 409), `rate_limited` (429 with `Retry-After: 1`), `server_error` (500), `refresh_rejected` (token endpoint 400 `invalid_grant`), `connection_drop` (backfill drops the socket), and the webhook modes `duplicate`, `webhook_drop` and `webhook_reorder` (the next delivery is sent twice, never, or swapped with the one after it). Preset bodies are scripted fixtures.

## Evidence and best guesses

Nothing here was observed against a live Garmin account: the Health API needs an approved developer account and its specification is not public. The sources are the sanitized wire in issue #545 (what a consumer sends and parses) and the overview at <https://developer.garmin.com/gc-developer-program/health-api/>. Everything below is a **best guess, not oracle-verified**, tracked as `needs-oracle-check`:

- the consent redirect shape and the PKCE checks (S256 only, a 43 to 128 character verifier, single-use 10-minute codes, a failed exchange leaving the code usable);
- 400 `invalid_grant` for a reused code, wrong verifier, wrong redirect URI and an unknown or retired refresh token, and 400 `invalid_client` for bad credentials (the issue says 400 or 401 for a rejected refresh token);
- refresh-token rotation (default on; the rotation setting exists because the vendor's behavior is not known) and `token_type: "bearer"`;
- the user id shape (`garmin-user-1`; the real id is opaque) and `expires_in` of 86400;
- 202 with an empty body for an accepted backfill, 409 for a repeated type and window (the key is user, type, start and end), the 90-day window cap with 400, the 404 for an unknown type, and the JSON error body `{"error","message"}`;
- an empty window answering 202 and delivering nothing (the issue leaves "no delivery or an empty delivery" open);
- which summaries a window selects (`[start, end)` on the summary's own start time, `measurementTimeInSeconds` for body composition) and one delivery per accepted backfill, grouped under its type key;
- the 429 body and `Retry-After` header, the 401 body, and 204 for the registration delete (the issue only needs a success status);
- that deliveries carry no signature, only `garmin-client-id`, and the retry policy on a non-2xx answer (the hub's standard back-off);
- the ping `callbackURL` shape, its token being the only authentication, and the token surviving repeat requests until the user deregisters.

Where the issue and the vendor documentation could differ, the emulator follows the issue's wire.

## Oracle and tests

`bun test` runs the acceptance tests (one per numbered behavior of the service request, through `test/consumer.ts`, a port of the consumer's httpx provider class and FastAPI receiver, with the webhook hub delivering to that receiver and over a served HTTP sink) and every-operation self-parity with divergence detection. `bun run parity` needs `GARMIN_HEALTH_ACCESS_TOKEN`, performs only the safe `user/id` check, and never prints identifiers or credentials. Backfill, deregistration and webhooks are not run against Garmin.

## Deliberately not modelled

The pull endpoints under `/wellness-api/rest/{type}?uploadStartTimeInSeconds=...&token=...` as a polled read path (only the ping `callbackURL` serves them), pull-token generation, activity details, stress, respiration, pulse-ox, skin temperature, blood pressure, MoveIQ and every other backfill type, the Garmin Connect (non-Health) APIs, the older OAuth 1.0a flow, a consent UI (consent is decided by the `denyConsent` setting and the browser is only redirected), per-scope consent and the developer portal's fixed scopes, permissions enforcement (a permission change is only announced), rate-limit accounting and the vendor's backfill quotas beyond one request per type and window (limits are only scripted through presets), webhook authentication beyond the `garmin-client-id` header, summary derivation (summaries are seeded, never computed), and real health data and device pairing.

## API

Root runtime exports: `GarminHealthAPI`, `GARMIN_HEALTH_NAMESPACE`, `SUMMARY_TYPES`, `MAX_BACKFILL_SECONDS`, `isSummaryType`, `summaryTime`, `createRuntime`, `GARMIN_HEALTH_PRESETS`, `WEBHOOK_PATHS`, `webhookEndpoints`, `document`, `operationIds`, `supportedOperationIds`. Types include `GarminHealthAPIOptions`, `GarminUser`, `DeliveryMode`, `Client`, `Grant`, `OAuthCode`, `Summary`, `SummarySeed`, `SummaryType`, `BackfillRecord`, `Notification`, `CallbackToken`, `Settings`, `GarminWebhookEvent`, `GarminHealthRuntimeOptions`, `GarminHealthRuntime`, `GarminHealthWebhooks`, `OperationId`, `SupportedOperationId`.

`/server` exports `createServer`, `serveTarget`, `DEFAULT_PORT` and types `GarminHealthServerOptions`, `GarminHealthServer`.
