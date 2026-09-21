# @crvouga/mockingbird-service-portal-agent

Stateful mock of our **eRx portal agent** (the LifeFile / VPI browser runner) for test suites:
the job endpoint the backend posts fulfilment jobs to, a job store, and the callback the agent
posts back to `POST /prescriptions/webhooks/portal-agent` with `x-internal-key`. Jobs finish
only when a test says so (`POST /__admin/jobs/:id/complete`), so the eRx portal path runs
without a browser, a pharmacy portal or provider credentials.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/portal-agent/SUPPORT.md)
- The contract (`openapi.yaml`) is hand-authored from our backend's wire shapes
  (`portal-agent-fulfillment.base.ts`, the LifeFile and VPI adapters' `buildPayload`, and the
  pharmacy webhook controller). The portal agent is our own service, so there is no vendor spec.

## Install

```bash
npm install -D @crvouga/mockingbird-service-portal-agent
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-portal-agent serve`, `createServer` from `./server` (Node), or `createRuntime`
with any Fetch server.

## Usage

Point the app at the mock and give both sides the same keys:

| App env | Mock |
| --- | --- |
| `ERX_PORTAL_AGENT_API_URL` | the mock's URL (optionally with a `/ns/<name>` prefix) |
| `ERX_PORTAL_AGENT_API_KEY` | `--api-key` (omit to accept any bearer key) |
| `ERX_PORTAL_AGENT_CALLBACK_KEY` | `--callback-key` (sent as `x-internal-key`) |
| `ERX_PORTAL_AGENT_HTTP_TIMEOUT_MS` | default 20 s; the `slow` preset answers after 21 s |

```bash
npx mockingbird-portal-agent serve --port 8804 \
  --webhook-url http://127.0.0.1:3000/prescriptions/webhooks/portal-agent \
  --callback-key "$ERX_PORTAL_AGENT_CALLBACK_KEY" \
  --api-key "$ERX_PORTAL_AGENT_API_KEY"
```

```ts
import { createRuntime } from "@crvouga/mockingbird-service-portal-agent"

const agent = createRuntime({
  webhooks: { url: "http://127.0.0.1:3000/prescriptions/webhooks/portal-agent", secret: "cb-key" },
})
const post = (path: string, body: unknown) =>
  agent.fetch(
    new Request(`http://portal-agent.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )

