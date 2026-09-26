# @crvouga/mockingbird-service-prism

Stateful mock of the **Prism Labs** body-scan API for test suites: subject upsert, scan
creation, the presigned capture upload the capture page PUTs its video to, per-stage
processing states, and the READY-scan results our backend persists (body composition,
measurements, health report with metabolic age, asset URLs). Scans move through the real
lifecycle (`CREATED` → `PROCESSING` → `READY` / `FAILED`) on command or on the mock clock, and
results are computed deterministically from the subject's height, weight, sex and age.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/prism/SUPPORT.md)
- The contract (`openapi.yaml`) is hand-authored from the consumer's zod schemas
  (`prism-scan.adapter.ts`) and the capture page's upload (`body-scan-capture-page`).

## Install

```bash
npm install -D @crvouga/mockingbird-service-prism
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-prism serve`, `createServer` from `./server` (Node), or `createRuntime` with
any Fetch server.

## Usage

Point `PRISM_API_URL` at the mock (http is allowed) and set `PRISM_API_KEY` to anything (or
pin it with `--api-key`). Without both, our adapter reports `unavailable` and never calls out.

```bash
npx mockingbird-prism serve --port 8825 --auto-advance 2000
```

```ts
import { createRuntime } from "@crvouga/mockingbird-service-prism"

const prism = createRuntime()
const api = (path: string, body?: unknown) =>
  prism.fetch(
    new Request(`http://prism.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer k", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )

// …the app upserts the subject, creates a scan, the capture page PUTs the video…
// Then finish processing without waiting:
await api("/__admin/scans/<scan id>/advance", { to: "READY" })
```

### Routes

All with `Authorization: Bearer <key>` and `Accept: application/json;v=1`, except the
presigned upload and asset URLs.

| Route | Behaviour |
| --- | --- |
| `POST /users` | Upsert by `token` (`sex`, `region`, `birthDate`, `weight {value, unit kg\|lb}`, `height {value, unit m\|in}`, `researchConsent`, `termsOfService`) → 201 on create, 200 on update, same `id`. |
| `POST /scans` | `{userToken, deviceConfigName: IPHONE_SCANNER\|ANDROID_SCANNER, bodyfatMethod, assetConfigId?}` → 201 scan `{id, status: "CREATED", weight, height, …}`; unknown user 404. |
| `GET /scans/{id}?unit-system=metric\|imperial` | Status and the subject's weight/height in that unit system. |
| `POST /scans/{id}/upload-url` | `{url, expirationTime}`: a presigned PUT to the mock itself (15 minutes on the mock clock; `/ns/<name>` kept in the URL). 409 once the capture is uploaded. |
| `PUT /uploads/{id}?expires&signature` | The capture upload. Moves the scan to `PROCESSING` (`captureData` succeeded, `body` started); an empty body fails it. Expired or tampered URLs are S3-style 403 XML. |
| `GET /scans/{id}/scan-assets` | `{captureData, body, fittedBody, measurement}` each `started` / `succeeded` / `failed` / `null`, with `…UpdatedAt`. |
| `GET /scans/{id}/bodyfat` | READY only: `{bodyfatMethod, bodyfatPercentage, leanMass, fatMass, skeletalMuscleMass}`. |
| `GET /scans/{id}/measurements?unit-system=` | READY only: `{waistFit, hipsFit, chestFit, waistToHipRatio, bodyRoundnessIndex, bmiPredicted}` (cm or in). |
| `GET /scans/{id}/health-report` | READY only: `{metabolicAgeReport: {metabolicAgeYears, chronologicalAgeYears, ageDeltaYears, percentile}, bodyShapeReport}`. |
| `GET /scans/{id}/asset-urls` | READY only: signed URLs for `previewImage`, `model`, `canonicalBody`, `texture`, `material`, `stripes`, served by `GET /assets/{id}/{file}`. |

Results before READY are 404 (our adapter: `not_found`). Errors are `{message, errors?}`.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `POST /__admin/scans/:id/advance` | One processing stage on (`{"to": "READY"}` for all of them). The scan must be uploaded. |
| `POST /__admin/scans/:id/fail` | Fail the started stage; the scan becomes `FAILED`. |
| `GET /__admin/scans` | The namespace's scans. |
| `GET/PUT /__admin/settings` | `{apiKeys?, uploadUrlTtlMs?, autoAdvance?: {afterMs, failAt?} \| null}`; auto-advance walks uploaded scans one stage per `afterMs` of mock time. |
| `POST /__admin/tick` | Apply due auto-advance steps now (the served mock ticks every 100 ms). |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`): `unauthorized`,
`server_error`, `scan_not_found`, `schema_drift` (an unknown scan status), `stage_states_slow`
(6 s, past our 5 s timeout), `metabolic_age_missing`, `metabolic_age_implausible`,
`upload_forbidden`, `connection_drop`.

### Namespaces

`x-mockingbird-namespace`, a `/ns/<name>` prefix on `PRISM_API_URL`, or by API key:
`PUT /__admin/credentials {"credentials": {"<PRISM_API_KEY>": "<namespace>"}}`. Presigned
upload and asset URLs carry the namespace in their path, since the capture page's PUT has no
other carrier.

### Deliberately not modelled

- Webhooks: our backend polls Prism, it has no receiver.
- Real body reconstruction: results are formulas over the subject's inputs, and the 3D assets
  are placeholder bytes.
- Scan deletion, user listing, and every endpoint our adapter does not call.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `PrismAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `advance(scanId, fail?)`, `tick()`, `scans()`. Options: `sqlite`, `now`, `namespace`, `publicNamespace`, `settings`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, namespaces, credentials, presets). Options: `settings`, `tickMs`, `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `PRISM_PRESETS` | object | Every named fault preset. |
| `PRISM_NAMESPACE` | string | The service name, `"prism"`. |
| `STAGES` | array | The processing stages, in order. |
| `scanResults` | function | The deterministic results a READY scan answers. |
| `prismError` | function | Build a Prism error response `{message, errors?}`. |
| `document`, `operationIds`, `supportedOperationIds` | values | The OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http` (auto-advance ticks every 100 ms); the `serve` CLI target (`--api-key`, `--auto-advance`); port 8825. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
