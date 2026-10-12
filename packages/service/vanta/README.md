# @crvouga/mockingbird-service-vanta

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

WIP Manage Vanta OAuth, paginated compliance records, evidence metadata and offboarding.

## Install

```sh
bun add @crvouga/mockingbird-service-vanta
```

## Usage

```ts
import { createServer } from "@crvouga/mockingbird-service-vanta/server"

// Test setup: a local Vanta. Its URL replaces https://api.vanta.com in the application.
const server = await createServer()
const baseUrl = server.url

// Application code: the request it sends to Vanta.
const response = await fetch(`${baseUrl}/v1/people?pageSize=10`, {
  headers: { authorization: "Bearer mock_vanta_token" },
})
const { results } = await response.json()
console.log(results.pageInfo)

await server.close()
```

Run `mockingbird-vanta serve --port 12129` and inject `http://localhost:12129` as the
consumer's API origin. There is no universal Vanta SDK environment variable for this override;
the requested consumer uses raw fetch. Credentials and records are synthetic only.

### Contract

- `POST /oauth/token`: JSON client_credentials with client_id, client_secret and scope.
  Default clients: mock_read / mock_read_secret (read scope), mock_write / mock_write_secret
  (read, write and documents:upload). Tokens last one hour; minting another token for a client
  revokes its preceding token. mock_vanta_token is a seeded write-client bearer token.
- `GET /v1/people`, `/v1/tests`, `/v1/controls`, `/v1/documents`: results.data and results.pageInfo,
  pageSize (1–100, default 10), pageCursor. Follow endCursor while hasNextPage is true.
  Fixture insertion order is stable; resource ids serve as opaque cursors.
- `GET /v1/people/{personId}`, `/v1/documents/{documentId}`: seeded resource fields by id.
- `POST /v1/documents/{documentId}/uploads`: multipart file plus optional description and
  effectiveAtDate. Returns 201 uploaded-file metadata. Only metadata/byte length is retained,
  never the evidence bytes. Requires documents:upload scope.
- `POST /v1/documents/{documentId}/submit`: requires a pending upload and write scope;
  returns **204**, marks pending uploads submitted and document uploadStatus OK. The formal
  Manage Vanta OpenAPI specifies 204; a guide's 200 example is not followed.
- `POST /v1/people/offboard`: updates[] containing id and acknowledgerId. Returns 200 with
  ordered per-person SUCCESS/ERROR results. Only FORMER personnel with seeded eligibility
  flags (monitoredAccountsInactive, customTasksComplete) and a known acknowledger succeed.
  Failed items are unchanged. Successful items expose OFFBOARDING_COMPLETE in tasksSummary;
  a separate admin offboardings collection records acknowledger and completion time.

Read calls require all:read scope, submission/offboarding all:write, and upload documents:upload
(each prefixed vanta-api.). Missing/invalid/expired resource bearer tokens return literal
`Unauthorized` with application/json content type, matching an unauthenticated live probe.
Consumers must not assume every error body is parseable JSON. Other documented failure classes
use status plus message, with deterministic emulator messages rather than exact vendor wording.

### Controls and proof

Seed clients, people, documents, tests and controls through constructor options. Shared
`/__admin/state/{collection}` also exposes tokens, uploads, eligibility and offboardings.
Token expiresAt, document metadata, eligibility and upload submitted flags are configurable.
Shared clock, Timeline/snapshot, reset, faults and metadata-only journals apply. Reset restores
constructor fixtures. Namespace carriers: header, mapped bearer token, `/__admin/ns/{name}`.
Set adminPrefix to relocate all controls.

Presets: unauthorized_once, rate_limited, server_error, upload_failed, submit_failed and
connection_drop. Shared fault rules support latency. No webhook is required by this subset.

Tests cover all issue #270 behaviors through raw fetch, per-person eligibility, scope and token
revocation, metadata-only multipart handling, namespace/reset, failures and served HTTP.
Self-parity covers every generated JSON operation; multipart uploads have explicit acceptance
tests. `bun scripts/parity.ts --unauthenticated` verifies the observed non-JSON 401; it passed
with no real credentials. The optional read-only pagination-envelope probe needs VANTA_ACCESS_TOKEN
and has not run. Oracle: official Manage Vanta OpenAPI and authentication documentation.

### Deliberately not modelled

Real employee offboarding, accounts/integration task engines, evidence bytes/downloads, trust-center
UI, browser OAuth/refresh, automatic compliance evaluation, full vendor resource schemas, list
filter expressions and live quota accounting. Seed the fields the consumer reads; collections
echo them without fabricating compliance conclusions. Eligibility flags are explicit test controls,
not substitutes for real account deactivation. No real tenant mutation is ever necessary.

## API

- `VantaAPI`: FetchAPI, reset and collections.
- `createRuntime`: shared namespace/admin/clock/fault contract.
- `VANTA_NAMESPACE`, `VANTA_SCOPES`, `VANTA_PRESETS`: service constants.
- `document`, `operationIds`, `supportedOperationIds`: generated contract metadata.
- `createServer`, `serveTarget`, `DEFAULT_PORT` from `./server`: Node server and CLI targets.

Public types: Resource, Client, Token, Upload, Eligibility, VantaAPIOptions, OperationId,
SupportedOperationId; VantaServerOptions and VantaServer from ./server.
