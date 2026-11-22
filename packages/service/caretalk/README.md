# @crvouga/mockingbird-service-caretalk

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful emulator of **CareTalk**'s external API (`/externalapi`) for test suites: client login,
form definitions (`GetForm`) and saved form rounds (`SavePatientForm`, the form-submission
queue's call), patient search and insert (the account backfill), states, free slots and
appointments. The backend requires CareTalk keys at boot, so the emulator lets a stack boot and run
the CareTalk paths without the beta environment.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/caretalk/SUPPORT.md)
- The vendor publishes no spec: the contract (`openapi.yaml`) is hand-authored from the
  consumer's zod schemas and interfaces (`caretalk.types.ts`, `caretalk-forms.type.ts`).

## Install

```bash
npm install -D @crvouga/mockingbird-service-caretalk
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-caretalk serve`, `createServer` from `./server` (Node), or `createRuntime`
with any Fetch server.

## Usage

Point `CARETALK_API_URL` at the emulator (the backend validates it as **https-only**, so relax that
for loopback or front the emulator with TLS). `getFormData` hardcodes
`https://api.caretalkbeta.com` (seam **G-Y1**). `CARETALK_USERNAME`, `CARETALK_PASSWORD` and
`CARETALK_API_KEY` can be any values unless `--api-user` / `--api-key` pin them.

```bash
npx mockingbird-caretalk serve --port 8823 --api-user "$CARETALK_USERNAME:$CARETALK_PASSWORD" --api-key "$CARETALK_API_KEY"
```

```ts
import { createServer } from "@crvouga/mockingbird-service-caretalk/server"

// Test setup: the emulator. The application gets CARETALK_API_URL = server.url.
const server = await createServer()
const baseUrl = server.url

// Application code: log in, then read a form with the token.
const login = await fetch(`${baseUrl}/externalapi/Auth/client-login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  // Any credentials log in unless --api-user pins them.
  body: JSON.stringify({ userName: "acme-api", password: crypto.randomUUID() }),
})
const { token } = (await login.json()) as { token: string }
const forms = await fetch(`${baseUrl}/externalapi/Forms/GetForm/health-history`, {
  headers: { authorization: `Bearer ${token}` },
})
const [form] = (await forms.json()) as { fullFormDto: { id: number } }[]

