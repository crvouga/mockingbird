# @crvouga/mockingbird-service-mosaic

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga-organization/mockingbird).

Emulate the Mosaic Diagnostics practitioner ordering API for patient records, sales orders,
and lab results. The [OpenAPI contract](./openapi.yaml) uses the published v1 routes with corrections
from observed test API responses. [SUPPORT.md](./SUPPORT.md) lists coverage by operation.

## Install

```sh
npm install -D @crvouga/mockingbird-service-mosaic
npx mockingbird-mosaic serve
```

The CLI listens on `127.0.0.1:8931` by default. Set `MOSAIC_API_URL=http://127.0.0.1:8931`
and set `MOSAIC_API_KEY` to any non-empty test value. Pass that value in the `ApiKey` header.
The CLI accepts `--host`, `--port`, `--admin-key`, and `--admin-prefix`. For a local fleet,
install this package beside `@crvouga/mockingbird-fleet` and add
`"mosaic": {"port": 8931}` to the fleet's `services` object.

## Usage

Call the API with plain Fetch or a client generated from the OpenAPI contract. This example
starts a standalone server on a free port and uses its URL for the application's Fetch call.

```ts
import { createServer } from "@crvouga/mockingbird-service-mosaic/server"

const server = await createServer()
const mosaicApiUrl = server.url
const mosaicApiKey = "mockingbird"
try {
  const response = await fetch(`${mosaicApiUrl}/api/PortalTestType`, {
    headers: { ApiKey: mosaicApiKey },
  })
  if (!response.ok) throw new Error(`Mosaic test-type lookup failed (${response.status})`)
  const testTypes = await response.json()
  if (!Array.isArray(testTypes)) throw new Error("Expected a Mosaic test-type array")
} finally {
  await server.close()
}
```

| Method and route | Behavior |
| --- | --- |
| `POST /api/patient/create` | Creates a patient and returns an enveloped account ID. |
| `GET /api/patient/{patientAccountId}`, `GET /api/patient` | Reads or filters patients. The internal patient ID differs from the account ID. |
| `PUT /api/patient` | Updates the patient and returns the patient object. |
| `POST /api/salesorders/PatientOrder/Create` | Places an order and one line per test-type entry. Both `kitIds` and `prepaidIds` are required. |
| `GET /api/salesorders/{salesOrderId}` | Reads an order using its sales order ID. |
| `GET /api/salesorderlines` | Reads a flat, filtered page of lines with optional pagination. `PatientAccountId` filters by the account ID and each line returns the internal ID. |
| `POST /api/salesorderlines/Cancel` | Acknowledges well-formed requests with `data: true`. Re-read the line to verify cancellation. |
| `GET /api/salesorderslinestatus`, `GET /api/salesorderslinecancelreason` | Returns the lifecycle statuses and cancel reasons. |
| `GET /api/PatientResults/{salesOrderId}` | Lists result files for an order. |
| `GET /api/PatientResults/GetPDF?fileName=…` | Downloads a PDF and changes a completed line from status 1 to 10. |
| `GET /api/PatientResults/ReportJson/{testTypeId}?reqNum=…` | Returns an enveloped JSON string for the requisition number and the test-type ID used in the result list. |
| `GET /api/PortalTestType` | Returns a bare array and preserves repeated test-type IDs. |
| `GET /api/Country`, `GET /api/Country/States?CountryId=…`, `GET /api/Language` | Returns local reference data for US and Canadian addresses, English, and Spanish. |

### Observed at the vendor's test API on 2026-11-19

1. Paths and query parameter names are case-insensitive. The lowercase test catalogue, uppercase
   line status path, and lowercase `pageindex`, `recordsperpage`, and `patientaccountid` behave like
   the canonical requests.
2. `GET /api/salesorderlines` returns the flat page without paging parameters.
3. Patient create with `{}` or only `practitionerAccountId` returns an RFC 9110 400 problem with
   `type`, `title: "Bad Request"`, `status`, and `traceId`. The body has no `errors` member.
   The invalid-patient-create recording used `{}`.
