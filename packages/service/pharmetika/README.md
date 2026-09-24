# @crvouga/mockingbird-service-pharmetika

Stateful mock of the **Pharmetika** compounding-pharmacy provider portal for test suites:
clinic and patient lookup, patient create, medication-order validate / EPCS prepare / submit /
lookup, the v7 cancel, the medication-template catalog, and the status webhooks the pharmacy
posts back. Orders move only when a test says so (an admin transition or an auto-advance path on
the mock clock).

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/pharmetika/SUPPORT.md)
- The vendor publishes no spec: the contract (`openapi.yaml`) is hand-authored from the wire
  shapes our consumer reads and writes (`pharmetika-fulfillment.adapter.ts`,
  `pharmetika-live.client.ts`, and the bodies recorded in the adapter's spec).
- **The success rule.** Every body carries Pharmetika's `success` flag. Only `true` or `1` is
  success: the mock answers business failures (unknown patient, controlled substance on submit,
  a reused order id, …) as **HTTP 200 with `success: 0`** and `messages: [{message, type}]`, the
  case our adapter guards against.

## Install

```bash
npm install -D @crvouga/mockingbird-service-pharmetika
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-pharmetika serve`, `createServer` from `./server` (Node), or `createRuntime` with
any Fetch server.

## Usage

Point `PHARMETIKA_API_URL` at the mock and give the app any `PHARMETIKA_API_TOKEN` (or pin one
with `--api-token`). Set `PHARMETIKA_WEBHOOK_SECRET` in the app and pass the same value as
`--webhook-secret`. `PHARMETIKA_PRACTITIONER_IDENTIFIER` can be any string;
`PHARMETIKA_CLINIC_NAME=Acme` picks the seeded clinic.

```bash
npx mockingbird-pharmetika serve --port 8801 \
  --webhook-url http://127.0.0.1:3000/prescriptions/webhooks/pharmetika \
  --webhook-secret "$PHARMETIKA_WEBHOOK_SECRET" \
  --auto-advance "2000:data_entry,shipped,completed"
```

```ts
import { createRuntime } from "@crvouga/mockingbird-service-pharmetika"

const pmk = createRuntime({
  webhooks: { url: "http://127.0.0.1:3000/prescriptions/webhooks/pharmetika", secret: "whsec" },
})
const admin = (path: string, body: unknown) =>
  pmk.fetch(
    new Request(`http://pharmetika.test/__admin${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )

// …the app validates and submits PUT /api/v5/provider_portal/medication_order/id/<uuid>/submit…

// Move the order the way the pharmacy would; each step posts the status webhook.
await admin("/orders/<uuid>/transition", { to: "data_entry" })
await admin("/orders/<uuid>/transition", { to: "shipped", tracking_id: "1Z999" })
await admin("/orders/<uuid>/transition", { to: "completed" })
```

### Routes

All provider-portal routes need `x-pmk-authentication-token` (any non-empty token unless
`tokens` is set); a missing or rejected token is `401 {success: 0, messages}`.

| Route | Behaviour |
| --- | --- |
| `GET /api/v5/provider_portal/clinic/clinic_list` | `{success: 1, data: [{identifier, data: {name}}]}`. Seeded with `Acme` and `Acme West`. |
| `GET /api/v5/provider_portal/provider/patient_list` | `{success: 1, data: [{patient_id, demographics: {first_name, last_name, DOB, email, phone_primary, line_1, postal_code}}]}`. Starts with one sandbox patient (id 1, "Sandbox Patient"). |
| `POST /api/v5/provider_portal/patient/create_new` | A FHIR `Patient` plus `clinic_identifier`. Created: `{success: true, patient_id, messages: [{message: "Added Patient!"}]}`. Same first/last name and DOB as an existing patient: `{success: 0, duplicate_entry_count, duplicate_entries: [...]}` (our adapter adopts the match). |
| `PUT …/medication_order/id/{uuid}/validate` | Dry run. Checks the clinic, the patient id, each `product_identifier` against the templates, and a non-empty `sig` ("Please provide instructions"). Answers `data: {controlled_substance_list_count, medication_list: [{…entry, medication_order_entry_identifier, controlled, control_level}]}`; a scheduled product (testosterone is C-III) sets `controlled`. |
| `PUT …/medication_order/id/{uuid}` | EPCS prepare (needs `prepared_by`). Parks the order at `pending_prescriber_approval`; it is **never submitted**. The prescriber "signs" with an admin transition to `signed`. |
| `PUT …/medication_order/id/{uuid}/submit` | Creates the order at `prescription_entered`. A controlled substance is refused (`success: 0`). **Idempotent by the UUIDv7**: a resubmit of the same clinic / patient / products / quantities / sigs (our adapter regenerates `date_issued` and entry ids on every attempt, so those are ignored) answers as the first did; different contents under a used id is `409 {success: 0}`; a concurrent submit of the same id is `409`. |
| `GET …/medication_order/id/{uuid}` | `{success: 1, data: {order_status, medication_order_identifier, electronic_prescription_order_number, data: {order_status, …, ancillary_order_data: {medication_order_status: {workflow_status, tracking_id}}}}}`; unknown ids 404. |
| `PUT /api/v7/provider_portal/medication_order/entry/cancel` | `{note, prescriber_order_number: <uuid>}` → `{success: 1, messages: []}` until the order ships; afterwards (or unknown) `success: 0`. Emits the webhook. |
| `GET /api/pharmetika/provider_access/profile/medication_templates` | `{success: 1, data: [{template_identifier, medication_display_name, description, map_dose_to_product: {dose: product_identifier}, qty_options, default_sigs, available_states, controlled}]}`. Accepts the token, Basic (`PHARMETIKA_USERNAME/PASSWORD`, any pair unless `basic` is set), or no credentials (unless `anonymousCatalog: false`) — our client's three fallbacks. |

### Webhooks

Every status change posts to `--webhook-url` with header `x-pharmetika-webhook-secret: <secret>`
(plain equality, as our receiver checks). The body shape follows the namespace's
`webhookVariant`, one per field fallback our receiver reads:

| Variant | Body |
| --- | --- |
| `workflow_status` (default) | `{event_type, event_data: {electronic_prescription_order_number, medication_order_identifier, medication_order_status: {workflow_status, tracking_id}, tracking_id?, updated_at}}` |
| `status` | `{event_type, event_data: {medication_order_identifier, status, tracking_id?}}` |
| `flat` | `{medication_order_identifier, medication_order_workflow_status, tracking_id?}` |

Both id fields carry our UUIDv7 (the receiver looks payments up by it). Non-2xx answers are
retried (immediately, 5 s, 5 min, 30 min, 2 h). `GET /__admin/webhooks` lists deliveries,
`GET /__admin/webhooks/events` the payloads, `POST /__admin/webhooks/flush` runs pending retries,
`PUT /__admin/webhook-endpoints` sets per-namespace receivers.

### Status map

Transitions set `workflow_status` verbatim, so any string works. The ones our mapper knows:

| Workflow status | Our status |
| --- | --- |
| `completed`, `shipped-received`, `delivered` | delivered |
| `shipped`, `Completed Orders` | shipped |
| `cancelled` | cancelled |
| `data_entry*`, `lab_formulation`, `contacting_patient`, `compounding*`, `filled`, `dispensed`, `dispense_checked`, `dispense_verified`, `order_reconciliation`, `shipping`, `signed`, `verified`, `checked`, `ready`, `ready-ship`, `Complete Processing` | processing |
| anything else (`prescription_entered`, `pending_prescriber_approval`) | submitted |

Shipped-or-later statuses generate a `tracking_id` when none is given; a tracking id promotes
submitted/processing to shipped in our receiver.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `POST /__admin/orders/:uuid/transition` | `{to, tracking_id?}`: set the workflow status and emit the webhook. |
| `GET /__admin/orders` | The namespace's orders (ids and statuses only). |
| `GET /__admin/patients`, `POST /__admin/patients` | Read or seed the roster: `{patient_id?, clinic_identifier?, demographics: {first_name, last_name, DOB, …}}`. |
| `PUT /__admin/templates` | Replace the medication templates (`{templates: [...]}`). |
| `GET`/`PUT /__admin/settings` | `{tokens?, basic?, anonymousCatalog?, webhookVariant?, autoAdvance?: {afterMs, path} \| null}` for the calling namespace. |
| `POST /__admin/tick` | Apply due auto-advance steps (the served mock ticks every 100 ms). Orders awaiting prescriber approval never auto-advance. |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`; `GET /__admin/faults/presets`):