// …the app posts POST /rx/portal-fulfillment/jobs and gets {status: "accepted", agentJobId}…
const [job] = agent.instance().jobs()
if (job) {
  await post(`/__admin/jobs/${job.agentJobId}/complete`, { status: "submitted" })
  await post(`/__admin/jobs/${job.agentJobId}/complete`, {
    status: "submitted",
    fulfillmentStatus: "shipped",
    trackingNumber: "1Z999",
  })
}
```

### Routes

| Route | Behaviour |
| --- | --- |
| `POST /rx/portal-fulfillment/jobs` | `Authorization: Bearer <key>` (any non-empty key unless `apiKeys` is set; else 401 `{status: "error", errorCode: "unauthorized", message}`). Validates the payload (`idempotencyKey`, `paymentId`, `pharmacyId` ∈ lifefile/vpi/pharmetika, `allowSubmit`, `portalCredentials {url https, username, password}`, `patient`, `prescriber`, `medication.name`, …); a violation is 400 `{status: "error", errorCode: "invalid_payload", errorDetail}`. Default answer: 202 `{status: "accepted", agentJobId: "job_…", message}`. With `respondWith` (or a `respond_*` preset) it answers 200 with a synchronous outcome: `submitted` (`portalOrderId`, `confirmationNumber`, `submittedAt`), `draft_ready` (`portalDraftOrderId`), `needs_review` (`needsReviewReason`) or `error` (`errorCode`, `errorDetail`). The same `idempotencyKey` with the same body replays the stored answer (`idempotent-replayed: true`); with a different body it is 409 `{status: "error", errorCode: "idempotency_key_reused"}`. |

Every answer follows the strict field rules our parser enforces: `status` is one of the five,
every optional field is a string, `accepted` carries `agentJobId`, `submitted` carries an order
id, `draft_ready` carries `portalDraftOrderId`. Presets break each rule on purpose.

### Callbacks

`POST /__admin/jobs/:id/complete {status, fulfillmentStatus?, portalOrderId?, portalDraftOrderId?,
confirmationNumber?, trackingNumber?, trackingCarrier?, message?, needsReviewReason?, errorCode?,
errorDetail?, screenshotArtifactId?}` posts `{status, paymentId, prescriptionOrderItemId,
pharmacyId, agentJobId, …}` (plus `portalOrderId`/`confirmationNumber`/`submittedAt` for
`submitted`, a `portalDraftOrderId` for `draft_ready`) with header `x-internal-key: <callback
key>` (plain equality, as our controller checks). The route first runs our controller's
`isPortalAgentFulfillmentCallback` rules and answers 400 for a callback the receiver would
reject; add `?force=1` to send it anyway (negative tests). Note: a job for `pharmacyId:
"pharmetika"` echoes that id, which our receiver refuses (it admits only lifefile and vpi).

Non-2xx answers are retried (immediately, 5 s, 5 min, 30 min, 2 h). `GET /__admin/webhooks`,
`/webhooks/events`, `POST /webhooks/flush`, `/webhooks/:id/replay` and
`PUT /__admin/webhook-endpoints` work as in every Mockingbird service.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `POST /__admin/jobs/:id/complete` | Fire the callback (above) and record the outcome on the job. Repeatable: send `submitted` with `fulfillmentStatus: processing`, then `shipped`, and so on. |
| `GET /__admin/jobs`, `GET /__admin/jobs/:id` | The namespace's jobs: metadata only (ids, payment id, pharmacy, flags, status, timestamps). |
| `PUT /__admin/settings` | `{apiKeys?: string[], respondWith?: {status, message?, needsReviewReason?, errorCode?, errorDetail?} \| null}`. |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`; `GET /__admin/faults/presets`):
`respond_submitted`, `respond_draft_ready`, `respond_needs_review`, `respond_error`,
`accepted_without_job_id`, `submitted_without_order_id`, `draft_ready_without_draft_id`,
`non_string_field` (each rejected by our parser as "an invalid success response"), `http_500`
(500 with `errorDetail`), `timeout` (the connection drops), `slow` (answers after 21 s, past
our 20 s timeout; or post your own `{latencyMs}` rule), `callback_duplicate`,
`callback_reorder`, `callback_drop`.

### Namespaces

`x-mockingbird-namespace`, a `/ns/<name>` prefix on `ERX_PORTAL_AGENT_API_URL`, or by bearer
key: `PUT /__admin/credentials {"credentials": {"<ERX_PORTAL_AGENT_API_KEY>": "<namespace>"}}`.

### Journal and secrets

The job payload carries LifeFile/VPI portal credentials and patient/prescriber PHI. None of it
is stored: the job store keeps metadata only, and the request journal records operation,
status and ids, never bodies.

### Deliberately not modelled

- The browser automation itself: no portal is driven, nothing is actually submitted, and
  `allowSubmit` / `stageForProviderSignature` are recorded but do not change the answer
  (choose the outcome with `respondWith`, presets or the complete route).
- Automatic completion: jobs finish only through `POST /__admin/jobs/:id/complete`.
- Screenshot artifacts: `screenshotArtifactId` is passed through when given, never produced.
- Portal credential verification: any well-formed credentials are accepted.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `PortalAgentAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `buildCallback(job, input)`, `complete(id, callback)`, `jobs()`. Options: `sqlite`, `now`, `namespace`, `settings`, `onCallback`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, namespaces, credentials, presets, callbacks). Options: `webhooks: {url, secret, retryDelaysMs?, fetch?}`, `settings`, `clock`, `seed`, `adminKey`, `onLog`. |
| `PORTAL_AGENT_PRESETS` | object | Every named fault preset. |
| `PORTAL_AGENT_NAMESPACE` | string | The service name, `"portal-agent"`. |
| `CALLBACK_KEY_HEADER` | string | `"x-internal-key"`. |
| `callbackIssues` | function | Why our receiver would reject a callback body (empty when it accepts it). |
| `CALLBACK_STATUSES`, `CALLBACK_FULFILLMENT_STATUSES`, `CALLBACK_PHARMACY_IDS` | arrays | The values our receiver admits. |
| `document`, `operationIds`, `supportedOperationIds` | values | The OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target; port 8804. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
