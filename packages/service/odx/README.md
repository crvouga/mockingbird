# @crvouga/mockingbird-service-odx

Stateful mock of the **Optimal DX (ODX)** partner API for test suites: partner labs and their
biomarker elements, practice patients (create, update, delete, partner link, search), lab
imports (HL7 v2 ORU and structured results), the Functional Health Report (JSON or PDF),
webhook registrations, and the signed `PatientTest` webhooks ODX posts back.

> **The vendor was retired 2026-07-22.** Our queue paths are gated only by the
> `acme-pdf-enabled` flag (default `false`), so a local stack with no PostHog still calls ODX.
> The cheaper fix is to turn that flag on through the PostHog mock
> (`@crvouga/mockingbird-service-posthog`); use this mock when a suite must exercise the ODX
> path itself (bio-age webhooks, the Healthie PDF upload, migrations).

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/odx/SUPPORT.md)
- ODX publishes no spec: `openapi.yaml` is hand-authored from our consumer's wire shapes
  (`optimal.dx.service.ts`, the webhook guard and DTO, and QA's `odx-client.ts`).

## Install

```bash
npm install -D @crvouga/mockingbird-service-odx
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-odx serve`, `createServer` from `./server` (Node), or `createRuntime` with any
Fetch server.

## Usage

The real base URL is `https://odxinstanceresource.azure-api.net/<partner>`; the partner segment is
your account's slug.
Point `OPTIMAL_URL` at the mock (it is overridable; no path prefix is needed), keep any
`OPTIMAL_API_KEY` and `OPTIMAL_PRACTICE_ID`. Pre-register the backend's webhook, or let
`manageWebhooks` register it through `POST /v1/webhook` as it does in production:

```bash
npx mockingbird-odx serve --port 8817 \
  --webhook-url http://127.0.0.1:3000/odx/webhook   # must equal SYSTEM_API_DEPLOYMENT_URL/odx/webhook
```

```ts
import { createRuntime } from "@crvouga/mockingbird-service-odx"

const odx = createRuntime({ webhook: { url: "http://127.0.0.1:3000/odx/webhook" } })
const call = (path: string, body?: unknown) =>
  odx.fetch(
    new Request(`http://odx.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ApiKey: "any", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )

const patient = await (
  await call("/v1/practice/p1/patient", { firstName: "Ada", lastName: "Lovelace", gender: "Female", email: "ada@example.com" })
).json()
// …the app posts HL7 to /v1/practice/p1/patient/{patientId}/test; the mock answers the parsed
// PatientTest and posts a signed `Created` webhook to /odx/webhook.
```

### Routes

| Route | Behaviour |
| --- | --- |
| `GET /v1/partner/labs` | `[{labId, name, isCurrentLab}]`: AHA (1), Quest (2), LabCorp (3). |
| `GET /v1/elements/{labId}` | The element corpus (`ELEMENTS`) for the lab: `elementId`, `elementName`, `elementGenderType`, `cuUnit`, `siUnit`, `cuToSiConversionFactor`, `elementReferences[{elementCode}]` (LOINC codes HL7 OBX-3 is mapped by). Includes the nine phenotypic-age inputs (ids 494, 496, 506, 511, 537/538, 556, 564, 568, 571). Unknown lab → 404 `{Message}`. |
| `POST /v1/practice/{pid}/patient` | Creates an `OdxPatient` with a numeric `patientId` (100001…). `firstName`, `lastName`, `email` required, else ASP.NET problem details 400. `dateOfBirth` becomes `YYYY-MM-DDT00:00:00`; `gender` is normalized to `Male`/`Female`/`Unknown`. |
| `PUT /v1/practice/{pid}/patient/{id}` | Replaces the patient; 404 `{Message}` when unknown in that practice. |
| `DELETE /v1/practice/{pid}/patient/{id}` | 204; drops its tests (QA teardown). |
| `POST /v1/practice/{pid}/patient/{id}/partner/{localUserId}` | Body is the literal `false`; stores our user id (admin-visible). Answers `true`. |
| `GET /v1/practice/{pid}/patients` | All patients; with any of `email`, `firstName`, `lastName`, `dateOfBirth` it is a case-insensitive search that answers **404 when nothing matches** (our client passes `ignore404`). |
| `POST …/patient/{id}/test` | HL7 import: `{labProfileId, labId, testDate, unitType, userId, externalReference, externalMessageControlId?, externalPatientTestId, menstrualPhase, isFasting, hl7}`. OBX-3 `code^text` maps to an element by lab code, `EL<id>`, or name (hs-CRP picks the patient's sex); OBX-5 values like `<0.2` become `comparison: "<"`. Unmapped / non-numeric observations land in `importLogs`. Emits `Created`. A message without MSH or OBX is a 400. |
| `PUT …/patient/{id}/test/{testId}` | Re-import; emits `Updated` (ODX sends a Created+Updated pair with identical data). |
| `POST …/patient/{id}/testresults` | Structured import (`results[{elementId, value, comparison}]`); emits `Created`. |
| `GET …/patient/{id}/tests` | The patient's tests, oldest first. |
| `POST /v1/reports/FunctionalHealthReport` | `outputType: Json` → `{metadata, labs, elements, sections}` with the sections our `storeHealthData` reads (groups, above/below optimal, "Functional Body Systems" conditions, health concerns); `Pdf` → a valid single-page `application/pdf`. Unknown test → 404. |
| `GET /v1/webhooks` | `[{partnerWebhookId, signingKey, createDate, entityEvents: {PatientTest}, webhookUrl}]` — our guard calls this on **every** inbound webhook to fetch the key. |
| `POST /v1/webhook`, `PUT /v1/webhook/{id}` | Register / update (`manageWebhooks`). |

Errors: missing / unknown `ApiKey` → 401 `{statusCode, message}` (Azure API Management's shape);
ODX errors → `{Message}`; validation → ASP.NET problem details `{title, status, errors}`.

### Webhooks

Every test import or re-import posts `{entityType: "PatientTest", eventType, data: <PatientTest>}`
to each registered webhook URL subscribed to that event, with
`optimaldx-signature: <UPPERCASE hex HMAC-SHA256(signingKey, rawBody)>`. `data` is the full
PatientTest (`results[].comparison` is always a string, as our receiver's zod DTO requires).
Non-2xx answers are retried (immediately, 5 s, 5 min, 30 min, 2 h). `GET /__admin/webhooks`,
`/__admin/webhooks/events`, `POST /__admin/webhooks/flush` and `…/replay` work as usual.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `POST /__admin/tests/:id/webhook` | `{eventType?: Created\|Updated\|Deleted, signature?: valid\|short\|bad}`: emit a webhook for a stored test. |
| `DELETE /__admin/tests/:id` | Emit `Deleted` and drop the test. |
| `GET /__admin/patients`, `GET /__admin/tests` | The namespace's records (patients include `partnerUserId`; the HL7 text is never stored). |
| `GET`/`PUT /__admin/settings` | `{apiKeys?: string[]}` (empty accepts any key). |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`): `wrong_length_signature`,
`bad_signature`, `empty_success`, `no_content`, `not_found`, `server_error`, `slow`,
`webhook_duplicate`, `webhook_reorder`, `webhook_drop`.

