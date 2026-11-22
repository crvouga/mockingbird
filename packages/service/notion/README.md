# @crvouga/mockingbird-service-notion

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

WIP Notion **2022-06-28** database search, OAuth token exchange, database-parent page creation and
block-children reads.
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
- `GET /v1/blocks/{block_id}/children`: the read that returns a page's content (a page id is also a
  block id; hyphenated or 32-hex ids resolve to the same page). Returns the documented
  `{object: "list", results, next_cursor, has_more, type: "block", block: {}}` with blocks in seeded
  order; each block carries `id`, `type`, `has_children`, `parent` and a `<type>` object
  (`rich_text[].plain_text`, `to_do.checked`, `code.language` / `code.caption[].plain_text`).
  A block with `has_children: true` lists its nested blocks from its own id, to any depth.
  `page_size` defaults to and is capped at 100. Block shapes are **docs-verified**
  (<https://developers.notion.com/reference/get-block-children>), not oracle-verified. **Best guess,
  not oracle-verified:** the opaque `next_cursor` (the last returned block's id; an unknown
  `start_cursor` is `400 validation_error`), the exact error messages, `404 object_not_found` for an
  unknown id or a page outside the grant, `400 validation_error` for a non-UUID id, and `401`
  `unauthorized` for a missing or unknown token. The 429 and 5xx cases use the shared presets.

The default fixture is one synthetic survey database (Name/title, Score/number) with
`mock_notion_token`. Configure `databases`, `grants`, `clients` and `codes` for other
workspaces and OAuth scenarios. No authorization browser or webhooks are required by this subset.

### Controls

`PUT /__admin/pages/{id}/blocks` seeds a page's block tree from a nested outline, e.g.
`{"blocks": [{"type": "heading_1", "text": "FAQ"}, {"type": "toggle", "text": "Q", "children": [{"type": "code", "text": "x", "language": "bash", "caption": "c"}]}], "workspaceId"?, "title"?}`.
Types: `paragraph`, `heading_1..3`, `bulleted_list_item`, `numbered_list_item`, `to_do` (`checked`),
`toggle`, `quote`, `callout`, `code` (`language`, `caption`), `divider`. The emulator expands the
outline into Notion's block shape and replaces any earlier tree for that page; an unknown id becomes a
standalone page. The whole outline is validated first: a problem is `400` and nothing is stored.
Block writes through the API (`PATCH`, update, delete) are not modelled.

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

New data-source APIs, full rich-text rendering/mentions, block writes (reads and admin seeding exist), block types beyond the list above, database editing/querying,
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
- `BLOCK_TYPES`: the block types the admin block outline accepts.
- `document`, `operationIds`, `supportedOperationIds`: generated OpenAPI metadata.
- `createServer`, `serveTarget`, `DEFAULT_PORT` from `./server`: Node HTTP/CLI target
  (default port 12127).

Public types: `Property`, `Database`, `Grant`, `OAuthCode`, `Client`, `Page`,
`NotionAPIOptions`, `OperationId`, `SupportedOperationId`.
