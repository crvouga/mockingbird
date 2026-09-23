# @crvouga/mockingbird-service-formbricks

Stateful mock of **Formbricks** (as our fork, geviti-formbrick, serves it) for test suites: the
client environment state our member app and backend load surveys from, response creation with
the fork's validation and `{code, message, details}` errors, the v1 management API (responses and
surveys, `x-api-key`), the widget script the web SDK loads, and the **`responseFinished`
webhook** that nothing sends in non-prod today. Surveys are seeded from our committed production
clone (`packages/forms-fixtures/formbricks/prod-clone.json`).

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/formbricks/SUPPORT.md)
- The contract (`openapi.yaml`) is hand-authored from the fork's route handlers and our
  consumers.

## Install

```bash
npm install -D @crvouga/mockingbird-service-formbricks
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-formbricks serve`, `createServer` from `./server` (Node), or `createRuntime`
with any Fetch server.

## Usage

Point `FORMBRICKS_APP_URL` at the mock (instead of the backend's compat shim), keep
`FORMBRICKS_ENVIRONMENT_ID` (`cmlhiza9j0009lj01my5c1g0q` production or `cmlhiza9c0004lj01jbuhp0nz`
development; both serve the clone), set any `FORMBRICKS_API_KEY`, and pass the backend's
`FORMBRICKS_WEBHOOK_SECRET` as `--webhook-token`.

```bash
npx mockingbird-formbricks serve --port 8813 \
  --webhook-url http://127.0.0.1:3000/onboarding-tasks/formbricks-webhook \
  --webhook-token "$FORMBRICKS_WEBHOOK_SECRET"
```

```ts
import { createRuntime } from "@crvouga/mockingbird-service-formbricks"

const formbricks = createRuntime({
  webhooks: { url: "http://127.0.0.1:3000/onboarding-tasks/formbricks-webhook?token=s3cret" },
})
// …the member app POSTs /api/v2/client/<env>/responses {surveyId, finished: true, data, userId}…
// the mock validates it, stores it, and posts responseFinished to the backend.
const response = await formbricks.fetch(new Request("http://formbricks.test/__admin/responses"))
```

### Routes

| Route | Behaviour |
| --- | --- |
| `GET /api/v1/client/{env}/environment` | `{data: {data: {surveys, actionClasses, project}, expiresAt}}` (our consumers read `data.surveys ?? data.data.surveys`). Surveys are served as stored (blocks, elements, logic, `questions`), `inProgress` only. A malformed env id is 400 `Invalid environment ID format`; an unknown one 404 `not_found`. |
| `POST /api/v2/client/{env}/responses` | `{surveyId, finished, data, userId?, meta?, …}` → `{data: {id, quotaFull: false}}`. Input errors are 400 `Fields are missing or incorrectly formatted` with zod-style `details` (`{surveyId: "Invalid cuid2", finished: "Required"}`); an unknown survey 404; a survey of another environment 400. Element validation (every element when `finished`, only present ones otherwise): required → `Please fill out this field`; openText email / url / phone → `Please enter a valid …`; 400 `Validation failed` with `details: {"response.data.<elementId>": "<messages joined by '; '>"}`. `userId` (the member's email) finds-or-creates a contact (`contact: {id, userId}`); unknown top-level and `meta` keys are stripped. |
| `GET /api/v1/management/responses?surveyId=&limit=&skip=` | `{data: [response]}`, newest first. |
| `GET /api/v1/management/responses/{id}` | `{data: response}` or 404. |
| `GET /api/v1/management/surveys?environmentId=` | `{data: [survey]}`. |
| `POST /api/v1/management/surveys` | `{environmentId, name, type?, status?, questions?, blocks?}` → `{data: survey}` (it belongs to that environment only). |
| `GET /api/v1/management/surveys/{id}` | `{data: survey}` (our intake sync reads `questions[].metadata.intakeField`) or 404. |
| `GET /js/formbricks.umd.cjs` | A no-op script defining `window.formbricks` (every SDK method resolves). |

Management routes need `x-api-key` (any non-empty key, unless `apiKeys` is set), else 401
`{code: "not_authenticated", message: "Not authenticated", details: {"x-Api-Key": "…"}}`.

### Webhooks

`POST <webhook-url>` (carrying our `?token=`) with `{webhookId, event, data: {...response,
survey: {title, type, status, createdAt, updatedAt}}}`, headers `webhook-id`,
`webhook-timestamp` and, when the endpoint has a `whsec_…` secret, `webhook-signature: v1,<base64
HMAC-SHA256>` (Standard Webhooks; our receiver does not verify it). Only events an endpoint
subscribes to are sent: `responseFinished` by default (`events: ["responseCreated",
"responseFinished"]` for both). Retries, `GET /__admin/webhooks`, `…/events`, `…/replay`,
`…/flush` and `PUT /__admin/webhook-endpoints` work as usual.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `GET /__admin/responses?surveyId=` | Stored responses, oldest first. |
| `GET\|PUT /__admin/surveys` | Read, or add / replace surveys (`[{id, name, type?, status?, environmentId?, blocks?, questions?, …}]`; no `environmentId` = served by every configured environment). |
| `GET\|PUT /__admin/settings` | `{environments?, apiKeys?, webhookId?, contactsEnabled?}`. |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`; `GET /__admin/faults/presets`):
`rate_limited` (429 `too_many_requests`; the member app retries ×3), `server_error` (500),
`missing_response_id` (stored, but no id in the answer), `environment_unavailable`,
`data_as_string` (management `data` as a JSON string), `management_unauthorized`,
`connection_drop`, `duplicate` (the next webhook twice: our receiver does not dedupe),
`webhook_drop`, `webhook_reorder`.

### Namespaces

`x-mockingbird-namespace`, a `/ns/<name>` prefix on `FORMBRICKS_APP_URL`, or by credential: the
environment id in the client paths (the member app's fetch cannot add headers) or the
management `x-api-key`, through `PUT /__admin/credentials {"credentials": {"<env id or key>":
"<namespace>"}}`.

### Deliberately not modelled

- Formbricks' **Postgres**: backend eRx and the form sources also read it directly
  (`FORMBRICKS_DATABASE_URL`); an HTTP mock cannot cover that path.
- The rest of the JS SDK protocol (displays, contacts/identify, `app/sync`, storage): the widget
  script is a no-op, so the SDK never calls them.
- Quotas (always `quotaFull: false`), single-use links, reCAPTCHA, the "other" option length
  check, custom `validation.rules` on elements (only `required` and the implicit openText
  email / url / phone rules are applied), response updates (`PUT …/responses/{id}`).
- Survey editing beyond create; the Formbricks UI.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `FormbricksAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `responses()`, `render(record)`, `pipeline(event, record, survey)`, `state`. Options: `sqlite`, `now`, `namespace`, `surveys`, `settings`, `onWebhook`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, namespaces, credentials, presets, webhooks). Options: `webhooks: {url, secret?, events?, retryDelaysMs?, fetch?}`, `surveys`, `settings`, `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `FORMBRICKS_PRESETS` | object | Every named fault preset. |
| `FORMBRICKS_NAMESPACE` | string | The service name, `"formbricks"`. |
| `WEBHOOK_PATH` | string | Our receiver's path, `/onboarding-tasks/formbricks-webhook`. |
| `formbricksCredential` | function | The environment id or API key a request carries. |
| `formbricksError` | function | Build the fork's `{code, message, details}` error response. |
| `validateResponseData` | function | The fork's element validation: `(survey, data, finished)` → `{elementId: messages}` or `null`. |
| `PROD_CLONE_SURVEYS`, `PROD_CLONE_EXPORTED_AT` | values | The seeded production survey clone and when it was exported. |
| `PRODUCTION_ENVIRONMENT_ID`, `DEVELOPMENT_ENVIRONMENT_ID`, `DEFAULT_SETTINGS` | values | Our environment ids and the default settings. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target; port 8813. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