4. An unknown order test type returns HTTP 200 with `data: 0`, `success: false`, and
   `error: "Object reference not set to an instance of an object."`. The request creates no order.
5. An unknown order patient returns HTTP 200 with `data: 0` and `success: false`. With
   `dropShip: true` the error is `"Patient required with dropship order."`. With `dropShip: false`
   it is `"Something went wrong saving the data. StatusCode:BadRequest"`. Neither creates an order.
6. Order create accepts `portalTestTypeIds: []`, returns a new order ID in a successful HTTP 200
   response, and creates zero lines.
7. Well-formed cancellation requests return HTTP 200 with
   `{ "data": true, "error": null, "success": true }`. Unknown orders and absent test types
   are no-ops. An unknown reason sent for an already-cancelled line left its stored reason
   unchanged. A client must re-read the line to verify that it changed.
8. Cancel without `portalTestTypeIds` returns HTTP 400 with the title
   `"One or more validation errors occurred."` and the key `PortalTestTypeIds` in `errors`.
9. A result list for an order with no results or for an unknown order returns HTTP 200 with
   `{ "data": [], "error": null, "success": true }`.
10. A state lookup with an unknown `CountryId` returns HTTP 200 with `data: []`.
11. The result list reported a different `portalTestTypeId` from the sales order and its line for
    the same file. **Do not join a vendor result to an order line on that ID.** The requisition
    number is also independent of the sales order ID.
12. The three line recordings (`salesorderlines.placed.json`, `salesorderlines.cancelled.json`,
    and `salesorderlines.completed.json`) saved only `data`. On the wire every line lookup is a flat
    page, as in `error.missing-lines.json`. The offline replay tests combine the sampled arrays
    with that recorded envelope and compare status, keys, types, and nullability.

### Timestamps

The API returns timestamps as US Central wall-clock time (`America/Chicago`) with no offset.
Offset-free inputs, including order-line date filters, use the same time zone. Date-only inputs
use midnight Central. An explicit `Z` or numeric offset identifies an instant. At daylight-saving
changes, a repeated local time uses its earlier occurrence and a skipped local time moves forward
by the gap. The shared admin clock still takes instants.

### Test setup

Use `GET /__admin/state/lines` to find the line's storage ID. A newly placed line uses
`<salesOrderId>-<one-based position>`. Both line controls also accept
`/lines/:salesOrderId/:testTypeId/…`, where the test type comes from the order line.
If multiple lines have that type, this address returns 409 and the storage ID selects the line.

| Admin route | Body and effect |
| --- | --- |
| `POST /__admin/lines/:id/transition` | Send `{ "statusId": 7 }` for shipped, `2` for processing, or `1` for completed. Any listed status is accepted. Override `trackingNumber`, `courier`, `shippedDate`, `receivedDate`, `requisitionNumber`, `estimatedCompletion`, `completedDate`, `resultFileName`, `fileName`, or `cancelReasonId` in the same object. The namespace clock supplies lifecycle dates. The response uses the same line object as `GET /api/salesorderlines`, including its status name. |
| `PUT /__admin/lines/:id/result` | Send `{}` to use the built-in PDF on a new result, or supply `pdfBase64`, `reportJson` (a JSON string), and optionally `portalTestTypeId` to override the ID reported for that file. Omitted fields keep their stored values. The result type defaults to the order line type. Set status 1 with the transition route to publish the filename. |
| `GET /__admin/test-types`, `PUT /__admin/test-types` | Read or replace `{ "testTypes": [...] }`. Each row has `testTypeId`, `testName`, `sampleTypeName`, `kitTypeIds` and `price`. Repeated IDs are permitted. |
| `GET /__admin/faults/presets`, `POST /__admin/faults` | Register `{ "preset": "rate_limited" }` for a 429 with Retry-After, `server_error` for 500, `timeout` for a stalled connection, or `unsuccessful` for a 200 with `success: false`. Each preset defaults to one vendor request. |
| `GET /__admin/health`, `GET /__admin/requests`, `POST /__admin/reset` | Inspect health, read the request journal, or restore namespace boot state. |

