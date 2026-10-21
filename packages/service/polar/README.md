# @crvouga/mockingbird-service-polar

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

WIP Polar AccessLink v3 emulator: OAuth 2.0 authorization code, user registration and the exercise endpoints, with the 30-day visibility window.

## Install

`bun add @crvouga/mockingbird-service-polar`

## Usage

```ts
import { createServer } from "@crvouga/mockingbird-service-polar/server"

// Test setup: a local Polar. The user is registered with the client ten days ago and has an
// exercise uploaded afterwards. Seeds, presets and the clock are the only emulator-specific lines.
const now = Date.now()
const server = await createServer({
  registrations: [
    { xUserId: 1001, memberId: "m-1", registeredAt: new Date(now - 10 * 86_400_000).toISOString() },
  ],
  exercises: [
    {
      xUserId: 1001,
      id: "2AC312F",
      upload_time: new Date(now - 86_400_000).toISOString(),
      start_time: "2026-01-30T08:00:00",
      duration: "PT2H44M",
    },
  ],
})

// Application code: the same three origins, each pointed at the emulator.
const apiOrigin = server.url
const tokenUrl = `${server.url}/v2/oauth2/token`
const authorizeUrl = `${server.url}/oauth2/authorization`

const consent = await fetch(
  `${authorizeUrl}?response_type=code&client_id=mock_client&redirect_uri=https://app.example.com/cb&state=s1&scope=accesslink.read_all`,
  { redirect: "manual" },
)
const code = new URL(consent.headers.get("location") ?? "").searchParams.get("code") ?? ""
const tokenResponse = await fetch(tokenUrl, {
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    authorization: `Basic ${btoa("mock_client:mock_client_secret")}`,
  },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: "https://app.example.com/cb",
  }),
})
const { access_token } = (await tokenResponse.json()) as { access_token: string }
const exercises = await fetch(`${apiOrigin}/v3/exercises?samples=false&zones=false&route=false`, {
  headers: { authorization: `Bearer ${access_token}`, accept: "application/json" },
})
console.log(await exercises.json())

