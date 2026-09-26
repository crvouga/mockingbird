# @crvouga/mockingbird-service-aha

Stateful mock of the **AHA (Advanced Health Academy) at-home phlebotomy** partner API for test
suites: HMAC-signed create-order and cancel, and — its main job — the order-status webhooks AHA
posts back. The vendor has no pull API, so every downstream effect (EMR appointment booking,
storefront status, "blood drawn") starts with a webhook; the mock emits one on demand, with every
field our handler reads, so the ZIP-routed bloodwork path can finally be tested.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/aha/SUPPORT.md)
- The vendor publishes no spec: the contract (`openapi.yaml`) is hand-authored from our
  consumers' zod schemas and wire shapes.

## Install

```bash
npm install -D @crvouga/mockingbird-service-aha
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-aha serve`, `createServer` from `./server` (Node), or `createRuntime` with any
Fetch server.

## Usage

Point the app at the mock:

| Env | Value |
| --- | --- |
| `AHA_API_URL` | `http://127.0.0.1:8799` (the lab-provider path already allows loopback; `AhaService` needs an http exception, see G-A1 / S10.2) |
| `AHA_API_KEY` / `AHA_API_SECRET` | anything, or the pair passed as `--api-key` / `--api-secret` to verify signatures exactly |
| `AHA_USE_LEGACY_AUTH` | `true` switches to `X-<Partner>-Auth-Key` (e.g. `X-Acme-Auth-Key`); both modes are accepted |
| `AHA_WEBHOOK_SECRET` | the same value as `--webhook-secret` |

```bash
npx mockingbird-aha serve --port 8799 \
  --webhook-url http://127.0.0.1:3000/bloodwork/aha-webhook \
  --webhook-secret "$AHA_WEBHOOK_SECRET" \
  --api-key "$AHA_API_KEY" --api-secret "$AHA_API_SECRET" \
  --envelope raw --auto-schedule 2000
```

```ts
import { createRuntime } from "@crvouga/mockingbird-service-aha"

const aha = createRuntime({
  webhooks: { url: "http://127.0.0.1:3000/bloodwork/aha-webhook", secret: "aha-webhook-secret" },
})
const admin = (path: string, body: unknown) =>
  aha.fetch(
    new Request(`http://aha.test/__admin${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )

// …the app's checkout calls POST /v1/acme/create-order for AC-101…

// AHA books the draw: our handler books the EMR appointment for 10:30 Denver time.
await admin("/orders/AC-101/transition", {
  status: "Scheduled",
  scheduledAt: "2026-10-01T16:30:00Z",
  timeZone: "America/Denver",
})
// The phlebotomist checks out with a sample: our handler sets vitalBloodDrawn.
await admin("/orders/AC-101/transition", { status: "Check Out", drawStatus: "Sample Collected" })
```

### Routes

The `{partner}` path segment is your account's slug (e.g. `acme`); the mock accepts any.

| Route | Behaviour |
| --- | --- |
| `POST /v1/{partner}/create-order` | Validates the body (`partner_order_id`, patient fields, `biological_sex`, `service_type`, `npi`, `ordering_physician`, `test_codes`, optional `preferred_schedule_date/time`, `patient_timezone`). Create **or update**: a repeated `partner_order_id` keeps its `order_number`. Answers `{content: {partner_order_id, order_number}, message, status: "SUCCESS"}`. |
| `POST /v1/{partner}/cancel` | `{partner_order_id, notes: [{note_type: "CANCELLATION", notes}]}` → `{message, status}`. Emits a `Cancelled` webhook (turn off with `cancelWebhook: false`). Unknown id → 404; an order whose sample was collected → 200 with `status: "ERROR"`. The AHA `order_number` is accepted in `partner_order_id` too, because our lab-provider client sends it there (G-A1). |

**Auth.** HMAC mode: `X-API-KEY`, `X-TIMESTAMP` (epoch ms, within ±5 min of wall-clock time),
`X-SIGNATURE` = base64 HMAC-SHA256(secret, `"<apiKey>:<path>:<timestamp>"`), where `path` is the
request path without host, body or `/ns/<name>` prefix. With a known key + secret
(`--api-key/--api-secret` or `credentials` in settings) the signature is verified exactly;
with none configured any key is accepted and the signature is checked for shape only. Legacy
mode: `X-<Partner>-Auth-Key` (+ `X-API-Version: 1.0`), e.g. `X-Acme-Auth-Key`; any partner name is
accepted. Failures are 401 `{status: "ERROR", message}`.

**Envelope (G-A1).** `AhaService` expects the raw `{content, message, status}`;
`AhaLabProvider` expects `{success: true, data: {…}}`. Raw is the default; choose with
`--envelope raw|wrapped` or per namespace with `PUT /__admin/settings {"envelope": "wrapped"}`.

**Idempotency.** `X-Idempotency-Key` (the lab-provider path): the same key and body replays the
stored response (`idempotent-replayed: true`); the same key with a different body is 409.

### Webhooks

`POST <webhook-url>` (our route: `POST /bloodwork/aha-webhook`) with
`Authorization: Token <AHA_WEBHOOK_SECRET>`. Every body has `status`, `partnerOrderId`, `ahaOrderId`,
plus, by status (all local times in the order's IANA zone):

| `status` | Extra fields |
| --- | --- |
| `Scheduled`, `Rescheduled` | **`scheduleServiceTime`** (`YYYY-MM-DDTHH:mm:ss`, moment-parsable) and **`scheduleServiceTimeZone`** (IANA) — required by our handler though absent from the DTO — plus `scheduledServiceDate/Time/TimeZone` and `scheduleConfirmationDate/Time/TimeZone` |
| `Check In` | `checkInDate`, `checkInTime`, `checkInTimeZone` |
| `Check Out` | `drawStatus` (default `Sample Collected`), `drawStatusDate/Time/TimeZone` |
| `Lab Testing In Progress` | `dropOffDate`, `dropOffTime`, `dropOffTimeZone` |
| `Cancelled`, `Non Scheduled Update` | — |

`drawStatus` values: `Sample Collected`, `Completed` (drawn), `Patient Refused`, `UTO`,
`Patient Not Home`, `Patient Rescheduled`, `Order Cancelled`, `Others`,
`Patient Asked to Reschedule` (draw failed). Non-2xx answers are retried (immediately, 5 s,
5 min, 30 min, 2 h); `GET /__admin/webhooks`, `…/events`, `…/replay`, `…/flush` as usual.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `POST /__admin/orders/:partnerOrderId/transition` | `{status, drawStatus?, scheduledAt?, timeZone?}` emits the webhook. `status` is any value above (case and `_` forgiven; unknown values are sent verbatim). `scheduledAt` (ISO or epoch ms) defaults to the order's preferred slot, else the next hour 24 h out; `Rescheduled` defaults to one day later. `timeZone` defaults to the order's `patient_timezone`, else `America/New_York`. `:partnerOrderId` may also be the `order_number`. |
| `PUT /__admin/settings` | `{envelope?, credentials?: [{apiKey, apiSecret?}], allowLegacy?, timestampToleranceMs?, defaultTimeZone?, cancelWebhook?, autoSchedule?: {afterMs, leadMs?} \| ms \| null}` for the calling namespace. `GET` shows them with secrets masked. |
| `POST /__admin/tick` | Emit every `autoSchedule` webhook that is due on the mock clock (the served mock ticks every 100 ms). |
| `GET /__admin/orders` | The namespace's orders (ids, status, appointment, zone — no patient data). |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`): `bad_signature` (401),
`rate_limited` (429 → `rate_limit`), `server_error` (500), `order_error` (200 with inner
`status: "ERROR"`), `invalid_response` (200 with a body neither zod schema accepts),
`webhook_duplicate`, `webhook_reorder`, `webhook_drop`.