### Namespaces

`x-mockingbird-namespace`, a `/ns/<name>` prefix on `OPTIMAL_URL`, or by API key:
`PUT /__admin/credentials {"credentials": {"<OPTIMAL_API_KEY>": "<namespace>"}}`.

### Known consumer bugs

- **Wrong-length signature → 500.** `OdxSignatureGuard.verifyHmac` calls
  `crypto.timingSafeEqual` on buffers of different lengths, which throws `RangeError` instead of
  returning false, so a truncated `optimaldx-signature` is a 500 (ODX then retries) rather than a
  403. The `wrong_length_signature` preset sends a 32-character signature to reproduce it.
- `manageWebhooks` "updates" a stale registration with its own old URL (a no-op), then registers
  the new one, so stale registrations accumulate.
- `updateWebhook` passes the method as `'Put'`; Node's fetch normalizes it (Bun's does not — the
  consumer port normalizes, as the app runs on Node).

### Deliberately not modelled

- Clinical logic: report conditions and health concerns are derived only from which results
  fall outside their optimal range; bio-age is not computed.
- The real element catalog (thousands of elements, lab-specific codes): a 13-element corpus
  covers our consumer's needs. HL7 segments other than MSH/OBX are ignored; PID is never stored.
- Report themes, recipients beyond the metadata label, and PDF content.
- No official SDK exists, so there is no SDK drop-in test.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `OdxAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `emit(testId, eventType, signature?)`, `patients()`, `tests()`. Options: `sqlite`, `now`, `namespace`, `settings`, `onWebhook`. |
| `createRuntime` | function | The mock with the full service contract. Options: `webhook: {url, signingKey?}`, `settings`, `retryDelaysMs`, `fetch`, `clock`, `seed`, `adminKey`, `onLog`. |
| `ODX_PRESETS` | object | Every named fault preset. |
| `ODX_NAMESPACE` | string | The service name, `"odx"`. |
| `SIGNATURE_HEADER` | string | `"optimaldx-signature"`. |
| `signOdx` | function | `(signingKey, body) → UPPERCASE hex HMAC-SHA256`. |
| `apiKeyCredential` | function | The `ApiKey` header (how credentials map to namespaces). |
| `ELEMENTS`, `LABS` | arrays | The element corpus and partner labs. |
| `matchElement`, `parseObservations` | functions | HL7 OBX parsing and code → element mapping. |
| `DEFAULT_SETTINGS` | object | Per-namespace defaults. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target; port 8817. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
