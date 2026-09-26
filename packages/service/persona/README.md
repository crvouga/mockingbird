# @crvouga/mockingbird-service-persona

Stateful mock of **Persona**'s identity-verification API for test suites: create an inquiry,
the "reusable inquiry" list lookup, fetch one inquiry, the hosted flow page members are sent
to, and the `Persona-Signature`-signed events Persona posts back. Inquiries move only when a
test says so (an admin action or a click on the hosted page), so the Rx consultation's ID
verification step (flag `rx-id-verification`) runs without a real sandbox or a real selfie.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/persona/SUPPORT.md)
- Persona publishes no OpenAPI document: the contract (`openapi.yaml`) is hand-authored from
  Persona's API reference (JSON:API, `Persona-Version: 2023-01-05`) and our EMR's zod schemas.

## Install

```bash
npm install -D @crvouga/mockingbird-service-persona
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-persona serve`, `createServer` from `./server` (Node), or `createRuntime` with
any Fetch server.

## Usage

Point the EMR at the mock (all of these are required in `E/config/env.ts`):

| EMR env | Value |
| --- | --- |
| `PERSONA_API_URL` | `http://127.0.0.1:8815` (or `…/ns/<namespace>`) |
| `PERSONA_API_KEY` | any bearer (or the one passed as `--api-key`) |
| `PERSONA_WEB_INQUIRY_URL`, `PERSONA_MOBILE_INQUIRY_URL` | `http://127.0.0.1:8815/verify` |
| `PERSONA_IDENTITY_INQUIRY_TEMPLATE_ID`, `PERSONA_PHONE_INQUIRY_TEMPLATE_ID` | any `itmpl_…` ids |
| `PERSONA_WEBHOOK_SECRET` | the value passed as `--webhook-secret` |

```bash
npx mockingbird-persona serve --port 8815 \
  --webhook-url http://127.0.0.1:4000/v1/identify-verification/webhook \
  --webhook-secret "$PERSONA_WEBHOOK_SECRET"
```

```ts
import { createRuntime } from "@crvouga/mockingbird-service-persona"

const persona = createRuntime({
  webhooks: { url: "http://127.0.0.1:4000/v1/identify-verification/webhook", secret: "wbhsec_test" },
})
const created = await persona.fetch(
  new Request("http://persona.test/inquiries", {
    method: "POST",
    headers: { authorization: "Bearer persona_sandbox_x", "content-type": "application/json" },
    body: JSON.stringify({
      data: { type: "inquiry", attributes: { "inquiry-template-id": "itmpl_identity", "reference-id": "patient-1" } },
    }),
  }),
)
const { data } = (await created.json()) as { data: { id: string } }

// Finish it the way a member and Persona's workflow would: started → completed → approved,
// one signed event per step.
await persona.fetch(new Request(`http://persona.test/__admin/inquiries/${data.id}/approve`, { method: "POST" }))
```

### Routes

| Route | Behaviour |
| --- | --- |
| `POST /inquiries` | JSON:API `{data: {type: "inquiry", attributes: {inquiry-template-id \| template-id, reference-id, redirect-uri, fields, note, platform}}}` → 201 `{data: <inquiry>, included: []}`, status `created`, id `inq_` + 24 chars. No template → 400; a template not in `settings.templates` (or not `itmpl_…`/`tmpl_…` when unset) → 422. Emits `inquiry.created`. |
| `GET /inquiries` | `filter[reference-id]`, `filter[inquiry-template-id]`, `filter[status]` (comma list), `page[size]` (1–100, default 10), `page[after]`. Newest first; `links.next` is the next page. |
| `GET /inquiries/{id}` | The inquiry, or 404 `{errors: [{title: "Record not found", detail, status: "404"}]}`. |
| `GET /verify?inquiry-id=&redirect-uri=` | The hosted flow page (`PERSONA_WEB_INQUIRY_URL`). Opening it starts the inquiry (`pending`, `inquiry.started`); its links finish it. |
| `GET /verify/complete?inquiry-id=&outcome=&redirect-uri=` | `outcome` = `approve`, `decline`, `needs_review`, `complete` or `fail`; then 302 to `redirect-uri?inquiry-id=&status=&reference-id=`. |

The inquiry resource carries Persona's attributes (`status`, `reference-id`, `note`,
`created-at`, `started-at`, `completed-at`, `failed-at`, `decisioned-at`, `expired-at`,
`name-first`/`name-last`/`birthdate` from prefill, `fields` as `{type, value}`) and
relationships (`inquiry-template.data {type: "inquiry-template", id}`, empty `reports`,
`verifications`, `sessions`, `documents`, `selfies`). Errors are JSON:API with a **string**
`status`, which our consumer's `PersonaErrorSchema` requires.

Auth: `Authorization: Bearer <key>` on every API route (missing → 401 JSON:API error).
`PUT /__admin/settings {"apiKeys": [...]}` restricts which keys are accepted.

### Lifecycle and webhooks

`created → pending → completed → approved | declined | needs_review`, plus `failed` and
`expired` from an open inquiry. A decision on an open inquiry passes through `completed` first
(as a member finishing the flow and a workflow deciding would), so each step emits its own
event: `inquiry.created`, `inquiry.started`, `inquiry.completed`, `inquiry.approved`,
`inquiry.declined`, `inquiry.marked-for-review`, `inquiry.failed`, `inquiry.expired`.

Each event is Persona's envelope, `{data: {type: "event", id: "evt_…", attributes: {name,
payload: {data: <inquiry>, included: [], meta: {}}, created-at}}}`, posted with
`Persona-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`. The timestamp is
wall clock. Non-2xx answers are retried (immediately, 5 s, 5 min, 30 min, 2 h);
`GET /__admin/webhooks`, `/__admin/webhooks/events`, `POST /__admin/webhooks/flush`,
`/__admin/webhooks/:id/replay` and `PUT /__admin/webhook-endpoints` work as everywhere.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `POST /__admin/inquiries/:id/{approve\|decline\|needs_review}` | The catalog's decisions (via `completed` when the inquiry is still open). |
| `POST /__admin/inquiries/:id/{start\|complete\|fail\|expire}` | The other lifecycle steps. An illegal move is 409, an unknown id 404. |
| `GET /__admin/inquiries` | The namespace's inquiries. |
| `GET/PUT /__admin/settings` | `{apiKeys?: string[], templates?: string[]}` for the calling namespace. |
| `POST /__admin/signature-faults` | `{mode: "mismatch" \| "short", count?}`: the next events are signed wrong. `mismatch` keeps the length (our receiver answers 401); `short` truncates the hex (our receiver's `timingSafeEqual` throws: a 500). |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`): `list_fails` (the
reusable lookup 500s; our client fails open and creates), `create_fails`, `not_found`,
`unauthorized`, `rate_limited` (429), `server_error`, `slow` (3 s), `webhook_duplicate`,
`webhook_reorder`, `webhook_drop`.

