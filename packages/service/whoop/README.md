# @crvouga/mockingbird-service-whoop

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

WIP WHOOP v2 emulator for synthetic workout, sleep, recovery and cycle synchronization.

## Install

`bun add @crvouga/mockingbird-service-whoop`

## Usage

```ts
import { createServer } from "@crvouga/mockingbird-service-whoop/server"

// Test setup: a local WHOOP. The application's API base is its URL plus /developer.
const server = await createServer()
const baseUrl = `${server.url}/developer`

// Application code: the request it sends to WHOOP.
const response = await fetch(`${baseUrl}/v2/activity/workout`, {
  headers: { authorization: "Bearer mock_whoop_token" },
})
const { records } = await response.json()

await server.close()
```

Run `mockingbird-whoop serve --port 12129`. Inject the local origin plus `/developer` as the consumer API base, and the origin alone as OAuth base. Consumer endpoint wiring is separate from this emulator.

## Routes and state

POST `/oauth/oauth2/token` accepts form-encoded authorization-code or refresh-token grants with client credentials. Seed `clients`, `codes`, and `grants` via options or admin state. Default emulator client: `mock_client` / `mock_client_secret`; default bearer `mock_whoop_token` and refresh `mock_whoop_refresh`. The default grant has all four read scopes and `offline`. Codes bind client, optional redirect and optional S256 PKCE challenge. Codes are single-use, including concurrent exchanges. New tokens expire after 3600 seconds (`tokenTtlSeconds` is configurable). Refresh invalidates both old access and refresh tokens, keeps the same user/scopes, and issues a refresh token only for an offline grant.