await server.close()
```

Run `mockingbird-polar serve --port 12157`. The consumer has three origin settings: set the API origin, the token URL (`<origin>/v2/oauth2/token`) and the authorize URL (`<origin>/oauth2/authorization`) to the emulator. One emulator serves all three route sets, so they share the origin. The consent page is a browser redirect, so a browser cannot send `x-mockingbird-namespace`: use the `/__admin/ns/<name>` prefix (`<origin>/__admin/ns/<name>/oauth2/authorization`) to pick a namespace for it.

## Routes and state

Defaults: client `mock_client` / `mock_client_secret` (any redirect URI unless the client lists `redirectUris`), user `x_user_id` 1001 (not registered), and the access token `mock_polar_token` for that user. `GET /oauth2/authorization` redirects to `redirect_uri?code=<code>&state=<state>` as the first (or `consentUser`) user; the code is one-time and good for ten minutes on the emulator clock. `POST /v2/oauth2/token` takes a form body and Basic client auth and answers `{access_token, token_type: "bearer", expires_in: 31535999, x_user_id}` (integers; no `refresh_token`, no `scope`). Tokens never expire; they stop working only when revoked. A second use of a code, a different client's code or a mismatched `redirect_uri` is 400 `invalid_grant`; an unknown client or wrong secret is 400 `invalid_client`; a non-form body, a missing `grant_type`, or any grant other than `authorization_code` (including `refresh_token`) is 400 `invalid_request`.

`POST /v3/users` with `{"member-id": "..."}` registers the token's user with the token's client at the emulator clock's instant and answers 200 with the profile (`polar-user-id`, `member-id`, `registration-date`, `first-name`, ...). A user already registered, or a `member-id` another user of that client holds, is 409. A body without `member-id` is 400; a non-JSON body is 415.

`GET /v3/exercises` returns a JSON array of the token user's exercises that were uploaded at or after registration and no more than 30 days before the emulator clock (an exact 30 days is still returned), oldest upload first; `[]` when there are none. `GET /v3/exercises/{id}` returns one, or 404 for an unknown id, another user's exercise, or one outside that window. `samples`, `zones` and `route` default to false and must read `true` or `false` (else 400); when true the item gains `samples`, `heart_rate_zones` or `route` (from the seed, `[]` when none). A token whose user is not registered with the client gets 403 on both. Items always carry `id`, `upload_time`, `polar_user`, `device`, `sport`, `start_time`, `start_time_utc_offset` and `duration`; a seed that omits `device`, `device_id`, `sport`, `detailed_sport_info`, `start_time_utc_offset`, `duration`, `calories`, `distance`, `heart_rate` or `has_route` gets synthetic defaults (a Polar Vantage V, a 30 minute run).

Every API route answers a missing, unknown or revoked token with 401.

## Test controls

Seed through options (`clients`, `users`, `registrations`, `exercises`, `tokens`, `codes`, `settings`) or the admin routes below; all state shows under `GET /__admin/state`. Admin routes (relocatable with the admin prefix):

- `GET|PUT /__admin/settings`: `{consent: "approve" | "deny" | "error", consentUser: <x_user_id> | null}`. `deny` redirects with `error=access_denied`, `error` with `error=server_error`, both carrying the `state`.
- `POST /__admin/users` `{xUserId, firstName?, lastName?, birthdate?, gender?, weight?, height?}`.
- `POST /__admin/registrations` `{xUserId, memberId, registeredAt, clientId?}` (ISO 8601).
- `POST /__admin/exercises` `{xUserId, id, upload_time, start_time, ...fields}`. Seed one uploaded before registration and one older than 30 days to see them excluded.
- `POST /__admin/tokens/revoke` `{token}`: that token answers 401 from then on.
- The clock (`POST /__admin/clock`) moves the 30-day window and the code lifetime.

Presets (`POST /__admin/faults {"preset": ..., "count": n}`): `unauthorized` (401), `rate_limited` (429 with `RateLimit-Usage`, `RateLimit-Limit`, `RateLimit-Reset`, no `Retry-After`), `rate_limited_retry_after` (the same plus `Retry-After: 5`), `server_error` (500) and `connection_drop`. Generic faults add any other status, headers or latency. Header namespaces (`x-mockingbird-namespace`), `/__admin/ns/<name>` paths and bearer-token mappings (`PUT /__admin/credentials`) isolate users, registrations, exercises and tokens. Journals record metadata, not bodies. No webhooks.

## Oracle and tests

Derived from the [AccessLink reference](https://www.polar.com/accesslink-api/) and the consumer's wire shapes (issue #546). **No live credentials were used; nothing here is oracle-verified.** The following are a best guess, not oracle-verified: the `invalid_request` error for `grant_type=refresh_token`; 403 for an unregistered user's exercise calls; 200 and `[]` for a registered user with no exercises; 404 for an unknown exercise id; the JSON shape of API error bodies (`{"error": {"timestamp", "status", "errorType", "message"}}`); redirect-based `invalid_scope`, `unsupported_response_type` and `server_error` on the consent page; the ten-minute code lifetime; omitting `redirect_uri` at the token endpoint being accepted; the `RateLimit-*` values on the 429 presets (the documented default limits of 500 per 15 minutes and 5000 per 24 hours, exhausted) and no `Retry-After` on the default 429 (`rate_limited_retry_after` is the variant). Successful responses never carry `RateLimit-*` headers.

`bun test` runs the acceptance tests (every numbered behavior of the request, through `test/consumer.ts`), all-operation self-parity (the consent page is a browser redirect and is excluded from random walks) and divergence detection. `bun run parity` requires `POLAR_ACCESS_TOKEN` of an already registered user and performs a read-only exercise list envelope check without printing data.

## Deliberately not modelled

The deprecated transaction API (create transaction, commit), daily activity, continuous heart rate, cardio load, sleep, Nightly Recharge, SleepWise and Elixir data, FIT/TCX/GPX downloads, webhooks, user deletion and the v4 Dynamic API. Also: a real login or consent UI (the consent page decides from the `consent` setting), Polar Flow accounts and devices, rate-limit accounting (the `RateLimit-*` headers appear only on forced 429s), the `training_load`, `fat_percentage`-style optional exercise fields (seed them if needed; they pass through), and token expiry (`expires_in` is a constant).

## API

Root runtime exports: `PolarAPI`, `POLAR_NAMESPACE`, `POLAR_SCOPE`, `EXPIRES_IN`, `EXERCISE_WINDOW_MS`, `CODE_TTL_MS`, `DEFAULT_SETTINGS`, `createRuntime`, `POLAR_PRESETS`, `document`, `operationIds`, `supportedOperationIds`. Types: `PolarAPIOptions`, `Client`, `User`, `RegistrationSeed`, `Registration`, `TokenGrant`, `OAuthCode`, `ExerciseSeed`, `ExerciseRow`, `ConsentMode`, `Settings`, `PolarRuntimeOptions`, `PolarRuntime`, `OperationId`, `SupportedOperationId`.

`/server`: `createServer`, `serveTarget`, `DEFAULT_PORT`; types `PolarServerOptions`, `PolarServer`.