### Namespaces

`x-mockingbird-namespace`, a `/ns/<name>` prefix on `PERSONA_API_URL` and
`PERSONA_WEB_INQUIRY_URL` (the hosted page's links keep it), or by API key:
`PUT /__admin/credentials {"credentials": {"<PERSONA_API_KEY>": "<namespace>"}}`.

### What our consumer does with it (discrepancies)

- Our EMR acts only on `status === "completed"` (`updateIdentityVerificationForPatient`);
  `approved`/`declined` events are parsed and ignored. So a declined inquiry has already marked
  the member verified at `completed`. The mock sends both events so suites can see that.
- Our receiver compares signatures with `crypto.timingSafeEqual`, which throws on a length
  mismatch: a wrong-length `v1=` is an uncaught 500, not a 401 (`signature-faults` `short`).
- There is no official Persona Node SDK in our consumer (plain `fetch`), so there is no SDK
  drop-in test.

### Deliberately not modelled

- Verifications, reports, sessions, documents and selfies: the relationships are always empty
  and no government-ID or selfie capture happens. The hosted page is a set of links.
- Inquiry templates' steps and workflows (`next-step-name` is only `start` / `success`), resume
  session tokens (`POST /inquiries/{id}/resume`), redaction, tags and accounts.
- Inquiry expiry on a timer: inquiries expire only through `…/expire`.
- The embedded (JS SDK / iframe) flow and mobile SDKs.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `PersonaAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `transition(id, action)`, `inquiries()`. Options: `sqlite`, `now`, `namespace`, `publicNamespace`, `settings`, `onWebhook`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, namespaces, credentials, presets, webhooks). Options: `webhooks: {url, secret, retryDelaysMs?, fetch?}`, `settings`, `clock`, `seed`, `adminKey`, `onLog`. |
| `PERSONA_PRESETS` | object | Every named fault preset. |
| `PERSONA_SIGNATURE_HEADER` | string | `"Persona-Signature"`. |
| `PERSONA_NAMESPACE`, `PERSONA_VERSION` | string | `"persona"`, `"2023-01-05"`. |
| `INQUIRY_ACTIONS` | array | The admin lifecycle actions. |
| `inquiryResource` | function | Serialize an inquiry record as Persona's JSON:API resource. |
| `personaErrors` | function | A JSON:API error response (string `status`). |
| `DEFAULT_SETTINGS` | object | Default per-namespace settings. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target; port 8815. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
