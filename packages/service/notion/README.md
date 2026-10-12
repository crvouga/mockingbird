# @crvouga/mockingbird-service-notion

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

WIP Notion **2022-06-28** database search, OAuth token exchange and database-parent page creation.
This is the legacy database API, not the newer data-source API.

## Install

```sh
bun add @crvouga/mockingbird-service-notion
```

## Usage

```ts
import { Client } from "@notionhq/client"
import { createRuntime } from "@crvouga/mockingbird-service-notion"

// The app's own Notion client. Only its fetch changes: requests reach the
// emulator in this process instead of api.notion.com.
const emulator = createRuntime()
const notion = new Client({
  auth: "mock_notion_token",
  notionVersion: "2022-06-28",
  fetch: (url: string, init?: RequestInit) => emulator.fetch(new Request(url, init)),
})
const { results } = await notion.search({ filter: { property: "object", value: "database" }, page_size: 100 })
const [database] = results
if (database?.object === "database") console.log(database.properties)
```

The example uses `@notionhq/client@2.2.15`, the SDK line for this API version. Run
`mockingbird-notion serve --port 12127` and inject `http://localhost:12127` as the
consumer's API origin (the SDK's `baseUrl`). Keep `/v1` in raw request paths. No universal vendor
environment variable exists for this origin override. The reported integration uses raw fetch.

### Contract

- `POST /v1/oauth/token`: HTTP Basic client credentials and a JSON authorization-code grant.
  Constructor/admin-seeded codes bind a client, redirect URI and workspace grant. Codes are
  single-use; successful exchange returns token, bot and workspace metadata.
- `POST /v1/search`: Bearer grant plus `Notion-Version: 2022-06-28`. Returns legacy
  `page_or_database` lists with database ids/properties, query filtering, page_size,
  start_cursor, next_cursor and has_more. Results are limited to the granted workspace and
  database ids. Fixture insertion order is stable; relevance ranking is not modelled.
- `POST /v1/pages`: database_id parent and properties addressed by name or id. Successful
  writes return 200 with a page UUID and retain the parent/properties. Unknown or inaccessible
  parents return 404; read-only grants return 403. Unknown properties and wrong value types
  return 400 without partial writes.

The default fixture is one synthetic survey database (Name/title, Score/number) with
`mock_notion_token`. Configure `databases`, `grants`, `clients` and `codes` for other
workspaces and OAuth scenarios. No authorization browser or webhooks are required by this subset.

### Controls

Shared `/__admin/state/{databases,grants,clients,codes,pages}` surfaces seed and inspect records.
Reset restores constructor fixtures and clears created pages. Shared Timeline, clock, journal
and fault APIs apply; logs do not contain page contents or credentials. Use only synthetic data.
Namespaces are selected by header, `/__admin/ns/{name}` prefix or mapped bearer tokens.
Set `adminPrefix` to relocate controls.

Presets: `unauthorized`, `rate_limited` (429, Retry-After), `server_error` (503) and
`connection_drop`. Shared fault rules support latency and one-shot failures.

Acceptance tests cover issue #284 through raw fetch, OAuth binding/replay, schema errors,
pagination, isolation/reset, journal redaction and served HTTP. Property tests exercise all
three operations and detect divergence. `bun scripts/parity.ts` requires `NOTION_API_KEY`;
it only checks a pinned-version empty search, never creating real pages. Live parity has not run.
The official SDK v2.2.15 types provide the archived wire-contract evidence.

### Deliberately not modelled

New data-source APIs, full rich-text rendering/mentions, blocks, database editing/querying,
page-parent creation, relevance sorting, full page/database response metadata, formulas,
rollups, select-option creation, relationship resolution and full vendor field constraints.
Property validation checks the requested schema's value kind: title/text, number, checkbox,
nullable strings/dates, select/status/multi-select, people/relation ids and file objects.
It does not emulate every Notion property limit or expand typed request values to full response objects.
Only the pinned API version is accepted.

## API

- `NotionAPI`: FetchAPI with `fetch`, `reset` and database/grant/client/code/page collections.
- `createRuntime`: shared admin, namespace, clock, faults and journal contract.
- `NOTION_NAMESPACE`: service name.
- `NOTION_PRESETS`: deterministic fault presets.
- `DEFAULT_DATABASES`: synthetic survey schema.
- `document`, `operationIds`, `supportedOperationIds`: generated OpenAPI metadata.
- `createServer`, `serveTarget`, `DEFAULT_PORT` from `./server`: Node HTTP/CLI target
  (default port 12127).

Public types: `Property`, `Database`, `Grant`, `OAuthCode`, `Client`, `Page`,
`NotionAPIOptions`, `OperationId`, `SupportedOperationId`.
