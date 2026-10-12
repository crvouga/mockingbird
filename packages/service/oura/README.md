# @crvouga/mockingbird-service-oura

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

WIP Oura v2 collection and OAuth emulator for synthetic wearable synchronization tests.

## Install

`bun add @crvouga/mockingbird-service-oura`

## Usage

```ts
import { createServer } from "@crvouga/mockingbird-service-oura/server"

// Test setup: a local Oura. Its URL replaces https://api.ouraring.com in the application.
const server = await createServer({ pageSize: 2 })
const baseUrl = server.url

// Application code: the request it sends to Oura.
const response = await fetch(`${baseUrl}/v2/usercollection/workout`, {
  headers: { authorization: "Bearer mock_oura_token" },
})
const { data, next_token } = await response.json()

await server.close()
```

Run `mockingbird-oura serve --port 12128`; inject this origin into the consumer's API and OAuth configuration (the issue's provider strategies otherwise hard-code production). Acceptance tests use a Fetch port. `bun scripts/python-smoke.ts` (requires `uv`) additionally exercises the actual requests 2.32.5 and httpx 0.28.1 libraries over local HTTP, including token refresh and error handling; it does not exercise private consumer source.

## Routes and state

POST `/oauth/token` accepts URL-encoded authorization code or refresh grants, Basic or body client credentials. Seed `clients`, `codes`, `grants` with constructor options or standard state admin routes. Default local client is `mock_client` / `mock_client_secret`; bearer `mock_oura_token` belongs to `synthetic-user`. Codes bind client, redirect, expiry and optional S256 PKCE challenge. Refresh tokens rotate once, retaining user/scopes; clock controls access expiry.

GET `/v2/usercollection/{workout,sleep,heartrate,daily_activity,daily_spo2,daily_readiness,daily_sleep}` returns `{data,next_token}`. Heart rate uses `start_datetime/end_datetime`; others use `start_date/end_date` against `day`. Fixture windows include both endpoints, omitted bounds are unbounded. These boundary/default choices are deterministic local fixture semantics, not verified live edge-case parity. Never invent an id for heart-rate samples. Fixtures retain every supplied metric, including nulls. Scope checks use `workout`, `daily`, `heartrate`, `spo2`.

Seed `records` rows `{key,userId,collection,data}`. Keys identify storage rows, not vendor ids; distinct keys can deliberately carry duplicate provider data. `pageSize` controls deterministic insertion-order pages. Consumers must retain the same collection/window while paginating; the emulator's row-key cursors do not bind or validate the query. No promised vendor cursor format/order. Set `tokenTtlSeconds` for newly issued tokens.

## Test controls

Standard `/__admin/health`, `/state`, `/reset`, `/requests`, `/clock`, Timeline checkpoints and faults are available under `/__admin` (relocatable via `adminPrefix`). Header `x-mockingbird-namespace`, `/__admin/ns/<name>` paths and credential mappings isolate data. Journals contain metadata, never OAuth bodies or wearable payloads. Presets: `unauthorized`, `rate_limited`, `server_error`, `connection_drop`; generic faults add latency. Quota and server-error bodies are explicitly scripted fixtures, not live quota simulations. No webhooks in this surface.

## Oracle and tests

Contract: [official Oura OpenAPI 1.41](https://cloud.ouraring.com/v2/static/json/openapi-1.41.json) and [OAuth documentation](https://cloud.ouraring.com/docs/authentication). Synthetic invalid credentials were checked live: token endpoint returned HTTP 400 `invalid_client`, collection endpoint HTTP 401 with the documented detail. Authorized collection data and refresh were not checked live.

`bun test` runs acceptance and every-operation self-parity including divergence detection. `bun run parity` needs `OURA_ACCESS_TOKEN`, performs safe read-only envelope checks, and never prints health data or credentials.

## Deliberately not modelled

No real health data, account signup, consent UI, device pairing, sensor simulation, hardware SDK, webhooks, subscription lifecycle, field projection, statistical computation or full vendor metric validation. Records are synthetic pass-through fixtures; partial metrics can be seeded deliberately. Date boundary/default behavior, cursor internals and quota-body details are local stand-ins, not claims of exact vendor edge-case parity. No Python runtime dependency or claim that the private consumer itself was exercised.

## API

Root runtime exports: `OuraAPI`, `OURA_NAMESPACE`, `COLLECTION_SCOPES`, `createRuntime`, `OURA_PRESETS`, `document`, `operationIds`, `supportedOperationIds`. Types include `OuraAPIOptions`, `Grant`, `OAuthCode`, `Client`, `DataRecord`, `CollectionName`, `OuraRuntimeOptions`, `OuraRuntime`, `OperationId`, `SupportedOperationId`.

`/server` exports `createServer`, `serveTarget`, `DEFAULT_PORT` and types `OuraServerOptions`, `OuraServer`.