GET `/oauth/oauth2/auth` is the authorization endpoint a browser visits to connect a member. There is no consent page: the request is validated, then the `consents` collection answers for the user and the browser is redirected (302) to `redirect_uri` with `code` and `state`, or `error`, `error_description` and `state`. The code is stored in `codes` bound to the client, the exact `redirect_uri`, the granted scopes (so the token's `scope` is what was requested, and `refresh_token` appears only with `offline`) and an optional S256 `code_challenge`; `POST /oauth/oauth2/token` redeems it once. An unknown client (401 `invalid_client`), a missing `client_id` or `redirect_uri`, or a `redirect_uri` the client did not register (400 `invalid_request`, JSON `{error,error_description}`) is answered in place and never redirected to. Clients take optional `redirectUris` (exact match; omitted accepts any absolute http(s) URI so the default `mock_client` works as is) and `scopes` (omitted allows the documented WHOOP scopes). Redirected errors: `invalid_request` (no `response_type`, or a `code_challenge_method` other than `S256`), `unsupported_response_type`, `invalid_scope`, `invalid_state` (missing or under 8 characters). A longer `state` is echoed unchanged.

Consent controls: rows `{id, decision: "approve"|"deny"|"error", userId?, codeTtlSeconds?, error?, errorDescription?}` where `id` is a client id or `*` (every client without its own row). Seed with the `consents` option or `POST /__admin/state/consents {"id":"*","value":{"id":"*","decision":"deny"}}`. No row means approve for `synthetic-user` with a 600 second code. `deny` redirects `access_denied` and `error` redirects `server_error` (override with `error`/`errorDescription`), both with the unchanged `state` and no code. Issued codes are listed at `GET /__admin/state/codes`.

GET `/developer/v2/user/profile/basic` returns the token user's `{user_id,email,first_name,last_name}`: seed a `records` row with `collection: "profile"`, `userId` the token's user and `data` the profile (fake values only). Scope `read:profile` is required (403 `{detail:"Access forbidden."}` like the collections, 401 for an unknown or expired token, 404 `{detail:"Not Found"}` when the user has no profile row). The default grant does not carry `read:profile`.

GET `/developer/v2/activity/workout`, `/developer/v2/activity/sleep`, `/developer/v2/recovery`, `/developer/v2/cycle` return `{records,next_token}`. `limit` defaults to 10, maximum 25; `nextToken` continues pages. Results sort newest start first; `start` includes equal timestamps, `end` excludes equal starts and defaults to emulate now. The collection time-window implementation uses start timestamps, including activities spanning the end instant. Scope names are `read:workout`, `read:sleep`, `read:recovery`, `read:cycles`.

Seed `records: [{key,userId,collection,data}]`; `data` is a synthetic provider-shaped record. **Recovery has `cycle_id` and `sleep_id`, not `id`, `start`, or `end`**: seed a matching sleep record to supply its time window. This corrects the issue's generic recovery field list using the official schema. Missing related-sleep fixtures are excluded. Cycle ids remain numbers; workout/sleep ids remain UUIDs. Metrics and score states are passed through, preserving null or absent metrics. Distinct storage keys can model duplicate vendor records. Cursor internals are local stand-ins; consumers must retain the same query while paginating.

## Test controls

Standard relocatable `/__admin` health/state/reset/clock/journal/Timeline/fault routes. State collections contain only synthetic fixtures. Header namespaces, `/__admin/ns/<name>` paths and bearer-credential mappings isolate state. Journals record metadata, not OAuth or health bodies. Presets `unauthorized`, `rate_limited`, `server_error`, `connection_drop` support deterministic failures; generic faults add latency. Preset error bodies are scripted local fixtures, not claims of exact quota/error wording. No webhooks are required.

## Oracle and tests

Derived from the official [OpenAPI](https://api.prod.whoop.com/developer/doc/openapi.json), [OAuth reference](https://developer.whoop.com/docs/developing/oauth/), and [refresh example](https://developer.whoop.com/docs/tutorials/refresh-token-javascript/). The contract retains the official collection response schemas. Authorized live data and OAuth success were not probed; no live credentials used.

**Best guess, not oracle-verified:** the authorization endpoint and the profile route are not observed live. `/oauth/oauth2/auth` and `/oauth/oauth2/token` are Ory Hydra paths, so redirect status (302), the `error`/`error_description`/`state` redirect shape, the 8 character `state` minimum, and the error codes follow Hydra and its fosite library plus the WHOOP OAuth page. The statuses and JSON bodies for an unknown client or unregistered `redirect_uri` (Hydra renders an error page on the live service), the `invalid_scope` allow-list, treating a missing `scope` as an empty grant, S256-only PKCE, `access_denied`/`server_error` for consent controls, and the 403 for a missing `read:profile` scope are the emulator's choices, not observed vendor responses. The profile shape is the official `UserBasicProfile` schema.

`bun test` runs acceptance, all-operation self-parity and divergence detection. `bun scripts/python-smoke.ts` uses `uv` to run actual requests 2.32.5 and httpx 0.28.1 against local HTTP. It is not the private consumer itself. `bun run parity` requires `WHOOP_ACCESS_TOKEN` and performs a safe collection-envelope probe without printing health data.

## Deliberately not modelled

No real users, device pairing, sensors, a consent page (the `consents` rows stand in for the user's answer), hardware SDK, webhook delivery, body measurements, partner APIs or scoring computation. No cursor-format parity, real quota enforcement, concurrent refresh grace period or private-client integration claim. Partial synthetic records can be seeded deliberately; validate production fixtures against the supplied official schemas. Recovery relies on matching synthetic sleep fixtures.

## API

Root runtime exports: `WhoopAPI`, `WHOOP_NAMESPACE`, `COLLECTION_SCOPES`, `KNOWN_SCOPES`, `MIN_STATE_LENGTH`, `createRuntime`, `WHOOP_PRESETS`, `document`, `operationIds`, `supportedOperationIds`. Types: `WhoopAPIOptions`, `Grant`, `OAuthCode`, `Client`, `Consent`, `DataRecord`, `CollectionName`, `WhoopRuntimeOptions`, `WhoopRuntime`, `OperationId`, `SupportedOperationId`.

`/server`: `createServer`, `serveTarget`, `DEFAULT_PORT`; types `WhoopServerOptions`, `WhoopServer`.