| Preset | Effect |
| --- | --- |
| `validate_success_zero`, `submit_success_zero`, `prepare_success_zero`, `lookup_success_zero` | HTTP 200 with `success: 0` and a message |
| `validate_422` | 422 `{success: 0, messages: [{message: "Please provide instructions"}]}` |
| `success_boolean` | successes answer `success: true` instead of `1` |
| `success_string` | successes answer `success: "1"` (our client reads it as failure) |
| `cancel_success_true` | cancel answers `success: true` (our cancel accepts only `1`) |
| `submitted_but_500` | submit records the order, then answers 500; the retry replays success |
| `patient_create_duplicate`, `patient_create_500` | the create is refused as a duplicate (naming the patient), or fails |
| `clinic_list_keyed` | `clinic_list` answers `data` as an object keyed by identifier |
| `controlled_count_string`, `controlled_nested_requests` | validate's controlled-substance signal as a string count, or under `data.medication_requests` |
| `unauthorized`, `server_error` | 401 on every call; 500 on every provider-portal call |
| `webhook_duplicate`, `webhook_reorder`, `webhook_drop` | delivery faults on the next status webhooks |

### Namespaces

Our backend's `fetch` cannot add headers, so a namespace can be chosen three ways:
`x-mockingbird-namespace`, a `/ns/<name>` prefix on `PHARMETIKA_API_URL`, or by credential:
`PUT /__admin/credentials {"credentials": {"<PHARMETIKA_API_TOKEN>": "<namespace>"}}` (the Basic
username works the same way for the catalog client).

