# @crvouga/mockingbird-service-vibe

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

WIP Vibe revision **2026-06-01** OAuth and asynchronous campaign-spend reports.

## Install

```sh
bun add @crvouga/mockingbird-service-vibe
```

## Usage

```ts
import { DEFAULT_ADVERTISER } from "@crvouga/mockingbird-service-vibe"
import { createServer } from "@crvouga/mockingbird-service-vibe/server"

// Test setup: a local Vibe with one spend row for the default client's advertiser.
const advertiserId = DEFAULT_ADVERTISER
const server = await createServer({ rows: [{
  advertiser_id: advertiserId, impression_date: "2026-01-01", spend: "12.50",
}] })
const baseUrl = server.url

// Application code: the report request it sends to Vibe.
const response = await fetch(`${baseUrl}/reports`, {
  method: "POST",
  headers: { authorization: "Bearer mock_vibe_token", "x-vibe-revision": "2026-06-01", "content-type": "application/json" },
  body: JSON.stringify({ start_date: "2026-01-01", end_date: "2026-01-02", advertiser_ids: [advertiserId], dimensions: ["impression_date"], metrics: ["spend"] }),
})
const report = await response.json()
console.log(report.id, report.status)

await server.close()
```

Run `mockingbird-vibe serve --port 12128`, then inject `http://localhost:12128` as the
consumer's API origin. Downloads point at this same origin. There is no universal vendor
environment variable for that override; keep the consumer's production HTTPS policy intact.

### Contract

- `POST /oauth2/token`: form-encoded client_credentials with HTTP Basic credentials.
  Default synthetic client is mock_client / mock_client_secret. Optional scope must be a
  subset of the client's scopes. Response includes bearer token, scope and expires_in.
  This endpoint does not require X-Vibe-Revision; failures use the standard OAuth envelope.
- `POST /reports`: JSON report request, Bearer token and pinned revision. Returns 201
  with UUID/status/created_at. Advertisers must belong to the client. Windows are start-inclusive,
  end-exclusive, positive and at most 45 days. JSON/DAY fixtures only.
- `GET /reports/{report_id}`: only the owning client can poll. Default clock progression:
  CREATED initially, PROCESSING at one second, READY at two seconds. READY includes the
  local download_url and generation/expiration timestamps; FAILED includes failure_reason.
- Internal `/__admin/blobs/{id}?token=…`: local stand-in for the vendor's pre-signed download.
  Returns a JSON array of synthetic rows, preserves numeric-as-string metrics and nulls,
  and expires 24 hours after generation. Capability values are deterministic test stand-ins,
  not production signing. No browser tracking or real campaign data is fetched.

Seed `clients`, pre-aggregated `rows` and `settings` through constructor options or shared
`/__admin/state`. Reports retain fixture rows at creation time and select requested columns.
Fixture dates are already in the requested reporting timezone; no attribution or aggregation
engine is implied. Default bearer mock_vibe_token is valid for one hour from initial seeding.

### Test controls

Collections: clients, tokens, rows, reports, settings. Settings expose processingMs, readyMs
and tokenTtlSeconds. Reports expose readyAt (null means stuck), failure and missingArtifact.
Use the shared clock to advance lifecycle/expiry, and shared Timeline/reset/state/journal APIs.
Reset restores constructor fixtures. Journals contain metadata, never report rows or credentials.
Namespaces work by header, mapped bearer token or `/__admin/ns/{name}` path. Download links
retain namespace and custom `adminPrefix` routing.

Presets: rate_limited (scripted 429/Retry-After), server_error (500), connection_drop,
report_failed and report_stuck. Shared fault rules also provide deterministic latency.
These are test controls; they do not model a real sliding-window quota or actual processing SLA.
No webhooks are needed for this subset.

Acceptance tests exercise all four issue #271 behaviors, OAuth expiry/scope, local artifact
expiry/missing files, namespaces/reset/redacted journals and served HTTP. Property tests run
every parity-enabled operation and detect divergence. `bun scripts/parity.ts` uses
VIBE_ACCESS_TOKEN and VIBE_REPORT_ID for a read-only existing-report envelope check; live
authenticated parity has not run. `bun scripts/parity.ts --unauthenticated` compares missing/
invalid synthetic-token errors against the real endpoint. This probe passed and confirms
`token_invalid` plus `WWW-Authenticate: Bearer`, differing from the documentation's
`invalid_token` example. The rest of the contract follows the published OpenAPI reference.

### Deliberately not modelled

Ad purchases, campaign mutation, attribution inference, production JWT signing, OAuth browser
consent/refresh, CSV or non-DAY reports, metric aggregation, timezone conversion, and report
filter expressions. Seed already-aggregated rows for the requested dimensions. The emulator
rejects CSV/non-DAY requests even though the vendor supports them; those are outside this
initial consumer subset. It does not claim full vendor API or live rate-limit parity.

## API

- `VibeAPI`: FetchAPI, reset and state collections.
- `createRuntime`: shared admin/namespace/clock/fault surface.
- `VIBE_NAMESPACE`, `VIBE_PRESETS`, `DEFAULT_ADVERTISER`: service constants.
- `document`, `operationIds`, `supportedOperationIds`: generated contract metadata.
- `createServer`, `serveTarget`, `DEFAULT_PORT` from `./server`: Node HTTP/CLI entry points.

Public types: Client, Token, Row, Report, Settings, VibeAPIOptions, OperationId,
SupportedOperationId; server types are VibeServerOptions and VibeServer.
