# @crvouga/mockingbird-service-formbricks

Stateful mock of open-source **[Formbricks](https://github.com/formbricks/formbricks)** (6.x) for
test suites: the client environment state the JS SDK loads surveys from, response creation with
upstream's validation and `{code, message, details}` errors, the v1 management API (responses and
surveys, `x-api-key`), the widget script the web SDK loads, and the response pipeline's
**`responseCreated` / `responseFinished` webhooks**. Every namespace is seeded with a small
synthetic survey corpus (`src/corpus/surveys.json`: NPS, Onboarding, Product Feedback, a link
survey and a paused survey; invented content).

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/formbricks/SUPPORT.md)
- The contract (`openapi.yaml`) is hand-authored from upstream Formbricks 6.0.0's route handlers
  and the [docs](https://formbricks.com/docs).

## Install

```bash
npm install -D @crvouga/mockingbird-service-formbricks
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-formbricks serve`, `createServer` from `./server` (Node), or `createRuntime`
with any Fetch server.

## Usage

Point the SDK's `appUrl` (and your management API base URL) at the mock, use the workspace id
`cworkspace000000000000001` (or its legacy environment id `cenvironment0000000000001`, as older
SDKs send), and any management API key.

```bash
npx mockingbird-formbricks serve --port 8813 \
  --webhook-url http://127.0.0.1:3000/webhooks/formbricks \
  --webhook-secret "whsec_…"
```

```ts
import { createRuntime, WORKSPACE_ID } from "@crvouga/mockingbird-service-formbricks"

const formbricks = createRuntime({
  webhooks: { url: "http://127.0.0.1:3000/webhooks/formbricks", secret: "whsec_…" },
})
// …the app POSTs /api/v2/client/<workspace>/responses {surveyId, finished: true, data}…
// the mock validates it, stores it, and posts responseFinished to the webhook.
const response = await formbricks.fetch(new Request("http://formbricks.test/__admin/responses"))
```

### Routes

Client routes take a workspace id or a legacy (pre-Formbricks-5) environment id in the path; both
resolve to the same workspace.

| Route | Behaviour |
| --- | --- |
| `GET /api/v1/client/{workspace}/environment` | `{data: {data: {surveys, actionClasses, workspace, project}, expiresAt}}` (`project` is upstream's legacy alias of `workspace`). Only `app` surveys `inProgress`, with the SDK's survey fields and `projectOverwrites` mirroring `workspaceOverwrites`. A malformed id is 400 `Invalid ID format`; an unknown one 404 `Workspace not found`. |
| `POST /api/v2/client/{workspace}/responses` | `{surveyId, finished, data, contactId?, meta?, …}` → `{data: {id, quotaFull: false}}`. An unknown workspace is 404; input errors are 400 `Fields are missing or incorrectly formatted` with zod 4 `details` (`{surveyId: "Invalid cuid2", finished: "Invalid input: expected boolean, received undefined"}`; `userId` is not part of the v2 input and is ignored); a `contactId` while contacts are off is 403 (Enterprise); an unknown survey 404; a survey of another workspace 400 `Survey is part of another workspace`; a survey not `inProgress` 403 `Survey is not accepting submissions`. `data` keeps only element ids and declared hidden fields (`hiddenFields.fieldIds`); other keys are dropped. Element validation checks only the elements present in `data` (finished or not): required → `Please fill out this field`; a choice outside a choice element's options (when it has no "other") → `Please enter a valid format`; openText email / url / phone → `Please enter a valid …`; 400 `Validation failed` with `details: {"response.data.<elementId>": "<messages joined by '; '>"}`. `meta` keeps `source`, `url`, `action` and the auto-captured page / UTM / screen keys, plus `userAgent` and `country` (from `CF-IPCountry`). `language` is canonicalized (`en` → `en-US`); a finished response's `ttc` gains `_total`. |
| `GET /api/v1/management/responses?surveyId=&limit=&skip=` | `{data: [response]}`, newest first; an unknown `surveyId` is 404. |
| `GET /api/v1/management/responses/{id}` | `{data: response}` or 404. |
| `GET /api/v1/management/surveys?limit=&offset=` | `{data: [survey]}`, most recently updated first. |
| `POST /api/v1/management/surveys` | `{workspaceId (or legacy environmentId), name, type?, status?, blocks \| questions}` → `{data: survey}`. Legacy `questions` become one block each; both or neither is 400; a missing workspace id is 400 `workspaceId must be provided`, an unknown one 404. |
| `GET /api/v1/management/surveys/{id}` | `{data: survey}` or 404. |
| `GET /js/formbricks.umd.cjs` | A no-op script defining `window.formbricks` (every SDK method resolves). |

Management surveys carry `questions` derived from `blocks` (block button labels on the block's last
element), `workspaceId`, the legacy `environmentId`, and `projectOverwrites`. Management routes
need `x-api-key` (any non-empty key, unless `apiKeys` is set), else 401
`{code: "not_authenticated", message: "Not authenticated", details: {"x-Api-Key": "…"}}`.

### Webhooks

`POST <webhook-url>` with `{webhookId, event, data: {...response, survey: {title, type, status,
createdAt, updatedAt}}}`, headers `webhook-id`, `webhook-timestamp` and, when the endpoint has a
`whsec_…` secret, `webhook-signature: v1,<base64 HMAC-SHA256>` (Standard Webhooks). Only events an
endpoint subscribes to are sent: `responseFinished` by default (`events: ["responseCreated",
"responseFinished"]` for both). `--webhook-token` appends a `?token=` for receivers that check one.
Retries, `GET /__admin/webhooks`, `…/events`, `…/replay`, `…/flush` and
`PUT /__admin/webhook-endpoints` work as usual.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `GET /__admin/responses?surveyId=` | Stored responses, oldest first. |
| `GET\|PUT /__admin/surveys` | Read, or add / replace surveys (`[{id, name, type?, status?, workspaceId?, blocks?, questions?, …}]`; no `workspaceId` = served by every configured workspace). |
| `GET\|PUT /__admin/contacts` | Read, or add contacts (`[{id, userId?, attributes?, workspaceId?}]`) for `contactId` responses. |
| `GET\|PUT /__admin/settings` | `{workspaces?, legacyEnvironmentIds?, apiKeys?, webhookId?, contactsEnabled?}`. |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`; `GET /__admin/faults/presets`):
`rate_limited` (429 `too_many_requests`), `server_error` (500), `missing_response_id` (stored, but
no id in the answer), `environment_unavailable`, `data_as_string` (management `data` as a JSON
string), `management_unauthorized`, `connection_drop`, `duplicate` (the next webhook twice),
`webhook_drop`, `webhook_reorder`.

### Namespaces

`x-mockingbird-namespace`, a `/ns/<name>` prefix on the app URL, or by credential: the workspace
(or legacy environment) id in the client paths (the SDK cannot add headers) or the management
`x-api-key`, through `PUT /__admin/credentials {"credentials": {"<workspace id or key>":
"<namespace>"}}`.

### Deliberately not modelled

- Displays, contacts / identify, `user` and `storage` routes of the client API (the widget script
  is a no-op, so the SDK never calls them); response updates (`PUT …/responses/{id}`).
- Quotas (always `quotaFull: false`), single-use links, PIN protection, reCAPTCHA, email
  verification, file-upload checks, the "other" option length check, custom `validation.rules`,
  survey logic, and the full survey schema on create (only the shapes above are checked).
- The Embedded Data ingest contract beyond its allow-list (locked fields, coercion, size limits),
  `userAgent` parsing (always `{device: "desktop"}`), and language canonicalization beyond common
  bare codes.
- Organizations, API-key permissions (`unauthorized`), and the rest of the management API; the
  Formbricks UI.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `FormbricksAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `responses()`, `render(record)`, `wireSurvey(survey)`, `pipeline(event, record, survey)`, `state`. Options: `sqlite`, `now`, `namespace`, `surveys`, `settings`, `onWebhook`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, namespaces, credentials, presets, webhooks). Options: `webhooks: {url, secret?, events?, retryDelaysMs?, fetch?}`, `surveys`, `settings`, `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `FORMBRICKS_PRESETS` | object | Every named fault preset. |
| `FORMBRICKS_NAMESPACE` | string | The service name, `"formbricks"`. |
| `WEBHOOK_PATH` | string | A conventional receiver path for examples, `/webhooks/formbricks`. |
| `formbricksCredential` | function | The workspace id or API key a request carries. |
| `formbricksError` | function | Build Formbricks' `{code, message, details}` error response. |
| `validateResponseData` | function | Upstream's element validation: `(survey, data, language?)` → `{elementId: messages}` or `null`. |
| `CORPUS_SURVEYS` | value | The synthetic survey corpus every namespace is seeded with. |
| `WORKSPACE_ID`, `ENVIRONMENT_ID`, `DEFAULT_SETTINGS` | values | The default workspace, its legacy environment id, and the default settings. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target; port 8813. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