// Test control: after the app's form-submission queue runs, assert what reached CareTalk.
const saved = await fetch(`${baseUrl}/__admin/form-submissions`)
const { submissions } = (await saved.json()) as { submissions: unknown[] }
await server.close()
```

### Routes

| Route | Behaviour |
| --- | --- |
| `POST /externalapi/Auth/client-login` | `{userName, password}` → `{token, expiration}`. Tokens last `tokenTtlSeconds` (default 3600, what our client caches for) on the emulator clock. |
| `GET /externalapi/Forms/GetForm/{formName}` | By name or slug, case-insensitive: `[{formRoundId, patientAppointmentId, submitDate, fullFormDto}]`; an unknown form is `[]`. With `PatientId` (and `AppointmentId`), the patient's latest saved round: chosen answers `isChecked`, free text echoed. Accepts a login token or a static API key. |
| `POST /externalapi/Forms/SavePatientForm?patientId=&patientAppointmentId=` | The submission (`fullFormDto.groups[].groupQuestions[]`). Question ids must belong to the form, answer ids to the question (text questions take `id: 0` with the typed value), single-choice questions one answer; violations are 400 ProblemDetails, an unknown patient or form 404. → `{success: true, message}`. |
| `GET /externalapi/Patients/SearchForPatient?FirstName&LastName&zipCode&DateOfBirth` | Case-insensitive names, ZIP, and the date in any of `YYYY-MM-DD`, `MM/DD/YYYY`, ISO → `{isExists: true, eligibleId, programId}`; no match is **400** `{isExists: false, message}` (our client reads 400 as "no such patient"). |
| `GET /externalapi/States` | 51 states `{id, stateUid, name, abbreviation, …}` (UT is 45). |
| `POST /externalapi/Patients` | Creates a patient and echoes CareTalk's full record (`id`, `eligibilityId` = `id`, `userState`, `formattedUserMobile`, `clientId`, …). |
| `GET /externalapi/PatientAppointments/GetFreeSlots?date&programId&eligibleId` | Half-hour slots 09:00–16:30 for two physicians, minus booked ones. |
| `POST /externalapi/PatientAppointments` | `{doctorId, patientId (the eligible id), from, to}` → `{id, patientId: null, eligibilityId, appointmentStatus: 1, physicianId}`; a taken or unknown slot is 400. |
| `GET /externalapi/PatientAppointments/GetPatientAppointmentsByEligibleId/{id}` | That patient's appointments. |

Unauthenticated or expired calls are an empty 401 with `WWW-Authenticate: Bearer` (our client
logs in again once and retries). Validation errors are ASP.NET ProblemDetails
`{type, title, status, errors, traceId}`.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `GET /__admin/form-submissions[?patientId=]` | Saved rounds: `{formRoundId, formId, patientId, patientAppointmentId, submitDate, answers: [{questionId, answerIds, freeAnswerText}]}`. |
| `GET` / `POST /__admin/patients` | List patients, or create one directly (the Patients POST body) so a search finds it. |
| `GET /__admin/forms`, `PUT /__admin/forms/:id` | List or add/replace a form definition (`fullFormDto` shape). |
| `POST /__admin/appointments/:id/status` | `{appointmentStatus}`: change an appointment's status code. |
| `GET/PUT /__admin/settings` | `{tokenTtlSeconds?, users?: [{userName, password}], apiKeys?, programId?}`. |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`): `login_failure`,
`invalid_credentials`, `token_expired` (count applies per operation), `server_error`,
`gateway_html`, `form_not_found`, `patient_not_found`, `save_rejected`, `connection_drop`,
`slow`.

### Namespaces

`x-mockingbird-namespace`, a `/__admin/ns/<name>` prefix on `CARETALK_API_URL`, or by credential: tokens
carry the API user they were issued to, so `PUT /__admin/credentials {"credentials":
{"<CARETALK_USERNAME>": "<ns>", "<CARETALK_API_KEY>": "<ns>"}}` routes both auth styles.

### Deliberately not modelled

- CareTalk's clinical workflows behind the forms (reviews, form rounds created by staff),
  eligibility files, Health Gorilla retrieval, medications and diagnostics.
- Real physician calendars: slots are synthesised; time zones are fixed to Mountain.
- The live form catalogue: `DEFAULT_FORMS` is synthesised in CareTalk's shape (the live-parity
  script seeds the emulator from the beta environment's forms instead).

## API

| Export | Kind | Description |
| --- | --- | --- |
| `CareTalkAPI` | class | The in-process emulator: `fetch(request)`, `reset()`, `addPatient(body)`, `slots(date)`, `setAppointmentStatus(id, status)`, `upsertForm(form)`, `rounds()`, `patients()`. Options: `sqlite`, `now`, `namespace`, `forms`, `settings`. |
| `createRuntime` | function | The emulator with the full service contract (health, admin, namespaces, credentials, presets). Options: `forms`, `settings`, `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `CARETALK_PRESETS` | object | Every named fault preset. |
| `CARETALK_NAMESPACE` | string | The service name, `"caretalk"`. |
| `DEFAULT_FORMS` | array | The seeded form definitions (Health History 101, AOE Questions 102). |
| `DEFAULT_DOCTORS` | array | The physicians free slots are generated for. |
| `US_STATES` | array | The `/externalapi/States` rows. |
| `tokenCredential` | function | The API user a token was issued to, or the static key (how credentials map to namespaces). |
| `normalizeDate` | function | `YYYY-MM-DD` from ISO, `YYYY-MM-DD` or `MM/DD/YYYY`. |
| `problem` | function | Build an ASP.NET ProblemDetails response. |
| `document`, `operationIds`, `supportedOperationIds` | values | The OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target (`--api-user`, `--api-key`); port 8823. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