### Deliberately not modelled

- Real fulfilment timing and the pharmacy's internal queue: nothing moves on its own unless
  `autoAdvance` is set.
- EPCS signing itself (two-factor, DEA checks): an admin transition to `signed` stands for it.
- Sigs, demographics on orders, documents and reason-for-compounding are validated, never stored
  or echoed; only the roster keeps the demographics `patient_list` returns.
- The live catalog: the default templates are synthesised in the fields the live client parses
  (no sandbox recording exists); pass `templates` or `PUT /__admin/templates` to load recorded rows.
- Refills, reauthorizations and multi-order shipments.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `PharmetikaAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `transition(uuid, {to, tracking_id?})`, `tick()`, `orders()`, `webhookBody(order)`. Options: `sqlite`, `now`, `namespace`, `templates`, `clinics`, `patients`, `settings`, `onWebhook`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, namespaces, credentials, presets, webhooks). Options: `webhooks: {url, secret, retryDelaysMs?, fetch?}`, `settings`, `templates`, `clinics`, `patients`, `tickMs`, `clock`, `seed`, `adminKey`, `onLog`. |
| `PHARMETIKA_PRESETS` | object | Every named fault preset. |
| `PHARMETIKA_NAMESPACE` | string | The service name, `"pharmetika"`. |
| `TOKEN_HEADER` | string | `"x-pmk-authentication-token"`. |
| `WEBHOOK_SECRET_HEADER` | string | `"x-pharmetika-webhook-secret"`. |
| `tokenCredential` | function | The credential a request carries (portal token, else Basic username), for namespace mapping. |
| `DEFAULT_TEMPLATES`, `DEFAULT_CLINICS`, `SANDBOX_PATIENT` | values | The seed catalog, clinics and roster patient. |
| `KNOWN_STATUSES`, `SUBMITTED_STATUS`, `PENDING_APPROVAL_STATUS` | values | Documented workflow statuses. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http` (auto-advance ticks every 100 ms); the `serve` CLI target; port 8801. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
