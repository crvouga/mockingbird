# @crvouga/mockingbird-service-airtable

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

WIP Airtable OAuth and forms-integration emulator. Only synthetic fixtures belong here.

## Install

`bun add @crvouga/mockingbird-service-airtable`

## Usage

```ts
import { createServer } from "@crvouga/mockingbird-service-airtable/server"

const server = await createServer()

// The application's own HTTP call (airtable.js has no metadata API). Only the origin changes.
const response = await fetch(`${server.url}/v0/meta/bases`, {
  headers: { authorization: "Bearer mock_airtable_token" },
})
const { bases } = (await response.json()) as { bases: { id: string; name: string }[] }
console.log(bases.map((base) => base.id)) // ["appMockBase"]

await server.close()
```

Run `mockingbird-airtable serve --port 12130`. Inject its origin for both the API and OAuth origin in the optional integration; consumer endpoint wiring is separate.

## Surface and state

- POST `/oauth2/v1/token`: form-encoded authorization-code and refresh grants. Confidential clients require Basic credentials; public clients use body client_id. Codes require S256 PKCE and exact redirect/client binding, expire by clock, and are consumed before verifier checks so even a rejected verifier cannot replay them. Refresh rotates both tokens; access lasts 60 minutes and refresh 60 days. Scope reduction is allowed. The documented trailing space in `token_type: "Bearer "` is retained.
- GET `/v0/meta/whoami`: user id and scopes, plus email only with `user.email:read`.
- GET `/v0/meta/bases`: accessible bases/permission levels and opaque offset pages (`pageSize`, default 1000).
- GET `/v0/meta/bases/{baseId}/tables`: table schemas/fields/views for accessible bases.
- POST `/v0/meta/bases/{baseId}/tables/{tableId}/fields`: add supported form-field schemas and retain options.
- POST `/v0/{baseId}/{tableId}`: up to ten records, or one top-level fields object. Accept field ids or names; persist only after every input record validates. Empty cells are omitted. `returnFieldsByFieldId` controls response keys. Table name aliases work.

Default bearer `mock_airtable_token`, refresh `mock_airtable_refresh`, client `mock_client` / `mock_client_secret`; base `appMockBase`, table `tblMockTable`, field `fldMockName` named Name. Default scopes permit schema reads/writes, record writes, and synthetic email. Grant scopes and base roles gate operations independently. Missing/inaccessible bases yield 403; invalid/expired access yields 401; invalid cells yield 422 without partial records.

Seed `bases`, `tables`, `grants`, `clients`, `codes`, and `records` using constructor options or standard admin state. Fields supported for typed form writes: singleLineText, multilineText, richText, email, url, phoneNumber, number, percent, currency, duration, rating, checkbox, date, dateTime, singleSelect and multipleSelects. Options for choices, precision and checkbox appearance are retained; select values must name a seeded choice. Scalar validation covers wire types rather than every vendor presentation constraint. Unknown field types fail instead of silently accepting arbitrary values.

## Test controls

Standard relocatable `/__admin` health, state, reset, clock, Timeline checkpoints, request journal, metrics and faults. Header namespaces, `/__admin/ns/<name>` paths and bearer mappings isolate records/grants. Journals contain metadata only, not OAuth bodies or submitted form values. Presets: `unauthorized`, `rate_limited` (429, retry-after 30), `invalid_schema` (422), `server_error`, `connection_drop`. Generic fault rules add latency. No webhooks required.

## Oracle and tests

Follows official Airtable [OAuth](https://airtable.com/developers/web/api/oauth-reference), [identity](https://airtable.com/developers/web/api/get-user-id-scopes), [bases](https://airtable.com/developers/web/api/list-bases), [schema](https://airtable.com/developers/web/api/get-base-schema), [field creation](https://airtable.com/developers/web/api/create-field), [record creation](https://airtable.com/developers/web/api/create-records) and [errors](https://airtable.com/developers/web/api/errors) references. No successful live OAuth or SaaS writes were performed; no credentials used.

`bun test` runs raw-fetch acceptance, every-operation self-parity and divergence detection. The consumer is a faithful wire-surface port, not inaccessible private source. `bun run parity` requires `AIRTABLE_ACCESS_TOKEN`; it performs only a read-only identity-envelope probe, never printing identifiers.

## Deliberately not modelled

No actual SaaS writes, formulas/computed columns, linked records, attachments, collaborators, views editing, collaboration UI or production-integration activation. No typecast conversion, complete field-option/presentation validation, real quota accounting, exact error prose or internal offset format. Schema seeding may contain additional metadata; writes validate only the listed form-field types. OAuth retry grace/conflict timing, authorization UI and enterprise policy discovery are not simulated; fault controls can script these errors. Tokens/ids are local deterministic stand-ins.

## API

Root runtime exports: `AirtableAPI`, `AIRTABLE_NAMESPACE`, `createRuntime`, `AIRTABLE_PRESETS`, `document`, `operationIds`, `supportedOperationIds`. Types: `AirtableAPIOptions`, `Field`, `Table`, `Base`, `Grant`, `Client`, `OAuthCode`, `StoredRecord`, `AirtableRuntimeOptions`, `AirtableRuntime`, `OperationId`, `SupportedOperationId`.

`/server` exports `createServer`, `serveTarget`, `DEFAULT_PORT`; types `AirtableServerOptions`, `AirtableServer`.