### Namespaces

`x-mockingbird-namespace`, a `/ns/<name>` prefix on `AHA_API_URL` (the signature still covers
only the path after it), or by API key:
`PUT /__admin/credentials {"credentials": {"<AHA_API_KEY>": "<namespace>"}}`.

### SFTP result delivery

`createAhaSftpServer` from `./sftp` starts a real SSH/SFTP server on an ephemeral port and shares order state with `createRuntime`. It supports password or public-key authentication, host-key verification, `list`/`stat`, binary upload/download, atomic temp-file rename, delete, nested directories, stable POSIX permissions and mock-clock timestamps. The deterministic Ed25519 host key is stable between runs.

```ts
import { createRuntime } from "@crvouga/mockingbird-service-aha"
import { createAhaSftpServer } from "@crvouga/mockingbird-service-aha/sftp"

const runtime = createRuntime()
const sftp = await createAhaSftpServer({
  runtime,
  accounts: [{ username: "aha", password: "local-test-password" }],
})
console.log(sftp.host, sftp.port, sftp.hostPublicKey)
```

Use `seed()` to install arbitrary binary fixtures or `publishResult(orderId, bytes)` to place a stable `AHA-…_result.pdf` in `/outbox`. The first complete download moves the linked HTTP order to `Lab Testing In Progress` and emits its webhook; repeat polling/download does not repeat that transition. `fault()` forces the next operation to disconnect, deny permission, report disk-full, or accept only part of a write. `journal()` exposes paths, operation names, byte counts, and outcomes—never credentials or file contents. `reset(namespace?)` clears deterministic filesystem state. Duplicate destination names fail, so `.tmp` → final rename is atomic.

### Deliberately not modelled

- Downstream S3 ingestion and `aha_results_queue` processing after the SFTP handoff.
- Real scheduling: AHA contacts the patient; nothing moves unless a test transitions the order
  or sets `autoSchedule`.
- The serviceable-ZIP list (our app's own fixture decides eligibility before calling AHA).
- Patient details are validated, never stored or echoed.
- Which envelope the real vendor uses (G-A1): both are served, one per namespace.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `AhaAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `transition(id, {status, drawStatus?, scheduledAt?, timeZone?})`, `tick()`, `orders()`. Options: `sqlite`, `now`, `namespace`, `settings`, `onWebhook`, `wallClock`. |
| `createRuntime` | function | The mock with the full service contract. Options: `webhooks: {url, secret, retryDelaysMs?, fetch?}`, `settings`, `tickMs`, `wallClock`, `clock`, `seed`, `adminKey`, `onLog`. |
| `AHA_PRESETS` | object | Every named fault preset. |
| `AHA_NAMESPACE` | string | The service name, `"aha"`. |
| `WEBHOOK_PATH` | string | `"/bloodwork/aha-webhook"`, our receiver's route. |
| `ORDER_STATUSES`, `DRAW_STATUSES` | arrays | The vendor status spellings the webhooks use. |
| `verifyAuth` | function | The HMAC / legacy verification the mock applies (an error message, or `undefined`). |
| `apiKeyCredential` | function | The API key a request carries (how credentials map to namespaces). |
| `isTimeZone`, `zonedParts`, `zonedToEpoch` | functions | IANA-zone helpers used to fill the local date/time fields. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http` (autoSchedule ticks every 100 ms); the `serve` CLI target; port 8799. |
| `createAhaSftpServer` (`./sftp`) | Node | Real SSH/SFTP endpoint with deterministic host key/filesystem, shared order state, transfer controls, and an ephemeral port. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
