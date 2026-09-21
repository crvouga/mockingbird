# @crvouga/mockingbird-service-fullscript

Stateful mock of the **Fullscript** lab-ordering API for test suites: per-practitioner OAuth
(consent redirect, `authorization_code` and rotating `refresh_token` grants, revoke), the
clinic, embeddable session grants, lab orders with tests and results, lab-order events, expiring
result PDFs, and `Fullscript-Signature` webhooks with the challenge acknowledgement our receiver
implements. Lab orders move forward only, through exactly Fullscript's states, when a test says
so.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/fullscript/SUPPORT.md)
- The contract (`openapi.yaml`) is hand-authored from the EMR consumer
  (`fullscript-api-client.ts`, `fullscript-event-model.ts`, `fullscript-webhook-signature.ts`,
  `routers/v1/fullscript/webhook-controller.ts`, `fullscript-result-storage.ts`).

## Install

```bash
npm install -D @crvouga/mockingbird-service-fullscript
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-fullscript serve`, `createServer` from `./server` (Node), or `createRuntime`
with any Fetch server.

## Usage

With `FEATURE_FULLSCRIPT_LABS_ENABLED=true`, point `FULLSCRIPT_API_URL` at the mock and
`FULLSCRIPT_OAUTH_AUTHORIZE_URL` at its `/oauth/authorize`; set `FULLSCRIPT_WEBHOOK_SECRET` and
`FULLSCRIPT_WEBHOOK_CHALLENGE_KEY` and pass the same values as `--webhook-secret` /
`--webhook-challenge`. The EMR validates these URLs as **https** and downloads result PDFs only
over https from allowlisted hosts (by default `fullscript.com`, `fullscript.io` and
`FULLSCRIPT_API_URL`'s host, which is where the mock serves them), so front the mock with TLS or
set `--results-base-url`.

```bash
npx mockingbird-fullscript serve --port 8819 \
  --webhook-url http://127.0.0.1:4000/v1/fullscript/webhooks \
  --webhook-secret "$FULLSCRIPT_WEBHOOK_SECRET" --webhook-challenge "$FULLSCRIPT_WEBHOOK_CHALLENGE_KEY"
```

```ts
import { createRuntime } from "@crvouga/mockingbird-service-fullscript"

const fullscript = createRuntime({
  webhooks: { url: "http://127.0.0.1:4000/v1/fullscript/webhooks", secret: "whsec", challenge: "chal" },
})
const admin = (path: string, body: unknown) =>
  fullscript.fetch(
    new Request(`https://fullscript.test/__admin${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
const order = (await (await admin("/lab-orders", { patientId: "fs_pat_1", treatmentPlanId: "tp_1" })).json()) as { id: string }
await admin(`/lab-orders/${order.id}/transition`, { to: "purchased" }) // order.placed + lab_order.updated
await admin(`/lab-orders/${order.id}/transition`, { to: "results_ready" }) // results + PDF URLs
```

### Routes

| Route | Behaviour |
| --- | --- |
| `GET /oauth/authorize` | Auto-consents as `practitioner_id` (default `prac_mock_1`) and redirects to `redirect_uri?code=…&state=…`. |
| `POST /api/oauth/token` | JSON `{grant_type, client_id, client_secret, code \| refresh_token, redirect_uri}` → `{oauth: {access_token, token_type: "Bearer", expires_in: 7200, refresh_token, scope, created_at, resource_owner: {id, type, clinic_id}}}`. Codes are single-use, expire in 10 minutes and must match the redirect URI; refresh tokens rotate (a spent one is `invalid_grant`). Errors: 400 `{error: "invalid_grant" \| "invalid_request"}`, 401 `invalid_client`. |
| `POST /api/oauth/revoke` | `{client_id, client_secret, token}` → 200 `{}`; the token stops working. |
| `GET /api/clinic` | `{clinic: {id, name}}` of the token's practitioner. |
| `POST /api/clinic/embeddable/session_grants` | 201 `{secret_token, expires_at}`. |
| `GET /api/clinic/labs/orders` | `?patient_id=&page[number]=&page[size]=` → `{orders: [{id, state, treatment_plan_id, …}], meta: {current_page, next_page, …}}`. |
| `GET /api/clinic/labs/orders/{id}` | `{order: {…, collection_method, tests, results: [{id, name, state, pdf_url}], latest_aggregated_result: {id, artifact_id, pdf_url, status}}}`. |
| `GET /api/events/lab_orders` | `?order_by=DESC\|ASC&page[number]=&page[size]=` → the clinic's `lab_order.updated` events. |
| `GET /api/events/{id}` | `{event: {id, type, clinic_id, created_at, data}}`. |
| `GET /results/{artifact}?expires&signature` | The result PDF (`application/pdf`, a real one-page PDF) until the URL expires (15 minutes), then 403. |

API errors are `{errors: [{code, message}]}` (401 `unauthorized` / `invalid_token` /
`token_expired`, 404 `not_found`); our client reads the code.

**States** (forward only, jumps allowed): `not_purchased` → `purchased` →
`schedule_appointment` → `upcoming_appointment` → `processing` → `partial_results` (first
test's result) → `results_ready` (every result + an aggregated result) → `interpretation_shared`
→ `results_amended` (a new aggregated artifact).

### Webhooks

Each move emits `lab_order.updated` (`data.lab_order: {id, state, treatment_plan_id,
patient_id}`), and the move out of `not_purchased` also emits `order.placed` (`data: {id,
treatment_plan_ids, patient_id, line_items: [{type: "labs"}]}`). Deliveries post
`{event_payload: {event}}` with `Fullscript-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret,
"<t>." + body)>` (wall-clock `t`). With a challenge key, a delivery counts only when the
receiver answers `{challenge: <key>}` (otherwise it is recorded as 502 and retried).
`POST /__admin/webhooks/verify` sends Fullscript's empty-body registration ping and reports
whether each endpoint echoed the challenge. `GET /__admin/webhooks`, `…/events`, `…/replay`,
`…/flush` as usual.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `POST /__admin/lab-orders` | `{patientId, id?, clinicId?, treatmentPlanId?, name?, collectionMethod?, tests?: [names]}` → a `not_purchased` order. |
| `POST /__admin/lab-orders/:id/transition` | `{to: <state>}`; backwards or same-state is 409. |
| `GET /__admin/lab-orders`, `GET /__admin/events` | The namespace's orders and events. |
| `POST /__admin/oauth/codes` | `{practitionerId?, clientId?, redirectUri?}` → `{code}` without the browser redirect. |
| `POST /__admin/practitioners` | `{id, clinicId, type?, clinicName?}`. |
| `POST /__admin/webhooks/verify` | The registration ping (see Webhooks). |
| `GET/PUT /__admin/settings` | `{clients?, accessTokenTtlSeconds?, codeTtlSeconds?, pdfUrlTtlSeconds?, resultsBaseUrl?}`. |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`): `token_expired`,
`invalid_grant`, `rate_limited`, `server_error`, `events_schema_drift`, `pdf_not_pdf`,
`pdf_redirect`, `pdf_expired`, `connection_drop`, `slow`, `webhook_duplicate`,
`webhook_reorder`, `webhook_drop`.

