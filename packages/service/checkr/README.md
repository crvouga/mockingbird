# @crvouga/mockingbird-service-checkr

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

WIP Checkr v1 emulator for synthetic candidates, package/hierarchy enumeration, invitations
and seeded report/ETA reads. No checks run, emails are sent or real personal data is needed.

## Install

```sh
bun add -d @crvouga/mockingbird-service-checkr
```

## Usage

```ts
import { createServer } from "@crvouga/mockingbird-service-checkr/server"

// Test setup: the emulator. The application's Checkr origin becomes server.url.
const server = await createServer()
const baseUrl = server.url

// Application code: the request it sends to api.checkr.com, Basic auth with the API key.
const response = await fetch(`${baseUrl}/v1/packages`, {
  headers: { authorization: `Basic ${btoa("mock_checkr_key:")}` },
})
const packages = (await response.json()) as { data: { slug: string }[] }
await server.close()
```

Inject `server.url` into the consumer's origin seam; it replaces the production/staging
origin, not the `/v1` prefix. `createRuntime().fetch(Request)` supports in-process adapters.
Basic auth accepts `apiKey` (default `mock_checkr_key`) as username and an empty password.

### Routes

GET `/v1/packages`, `/v1/nodes`, `/v1/candidates`, `/v1/invitations` enumerate with
`page`/`per_page` and local `next_href` links. Candidate email and invitation candidate/status
filters are supported. POST `/v1/candidates` and `/v1/invitations` create records; invitations
validate candidate/package references and work locations before storing anything.
GET/DELETE `/v1/invitations/{id}` reads/cancels an invitation. Cancellation is deletion,
not an invented `canceled` status: `deleted_at` is set, ordinary reads/lists exclude it,
and GET `?include_deleted=true` exposes it. This follows the documented cancellation/delete
and include_deleted mechanism; the reference's generic DELETE response example does not
demonstrate post-delete timestamps. Pending invitations expire after seven days by default.
GET `/v1/reports/{id}` and `/v1/reports/{id}/eta` read seeded reports; missing ETA returns 404.

### State and controls

Runtime seeds: `packages`, `nodes`, `candidates`, `reports`; `hierarchyEnabled` defaults false,
so nodes returns 403 while other APIs work. Enabled hierarchy requires an available node/package
on invitation creation. `invitationTtlMs` and the emulator clock drive expiration.
All records and settings are collections in `/__admin/state`: edit prices, report state/ETA,
invitation expiry/completion and hierarchy access without external services. An admin-seeded
report is reflected in its candidate's report_ids. The admin controls intentionally do not
enforce vendor referential integrity; seed coherent fixtures.

Standard admin reset, Timeline snapshots/branches, clocks and journals are available.
Namespaces use `x-mockingbird-namespace`, `/__admin/ns/<name>/…`, or mapped Basic credentials;
pagination URLs retain the namespace, including relocated `adminPrefix` paths.
Journals retain request metadata only, not candidate data or credentials.
Presets: `forbidden`, `hierarchy_denied`, `rate_limited`, `server_error`, `non_json`,
`connection_drop`. Generic fault latency and client AbortSignal model deterministic timeouts.
No webhooks are implemented or claimed.

### Verification

`bun test` covers each reported behavior through a raw-fetch client port, served HTTP,
namespaces/faults/reset, independent OpenAPI walks and deliberately divergent instances.
No official SDK is used by this consumer. The port follows the issue's surface; unchanged
private app acceptance is not claimed. The [official Checkr reference](https://docs.checkr.com/)
is the oracle; no live credentials or background-check requests were used.
`CHECKR_API_KEY=… bun run parity` safely checks a package-list response shape; without the
key it exits 2. It never creates candidates, invitations or reports.

## Deliberately not modelled

Actual background screening, criminal records, real PII, invitation email delivery, hosted
candidate consent UI, webhook delivery and production adjudication decisions. Reports are
explicit synthetic fixtures; no automatic report is created merely by inviting a candidate.
Error diagnostic strings and full vendor per-field validation are outside this scoped WIP.

## API

Root runtime exports: `CheckrAPI`, `CHECKR_NAMESPACE`, `DEFAULT_PACKAGES`, `createRuntime`,
`CHECKR_PRESETS`, `document`, `operationIds`, `supportedOperationIds`.
Types: `Package`, `Node`, `Candidate`, `Invitation`, `Report`, `CheckrAPIOptions`,
`CheckrRuntimeOptions`, `CheckrRuntime`, `OperationId`, `SupportedOperationId`.
The `/server` entry exports `createServer`, `serveTarget`, `DEFAULT_PORT`.
