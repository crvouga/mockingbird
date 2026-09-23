# @crvouga/mockingbird-service-plane

Stateful mock of the **Plane** REST API (v1) for test suites, covering what our bug-report
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
env-driven). Point it at the mock; `PLANE_ACCESS_TOKEN`, `PLANE_WORKSPACE_SLUG` and
`PLANE_BUGS_PROJECT_ID` can be any values (the project id must be a UUID, as our config
validates).

```bash
npx mockingbird-plane serve --port 8821 --rate-limit 60
```

```ts
import { createRuntime } from "@crvouga/mockingbird-service-plane"

const plane = createRuntime()
const base = "http://plane.test/api/v1/workspaces/geviti/projects/33333333-3333-4333-8333-333333333333"
const headers = { "x-api-key": "plane_api_test", "content-type": "application/json" }

const created = await plane.fetch(
  new Request(`${base}/work-items/`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Checkout fails on Safari" }),
  }),
)
const item = (await created.json()) as { id: string }
// Resolve it the way a teammate would; the resolution watcher then sees group "completed".
await plane.fetch(
  new Request(`http://plane.test/__admin/work-items/${item.id}/state`, {
    method: "POST",
    headers,
    body: JSON.stringify({ state: "Done" }),
  }),
)
```

### Routes

All under `/api/v1/workspaces/{slug}/projects/{project_id}/`, with `X-API-Key`.

| Route | Behaviour |
| --- | --- |
| `GET work-items/` | `per_page` (≤ 100), `cursor=<per_page>:<page>:<is_prev>`, `order_by` (default `-created_at`). Plane's envelope: `results`, `next_cursor`, `prev_cursor`, `next_page_results`, `prev_page_results`, `count`, `total_count`, `total_pages`, `total_results`, `grouped_by`, `sub_grouped_by`, `extra_stats`. A malformed cursor is 400. |
| `POST work-items/` | `{name, description_html?, state?, labels?, priority?}` → 201 with a UUID `id`, per-project `sequence_id`, `state` (default Backlog), `labels`, `created_at`… Unknown state / label ids are DRF 400s (`{"state": ["Invalid pk \"…\" - object does not exist."]}`); a missing name is `{"name": ["This field is required."]}`. |
| `GET` / `PATCH work-items/{id}/` | Read or partially update (`state`, `labels`, `name`, `description_html`, `priority`). `completed_at` follows the state's group. |
| `GET` / `POST work-items/{id}/comments/` | `{comment_html, access?}` → 201 comment. |
| `GET` / `POST work-items/{id}/links/` | `{url, title?}` → 201 link; the same URL twice is 409 `{error, id}`. |
| `GET states/` | The project's workflow states (`id`, `name`, `group`, `color`, `sequence`, `default`). |
| `GET` / `POST labels/` | `{name, color?, description?}` → 201 label; a duplicate name is 409 `{error, id: <existing>}`. |

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
| `GET/PUT /__admin/settings` | `{apiKeys?, rateLimitPerMinute?: number \| null, projects?: ["<slug>/<uuid>"]}`. `rateLimitPerMinute: 60` reproduces Plane's limit on the mock clock; `projects` pins which projects exist (others 404). |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`): `rate_limited` (429),
`server_error` (500), `bad_gateway` (502 HTML), `unauthorized` (401), `invalid_json` (200
non-JSON on reads), `network_drop`, `slow` (15 s, past our 10 s timeout),
`pagination_missing_cursor`, `pagination_repeated_cursor`. Our client retries GETs at 0, 2 and
8 s, so `count: 2` recovers on the third attempt and `count: 3` exhausts the budget; writes are
never retried.

### Namespaces

`x-mockingbird-namespace`, a `/ns/<name>` prefix on the base URL, or by API key:
`PUT /__admin/credentials {"credentials": {"<PLANE_ACCESS_TOKEN>": "<namespace>"}}`.

### Deliberately not modelled

- Plane webhooks (our app polls), cycles, modules, pages, intake, attachments, members,
  estimates, worklogs, and `expand=`.
- Deleting work items, comments, links or labels; archiving.
- Rich-text processing: `description_stripped` / `comment_stripped` are tag-stripped text.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `PlaneAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `ensureProject(slug, id)`, `statesOf(id)`, `labelsOf(id)`, `moveToState(itemId, stateIdOrName)`, `applyPatch(item, patch)`, `workItems()`. Options: `sqlite`, `now`, `namespace`, `settings`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, namespaces, credentials, presets). Options: `settings`, `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `PLANE_PRESETS` | object | Every named fault preset. |
| `PLANE_NAMESPACE` | string | The service name, `"plane"`. |
| `DEFAULT_STATES` | array | The workflow a new project starts with. |
| `apiKeyCredential` | function | The `X-API-Key` a request carries (how credentials map to namespaces). |
| `uuidFrom` | function | The deterministic v4-shaped UUID the mock derives from a string. |
| `document`, `operationIds`, `supportedOperationIds` | values | The OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target (`--api-key`, `--rate-limit`); port 8821. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
