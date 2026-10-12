# @crvouga/mockingbird-service-plane

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful emulator of the **Plane** REST API (v1) for test suites, covering what our bug-report
dedup and resolution jobs call on one project: work items (Plane's cursor-paginated list, get,
create, patch), comments, links, states and labels, with Plane's rate limit and error shapes.
Projects are provisioned on first use with Plane's default workflow (Backlog, Todo, In
Progress, Done, Cancelled), so no setup is needed.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/plane/SUPPORT.md)
- The contract (`openapi.yaml`) is hand-authored from Plane's API reference and the consumer's
  zod schemas (`plane-response.ts`).

## Install

```bash
npm install -D @crvouga/mockingbird-service-plane
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-plane serve`, `createServer` from `./server` (Node), or `createRuntime` with
any Fetch server.

## Usage

The backend hardcodes `https://api.plane.so` (`plane-http-client.ts`, seam **G-Y1**: make it
env-driven). Point it at the emulator; `PLANE_ACCESS_TOKEN`, `PLANE_WORKSPACE_SLUG` and
`PLANE_BUGS_PROJECT_ID` can be any values (the project id must be a UUID, as our config
validates).

```bash
npx mockingbird-plane serve --port 8821 --rate-limit 60
```

In a test, the application's Plane SDK (`@makeplane/plane-node-sdk`) takes the emulator's URL as
its `baseUrl`:

```ts
import { PlaneClient } from "@makeplane/plane-node-sdk"
import { createServer } from "@crvouga/mockingbird-service-plane/server"

// Test setup: a local Plane.
const server = await createServer()

// Application code: Plane's SDK. Only its base URL changes.
const plane = new PlaneClient({ baseUrl: server.url, apiKey: "plane_api_test" })
const projectId = "33333333-3333-4333-8333-333333333333"
const item = await plane.workItems.create("acme", projectId, { name: "Checkout fails on Safari" })

// Test control: resolve it the way a teammate would; the resolution watcher then sees group
// "completed".
await fetch(`${server.url}/__admin/work-items/${item.id}/state`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ state: "Done" }),
})

await server.close()
```

### Routes

All under `/api/v1/workspaces/{slug}/projects/{project_id}/`, with `X-API-Key`. `{slug}` is your
workspace's slug (`acme` in the examples).

| Route | Behaviour |
| --- | --- |
| `GET work-items/` | `per_page` (≤ 100), `cursor=<per_page>:<page>:<is_prev>`, `order_by` (default `-created_at`). Plane's envelope: `results`, `next_cursor`, `prev_cursor`, `next_page_results`, `prev_page_results`, `count`, `total_count`, `total_pages`, `total_results`, `grouped_by`, `sub_grouped_by`, `extra_stats`. A malformed cursor is 400. |
| `POST work-items/` | `{name, description_html?, state?, labels?, priority?}` → 201 with a UUID `id`, per-project `sequence_id`, `state` (default Backlog), `labels`, `created_at`… Unknown state / label ids are DRF 400s (`{"state": ["Invalid pk \"…\" - object does not exist."]}`); a missing name is `{"name": ["This field is required."]}`. |
| `GET` / `PATCH work-items/{id}/` | Read or partially update (`state`, `labels`, `name`, `description_html`, `priority`). `completed_at` follows the state's group. |
| `GET` / `POST work-items/{id}/comments/` | `{comment_html, access?}` → 201 comment. |
| `GET` / `POST work-items/{id}/links/` | `{url, title?}` → 201 link; the same URL twice is 409 `{error, id}`. |
| `GET states/` | The project's workflow states (`id`, `name`, `group`, `color`, `sequence`, `default`). |
| `GET` / `POST labels/` | `{name, color?, description?}` → 201 label; a duplicate name is 409 `{error, id: <existing>}`. |
| `GET` / `POST cycles/` | Create with `{name, description?, start_date?, end_date?, external_source?, external_id?}`. Both dates must be present or null. Lists use the cursor envelope (default 20 rows); `cycle_view=current` returns a bare array. Other views: `all`, `upcoming`, `completed`, `draft`, `incomplete`. |
| `GET` / `POST cycles/{id}/cycle-issues/` | POST `{issues: [<work item UUID>]}` adds or moves items and returns membership rows, without duplicates. GET returns paginated work items with their latest fields. Unknown/foreign item IDs are ignored; missing cycles are 404. Completed cycles reject additions with `CYCLE_COMPLETED`. |
| `GET work-item-types/` | A bare array of seeded type metadata, including stable UUIDs, names, `project_ids`, default/active flags and timestamps. This endpoint has no cursor pagination. |