Set `x-mockingbird-namespace` on vendor and admin requests, or add `/__admin/ns/<name>` to
the vendor base URL. You can also map an `ApiKey` to a namespace with
`PUT /__admin/credentials` and `{ "credentials": { "mockingbird": "suite-a" } }`.
If an admin key is configured, send it as `x-mockingbird-admin-key` on protected control routes.
See [Admin controls](https://github.com/crvouga-organization/mockingbird/blob/main/docs/ADMIN_CONTROLS.md) for
the shared state, clock, snapshot, and Timeline APIs. The emulated ordering API is polled and
emits no webhooks.

## API

| Entry | Runtime export | Use |
| --- | --- | --- |
| Package root | `MosaicAPI` | Fetch API with `fetch(Request)` and `reset()`. |
| Package root | `createRuntime` | Fetch surface with namespaces, admin controls, and request journal. |
| Package root | `document`, `operationIds`, `supportedOperationIds` | OpenAPI document and operation lists. |
| `./server` | `createServer` | Starts a loopback HTTP server. Returns `url`, `port`, `runtime`, and `close()`. With no port, the OS chooses one. |
| `./server` | `serveTarget` | Target used by the CLI and fleet. |
| `./server` | `DEFAULT_PORT` | CLI default port `8931`. |

## Assumptions (not observed at the vendor)

- A partial `PUT /api/patient` preserves omitted fields and applies supplied fields. An update
  for an unknown account returns 404. Birth dates accept ISO-style dates and timestamps.
  Empty and practitioner-only creates are the verified rejection cases. Other minimum demographic
  requirements and validation wording are assumed.
- Patient text filters compare case-insensitively, non-empty date bounds are inclusive, and
  the default line page is page 1 with up to 50 lines in creation order. For a query name repeated
  with different casing the emulator uses its first value. A missing country filter defaults to
  the US.
- A cancellation changes only a matching status-4 line with a known reason. Cancellation
  eligibility outside status 4 and the effect of an unknown reason on a still-placed line are
  unverified. For a request where both the patient and the test type are unknown, the emulator
  returns the missing-patient error first.
- Orders fill omitted shipping fields from the patient. The emulator accepts the published
  `dropship` spelling as an alias and gives `dropShip` precedence when both are supplied.
  Kit IDs of zero are placeholders and prepaid IDs do not affect modeled state.
- The admin transition is a test control. It accepts direct jumps to any listed status.
  Requisition numbers are generated per line in a disjoint range from sales order IDs, and the
  order shows the first assigned number. Processing and direct completion fill an unset estimate
  with the clock plus seven days. A drop-ship order gets a synthetic shipment ID at a shipped or
  later milestone (in transit, processing, completed, or downloaded) or when given a shipped date.
- For `GetPDF`, an exact filename match serves the stored PDF or a generated stand-in,
  including when manually assigned before completion. Only status 1 moves to 10 on download.
  The result list includes entries with a result filename. `ReportJson` matches on the result
  list's test-type ID and the line's requisition number. Successful structured report lookup and
  the lookup rule when the two test-type IDs differ were unverified at the vendor.
- The status descriptions, reference data beyond the observed Kansas and US IDs, and the full
  country, language, and state lists use synthetic fixtures. Catalog prices, kit types, sample
  types, and the values of duplicate variants are fixtures. Generated IDs, synthetic tracking,
  dates, and contact, billing, and display defaults are emulator values.
- Authentication accepts any non-empty emulator key. The emulator generates distinct, reproducible
  problem trace IDs. The verification of the vendor's unobserved input combinations is outside the
  scope of the offline recording suite.

## Deliberately not modelled

Practitioner, user, group, or role management, payments and cards, kits and kit orders,
correspondence and notifications, LabVantage, dashboards, bulk order creation, order editing,
and review. Declared operations outside the supported surface return Mockingbird's 501 response.
The package starts in the cold parity tier. With a vendor-issued sandbox `MOSAIC_API_KEY` in
the checkout's gitignored `.env.local`, run `bun run parity:service -- mosaic` from the checkout
root. The live smoke compares the patient, order, and report missing-record responses against the
allowlisted test host. The local acceptance suite covers state changes and result downloads.
