# @crvouga/mockingbird-service-easypost

Stateful mock of the **EasyPost** trackers API for test suites: `POST /v2/trackers` (create or
re-use a tracker for a tracking code), `GET /v2/trackers/{id}` and `GET /v2/trackers`. EasyPost's
documented test tracking codes answer their fixed statuses, and any other code moves through
admin transitions, so the genomics admin's shipping-leg states can be driven deterministically.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/easypost/SUPPORT.md)
- The contract (`openapi.yaml`) is trimmed from EasyPost's published reference to what our
  tracking lookup (`packages/lib/src/shipment-tracking-status/easypost-client.ts`) calls.

## Install

```bash
npm install -D @crvouga/mockingbird-service-easypost
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-easypost serve`, `createServer` from `./server` (Node), or `createRuntime` with
any Fetch server.

## Usage

The app hardcodes `https://api.easypost.com/v2/trackers` (seam **G-Y1**: add a base-URL env to
`easypost-client.ts`). Point that base URL at the mock; `EASYPOST_API_KEY` can be any value
(`--api-key` restricts it).

```bash
npx mockingbird-easypost serve --port 8818
```

```ts
import { createRuntime } from "@crvouga/mockingbird-service-easypost"

const easypost = createRuntime()
const auth = { authorization: `Basic ${btoa("EZTK_test:")}` }

// Seed a status before the app looks the code up (or move an existing tracker).
await easypost.fetch(
  new Request("http://easypost.test/__admin/trackers/1Z999AA10123456784/transition", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "out_for_delivery" }),
  }),
)
const tracker = await easypost.fetch(
  new Request("http://easypost.test/v2/trackers", {
    method: "POST",
    headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
    body: "tracker[tracking_code]=1Z999AA10123456784&tracker[carrier]=UPS",
  }),
)
// → 201 {id: "trk_…", status: "out_for_delivery", carrier: "UPS", status_detail: "out_for_delivery", …}
```

### Routes

| Route | Behaviour |
| --- | --- |
| `POST /v2/trackers` | Form (`tracker[tracking_code]`, `tracker[carrier]`) or JSON (`{tracker: {…}}`), `Authorization: Basic base64(key:)`. Answers 201 with the Tracker (`id`, `object`, `mode`, `tracking_code`, `status`, `status_detail`, `carrier`, `tracking_details`, `public_url`, `signed_by`, `est_delivery_date`, …). The same code and carrier re-use the existing tracker, as EasyPost does. Carrier: the given one (`DHL` is normalised to `DHLExpress`), else detected from the code's shape, else `USPS`. A blank code is 422 `PARAMETER.REQUIRED`; a bad carrier 422 `PARAMETER.INVALID`. |
| `GET /v2/trackers/{id}` | The tracker, or 404 `NOT_FOUND`. |
| `GET /v2/trackers` | `?tracking_code=&carrier=&page_size=` → `{trackers, has_more}`, newest first. |

Every error is EasyPost's envelope `{error: {code, message, errors}}`; our client reads
`error.message`. A missing key is 401 `APIKEY.REQUIRED`, a key outside `apiKeys` 401
`APIKEY.INACTIVE`. Keys starting `EZAK` are production mode (test codes are not special there);
anything else is test mode.

**Test tracking codes** (test mode, carrier `USPS`): `EZ1000000001` pre_transit,
`EZ2000000002` in_transit, `EZ3000000003` out_for_delivery, `EZ4000000004` delivered,
`EZ5000000005` return_to_sender, `EZ6000000006` failure, `EZ7000000007` unknown. Any other code
starts `unknown` / `unknown`.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `POST /__admin/trackers/:idOrCode/transition` | `{status, status_detail?, message?, signed_by?, carrier?}`. Moves the tracker (by id or tracking code) and appends a tracking detail. With no tracker for that code yet, registers one first, so the app's next lookup sees the status. `status` is one of `unknown`, `pre_transit`, `in_transit`, `out_for_delivery`, `delivered`, `available_for_pickup`, `return_to_sender`, `failure`, `cancelled`, `error`. |
| `GET /__admin/trackers` | The namespace's trackers. |
| `GET/PUT /__admin/settings` | `{apiKeys?: string[]}`: accept only these keys (default: any). |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`): `rate_limited` (429),
`server_error` (500), `invalid_api_key` (401), `gateway_html` (502 HTML, our client falls back
to `EasyPost tracker request failed (502)`), `connection_drop` (fetch rejects; our batch lookup
records `unknown` and warns), `slow` (5 s).

### Namespaces

`x-mockingbird-namespace`, a `/ns/<name>` prefix on the base URL, or by API key:
`PUT /__admin/credentials {"credentials": {"<EASYPOST_API_KEY>": "<namespace>"}}`.

### Deliberately not modelled

- Tracker webhooks (`tracker.updated`, `X-Hmac-Signature`): our app has no receiver.
- Carrier lookups: a real-shaped code never moves on its own; statuses come from admin
  transitions.
- Shipments, rates, labels, addresses, batches and every other EasyPost resource.
- Pagination cursors (`before_id` / `after_id`) on the list: `page_size` and `has_more` only.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `EasyPostAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `transition(idOrCode, {status, …}, carrier?)`, `trackers()`. Options: `sqlite`, `now`, `namespace`, `settings`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, namespaces, credentials, presets). Options: `settings`, `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `EASYPOST_PRESETS` | object | Every named fault preset. |
| `EASYPOST_NAMESPACE` | string | The service name, `"easypost"`. |
| `TEST_TRACKING_CODES` | object | EasyPost's test codes and the status / detail each answers. |
| `TRACKER_STATUSES` | array | Every Tracker `status`. |
| `apiKeyCredential` | function | The API key from `Basic base64(key:)` (how credentials map to namespaces). |
| `detectCarrier` | function | The carrier the mock assigns a code with no carrier given. |
| `easyPostError` | function | Build an EasyPost error response `{error: {code, message, errors}}`. |
| `isTrackerStatus` | function | Whether a value is a Tracker status. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target; port 8818. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