Seed types through `POST /__admin/work-item-types`, then send `type_id` on work-item create or
patch. GET returns both `type_id` and `type`, as Plane's
[work-item serializer](https://github.com/makeplane/plane/blob/c7a5afee6afd15f16038ebda1ec1489ebd8af67d/apps/api/plane/api/serializers/issue.py)
does. Unknown IDs fail with a DRF `type_id` error before any field or sequence number changes.
Creation inherits a seeded default type; an explicit patch `type_id: null` clears it.

Cycle dates use UTC project days and the emulator clock, following Plane's
[cycle endpoint](https://github.com/makeplane/plane/blob/c7a5afee6afd15f16038ebda1ec1489ebd8af67d/apps/api/plane/api/views/cycle.py)
and [date converter](https://github.com/makeplane/plane/blob/c7a5afee6afd15f16038ebda1ec1489ebd8af67d/apps/api/plane/utils/timezone_converter.py):
future/past starts are 00:00:01, today's start is the creation time, and ends are 23:59:00.
The current filter includes both endpoints. Cycle counts follow work-item state changes.

Errors: no key 401 `{"detail": "Authentication credentials were not provided."}`, a key outside
`apiKeys` 401 `{"detail": "Given API token is not valid"}`, unknown item/project 404
`{"error": "The requested resource does not exist."}`, throttled 429 `{"detail": "Request was
throttled. Expected available in N seconds."}` with `x-ratelimit-*` headers.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `POST /__admin/work-items/:id/state` | `{state: "<id or name>"}`: move an item (e.g. to `Done`) as a teammate would. |
| `GET /__admin/work-items` | The namespace's work items. |
| `POST /__admin/projects` | `{workspace, project}`: provision a project now; answers its states and labels. |
| `POST /__admin/work-item-types` | `{workspace, project, types: [{name, description?, is_default?}]}`: seed project type metadata with stable IDs; repeat calls update metadata and preserve creation time. Types start empty. Invalid batches do not partially write. |
| `GET/PUT /__admin/settings` | `{apiKeys?, rateLimitPerMinute?: number \| null, projects?: ["<slug>/<uuid>"]}`. `rateLimitPerMinute: 60` reproduces Plane's limit on the emulator clock; `projects` pins which projects exist (others 404). |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`): `rate_limited` (429),
`server_error` (500), `bad_gateway` (502 HTML), `unauthorized` (401), `invalid_json` (200
non-JSON on reads), `network_drop`, `slow` (15 s, past our 10 s timeout),
`pagination_missing_cursor`, `pagination_repeated_cursor`. Our client retries GETs at 0, 2 and
8 s, so `count: 2` recovers on the third attempt and `count: 3` exhausts the budget; writes are
never retried.

### Namespaces

`x-mockingbird-namespace`, a `/__admin/ns/<name>` prefix on the base URL, or by API key:
`PUT /__admin/credentials {"credentials": {"<PLANE_ACCESS_TOKEN>": "<namespace>"}}`.

### Deliberately not modelled

- Plane webhooks (our app polls), cycle editing/deletion and non-UTC project timezones, modules, pages, intake, attachments, members,
  estimates, worklogs, and `expand=`.
- Deleting work items, comments, links or labels; archiving.
- Vendor work-item type administration, custom type schemas, epics and cross-project type sharing. Seed types with the admin control for this list/assignment surface.
- Rich-text processing: `description_stripped` / `comment_stripped` are tag-stripped text.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `PlaneAPI` | class | The in-process emulator: `fetch(request)`, `reset()`, `ensureProject(slug, id)`, `statesOf(id)`, `labelsOf(id)`, `moveToState(itemId, stateIdOrName)`, `applyPatch(item, patch)`, `workItems()`. Options: `sqlite`, `now`, `namespace`, `settings`. |
| `createRuntime` | function | The emulator with the full service contract (health, admin, namespaces, credentials, presets). Options: `settings`, `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `PLANE_PRESETS` | object | Every named fault preset. |
| `PLANE_NAMESPACE` | string | The service name, `"plane"`. |
| `DEFAULT_STATES` | array | The workflow a new project starts with. |
| `apiKeyCredential` | function | The `X-API-Key` a request carries (how credentials map to namespaces). |
| `uuidFrom` | function | The deterministic v4-shaped UUID the emulator derives from a string. |
| `document`, `operationIds`, `supportedOperationIds` | values | The OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target (`--api-key`, `--rate-limit`); port 8821. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