### Namespaces

A `/ns/<name>/` suffix on `FULLSCRIPT_API_URL` (our client resolves relative `api/…` paths, so
the prefix survives, and PDF URLs keep it), `x-mockingbird-namespace`, or by OAuth client for
API calls (`PUT /__admin/credentials {"credentials": {"<FULLSCRIPT_CLIENT_ID>": "<ns>"}}`;
tokens carry the client they were issued to). Token requests carry the client only in their
body, so they need the prefix or the header.

### Deliberately not modelled

- Catalog, treatment plans, patients, dispensary orders and every non-lab endpoint; the
  embedded widget itself (session grants are opaque tokens).
- Lab result values (only PDFs), requisitions and appointment booking.
- Real consent screens: `/oauth/authorize` approves immediately.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `FullscriptAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `issueCode(practitionerId, clientId, redirectUri)`, `createOrder(input)`, `transition(orderId, state)`, `seedOrder(seed)`, `labOrders()`, `eventsList()`. Options: `sqlite`, `now`, `namespace`, `publicNamespace`, `settings`, `orders`, `onEvent`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, namespaces, credentials, presets, webhooks). Options: `webhooks: {url, secret, challenge?, retryDelaysMs?, fetch?}`, `settings`, `orders`, `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `FULLSCRIPT_PRESETS` | object | Every named fault preset. |
| `FULLSCRIPT_NAMESPACE` | string | The service name, `"fullscript"`. |
| `SIGNATURE_HEADER` | string | `Fullscript-Signature`. |
| `LAB_ORDER_STATES`, `isLabOrderState` | values | The forward-only state order. |
| `DEFAULT_CLINIC`, `DEFAULT_PRACTITIONER` | objects | The seeded clinic and practitioner. |
| `RESULT_PDF` | bytes | The PDF every result URL serves. |
| `issueAccessToken` | function | Mint a self-verifying access token (for tests and parity). |
| `tokenCredential` | function | The OAuth client a bearer token was issued to (how credentials map to namespaces). |
| `envelope`, `publicEvent` | functions | An event's webhook body and API shape. |
| `apiErrors`, `oauthError` | functions | Build Fullscript's API and OAuth error responses. |
| `document`, `operationIds`, `supportedOperationIds` | values | The OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target (`--webhook-url`, `--webhook-secret`, `--webhook-challenge`, `--client`, `--results-base-url`); port 8819. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
