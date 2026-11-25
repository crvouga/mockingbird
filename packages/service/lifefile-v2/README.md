# @crvouga/mockingbird-service-lifefile-v2

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful emulator of **LifeFile API v2**, the order platform compounding pharmacies run on, for
test suites and long-running local stacks. Its behaviour is matched to **recorded sandbox
replies**: 149 calls a probe made against the LifeFile v2 sandbox on 2026-11-24, committed
(sanitized) in `corpus/` and replayed in CI. Where the recordings and LifeFile's published
contract disagree, the recordings win.

It models OAuth2 client-credentials sign-in with absolute and idle token expiry, secret expiry and
rotation; order creation with the sandbox's field-keyed validation and **no deduplication**;
order, status and shipping reads; rx-UUID search; status writes with the **fast-track cancel
window**; shipping updates (including the sandbox's 500 on a bare body); status, location and
shipping-service lists for a sandbox and a production catalog; privilege refusals; rate limits;
and a Basic-auth **Data Push** whose payload is a **provisional placeholder** (see
[Data Push](#data-push-provisional)).

This package is separate from `@crvouga/mockingbird-service-lifefile`, the best-guess emulator of
LifeFile's older `/order` API with Basic auth, which it leaves unchanged.

## Install

```sh
bun add -d @crvouga/mockingbird-service-lifefile-v2
```

## Usage

Point the application's LifeFile base URL at `<server.url>/api/v2` and its token URL at
`<server.url>/api/v2/auth/token`. The default API user is `lifefile-client` /
`lifefile-secret` with vendor id `10001`; any other client id signs in too (open enrollment), so a
suite can give every test its own credentials. `serve --client-id` closes open enrollment, so a
mistyped client id fails with `401 invalid_client` as it would against LifeFile; add
`--open-enrollment` to keep it open. `settings.openEnrollment: false` does the same per namespace.

```ts
import { createServer } from "@crvouga/mockingbird-service-lifefile-v2/server"

const server = await createServer({ latency: "none" })
try {
  const api = `${server.url}/api/v2`
  const token = await fetch(`${api}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-vendor-id": "10001" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "lifefile-client",
      client_secret: "lifefile-secret",
    }),
  })
  const { access_token } = (await token.json()) as { access_token: string }
  const headers = {
    authorization: `Bearer ${access_token}`,
    "x-vendor-id": "10001",
    "content-type": "application/json",
  }
  const created = await fetch(`${api}/orders`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      message: { id: 1, sentTime: "2026-11-24 22:57:53" },
      order: {
        location: { id: 100001 },
        practice: { id: 900001 },
        patient: { lastName: "Synthetic", firstName: "Probe", dateOfBirth: "1990-01-01" },
        rxs: [
          {
            rxType: "new",
            drugName: "Synthetic Compound",
            scheduleCode: "O",
            uuid: "f120f5b8-09fd-4b7d-a01b-08c4ec85bc25",
          },
        ],
      },
    }),
  })
  const { data } = (await created.json()) as { data: { orderId: number } }
  const status = await fetch(`${api}/orders/${data.orderId}/status`, { headers })
  console.log(await status.json())
} finally {
  await server.close()
}
```

Test setup (no vendor equivalent) goes through the admin routes, for example moving an order on
and pushing its tracking number:

```ts
import { createServer } from "@crvouga/mockingbird-service-lifefile-v2/server"

const server = await createServer({
  latency: "none",
  push: { url: "http://127.0.0.1:3100/webhooks/lifefile", username: "u", password: "p" },
})
const admin = (path: string, body: unknown) =>
  fetch(`${server.url}/__admin${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
await admin("/orders/50000001/status", { status: "pro" })
await admin("/orders/50000001/push", { tracking: { trackingNumber: "1Z999AA10123456784", carrier: "UPS" } })
await admin("/faults", { preset: "create_lost_reply", count: 1 })
await server.close()
```

### Routes (vendor)

All under `/api/v2`, every one but the token endpoint behind `Authorization: Bearer` and
`X-Vendor-ID`. `SUPPORT.md` lists them with their parity status.

| Route | Behaviour (recorded unless marked *guess*) |
| --- | --- |
| `POST /auth/token` | Form or Basic credentials. No `X-Vendor-ID`, or `grant_type` other than `client_credentials`: `422 {"error":"invalid_request","error_description":"Validation Error"}`. Wrong secret, other vendor, or an expired secret (*guess*): `401 {"error":"invalid_client","error_description":"Invalid Credentials"}`. Success: `{access_token, token_type:"Bearer", expires_in:86400, scope:"*"}` (the contract says 172800; the sandbox answers 86400). |
| `DELETE /auth/token` | Revokes the calling token. |
| `GET /auth/me` | API user, token times in Pacific offset (`2026-11-24T14:57:52-08:00`), live privileges. |
| `POST /auth/secret/rotate` | New secret, valid 30 days; every token of the user dies; `revokedTokenCount`. Seeded, open-enrollment and admin-set secrets never expire, so a long-lived stack keeps signing in; only a rotated secret (or `expire-secret`) does. |
| `POST /orders` | Checked in the sandbox's order: `order.location.id` (only that error, even for an empty body), then the location (`422 Invalid order location id received: '<id>'`), then the practice (`403 This API user is not allowed to create an order for Practice ID <id>.`), then field-keyed `422 Validation Error` (required fields, the contract's length limits and enums, rx uuid format, rx uuid unique within the order ignoring case). Reply `{orderId}` only. Same message id, same rx uuid and byte-identical bodies each make a new order. Not checked: phones, California, unknown shipping service ids, unknown `lfProductID`, text message ids. |
| `GET /orders` | Newest first; `page`, `perPage` (5–50), `sortField`, `sortType`; strict `filter[...]` deep objects (an array form such as `filter[rx][uuid][]` is refused with `422`, never ignored); `filter[rx][uuid]` is case-insensitive and read from an index. Envelope `{data, total, perPage, currentPage, lastPage}`. |
| `GET /orders/{id}`, `/status`, `/shipping` | The recorded shapes, null-filled. Missing: `404 Record not found`; not an integer: `422 {"orderId":["The order id must be an integer."]}`. |
| `PUT /orders/{id}/status` | Any code in the catalog, in any order (even back to `new` after `del`); unknown code `404 Order Status ID '<code>' does not exist`. See [fast track](#fast-track-cancel-and-intake). |
| `PUT /orders/{id}/shipping` | `{"shipping": {...}}` merges into the order's shipping. A bare object answers `500` and changes nothing, as the sandbox does; the vendor's own crash text is replaced with a generic one. |
| `GET /statuses`, `/locations`, `/locations/{id}`, `/shipping-services` | The catalog's reference lists, paginated. |
| `GET /practices/{id}/shipping-services`, `/locations/{id}/shipping-configurations` | `403 The authenticated API user does not have the required privilege '<id>'.` unless the user is granted it (then an empty page). |
| `GET /ping` | `{http_method, ssl_client_verify: null}`. |

Bearer errors, all `401`: no or non-Bearer header `Authorization header is expected to reference
a Bearer authentication` (`data: null`); not three segments `Invalid authorization token: Wrong
number of segments` (`data: []`); no `X-Vendor-ID` `X-Vendor-ID header is required`. *Guesses*,
not yet recorded: `Signature verification failed`, `Expired token` and `Token is no longer
active` (idle, revoked, rotated). Responses carry `X-RateLimit-Limit` / `X-RateLimit-Remaining`
(1000 per minute for the API, 120 for tokens).

### Fast-track cancel and intake

The sandbox does two things to a new order that the contract does not mention:

- **Fast track.** A `del` that is the first request to touch an order, within
  `fastTrackWindowMs` (default 2000 ms on the mock clock) of its creation, does not cancel it: the
  order lands on `b3644` ("New EMR interfaces") and the reply has another shape,
  `{order_status_changed: 1, original_order_status: "new", current_order_status: "b3644",
  process_fast_track_result: []}`. Recorded 4 of 4 times. After any other request on the order, or
  after the window, `del` works, and a second `del` is harmless. A client should read the status
  back after cancelling and send `del` again if it did not stick.
- **Intake.** An order whose status nobody wrote moves itself to `b3644` about half a second after
  creation (`intake: {status, afterMs}`), without changing `lastUpdatedOn`. On the wall clock it
  happens on time with no further request (a timer), and its Data Push goes out then; on a frozen
  mock clock it happens at the first request or clock advance after it is due. Only in the sandbox
  catalog; the production catalog has no such status and sets `intake: null`.

### Catalogs

`settings.catalog` picks the status codes, locations and shipping services: `sandbox` (89 codes,
three locations `100001`–`100003`, 11 services) or `production` (one pharmacy's 55 codes, location
`100101`, 7 services). Account ids are synthetic. The production catalog keeps the account's real
status codes, but a label is kept only where the sandbox has the same code with the same label
(`new`, `del`, `pro`, …); every other label is `Production Status P-nn`, and the shipping services
are `Production Shipping S-n` with synthetic ids (`60001`…) and prices. The
sandbox listed 91 statuses during the probe and 89 in that day's export; the emulator seeds the
89 it knows.

### Data Push (provisional)

LifeFile calls the pharmacy's configured URL with Basic auth when an order changes. **Its JSON
format is not published and has not been recorded yet**, so the body this emulator sends is a
placeholder, marked on every delivery with `x-mockingbird-push-shape: provisional-2026-11`:

```json
{
  "event": "order.status.changed",
  "orderId": 50000001,
  "referenceId": "ref-0001",
  "status": { "id": "pro", "label": "Completed Orders" },
  "previousStatus": { "id": "new", "label": "New Order" },
  "changedOn": "2026-11-24 14:57:53",
  "rxs": [{ "uuid": "f120f5b8-…", "rxNumber": null, "fillId": null }],
  "shipping": { "trackingNumber": "1Z999AA10123456784", "carrier": "UPS", "service": null }
}
```

`shipping` appears only on a push sent with tracking. A push goes out on every status change
(API writes, fast track, intake, admin) and on `POST /__admin/orders/:id/push`. Deliveries retry
at 0, 5 s and 30 s, then give up. Replace this shape when a real push is recorded.

### Admin (beyond the standard contract)

| Route | Body | Effect |
| --- | --- | --- |
| `GET /__admin/orders` | | The namespace's orders, newest first. |
| `POST /__admin/orders/:id/status` | `{status, push?}` | Move an order to any catalog code (push unless `push: false`). `404` for an unknown order or code. |
| `POST /__admin/orders/:id/push` | `{tracking?: true \| {trackingNumber, carrier?, service?}, badCredentials?}` | Send a push now, with or without tracking. |
| `POST /__admin/tokens/revoke` | | Every token in the namespace dies. |
| `GET` / `PUT /__admin/api-users` | `{clientId, secret?, privileges?, practiceId?, vendorId?, userGroup?}` | List or upsert API users (secrets never listed). |
| `POST /__admin/api-users/:clientId/expire-secret` | | The secret is past its 30 days: no new tokens. |
| `GET` / `PUT /__admin/settings` | any of `catalog`, `vendorId`, `enforceVendorId`, `openEnrollment`, `tokenTtlSeconds`, `tokenIdleSeconds`, `secretTtlDays`, `fastTrackWindowMs`, `fastTrackStatus`, `intake`, `timeZone`, `practice`, `rateLimits`, `push` | Per-namespace settings. Unknown keys, an unknown IANA `timeZone`, a status code outside the catalog (`intake.status`, `fastTrackStatus`), ids and limits that are not whole numbers >= 1 are refused with `400`. `rateLimits: null` turns limiting off. The push password is never returned. |
| `PUT /__admin/push` | `{url, username, password}` or `null` | Where this namespace's pushes go. |

### Presets

`POST /__admin/faults {"preset": "<name>", "count"?: n}`:

| Preset | Effect |
| --- | --- |
| `create_lost_reply` | The order is created, then the connection drops: the caller cannot tell it exists. |
| `server_error`, `unavailable` | `500` / `503` in LifeFile's error envelope, nothing stored. |
| `rate_limited`, `token_rate_limited` | `429` with `Retry-After: 60`. |
| `token_revoked` | API calls answer `401` for an inactive token. |
| `invalid_client` | Token requests answer `401 invalid_client`. |
| `push_duplicate`, `push_reorder`, `push_drop` | The next push twice, the next two swapped, the next one lost. |

Plus every standard preset (`timeout`, `connection_reset`, `flaky`, …), the clock, latency,
snapshots and the rest of the [admin controls](https://github.com/crvouga/mockingbird/blob/main/docs/ADMIN_CONTROLS.md).

### Latency

By default every operation waits about as long as the sandbox did: reads ~200 ms, create
~1.3 s, status writes ~1.1 s (`RECORDED_LATENCY_MS`). Pass `latency: "none"` (or `--no-latency`)
to answer at once, or turn on virtual time (`adminControls: {virtualTime: true}`) so the waits move
the mock clock instead of the wall clock; the fast-track window and intake then behave as
recorded without slowing a suite.

### Namespaces and long runs

Namespaces by `x-mockingbird-namespace`, by `/__admin/ns/<name>/…` (use it on both the API and
the token URL), or by client id (`PUT /__admin/credentials`; sign-in routes by the Basic username or the form
`client_id`, and the bearer token names its client).
Orders, tokens, users, settings and pushes live in the namespace and go with it
(`DELETE /__admin/namespaces/<name>`). A token works only in the namespace that issued it and only
while its row is there, even if the same client signs in again: after a reset, a namespace delete or restoring a snapshot taken before it
was issued, it answers `401` (`Token is no longer active`) and the caller signs in again. So that a token never comes back to life, token bytes after a reset, restore or checkout deliberately differ from a fresh run's: each namespace keeps its own issue count in the shared SQLite store, outside namespace state, which nothing rewinds, and sign-ins in one namespace never shift another's tokens. That count is one small row per namespace that ever signed in, kept for the life of the store. `createRuntime` takes `namespaceIdleMs`, `maxRecords`,
`maxSnapshots`, `checkpointMutations`, `maxOrders` and `maxApiUsers`. `serve` forgets namespaces idle
for 30 minutes and caps each namespace (the never-forgotten default one included) at 25,000 orders
(`--max-orders`; the next create answers `507`), 1,000 API users added by open enrollment
(`--max-api-users`) and 50 snapshots (`--max-snapshots`). Both caps cost nothing per write. The
generic record cap (`--max-records`) is off by default, because each insert under it counts the
whole namespace, so writes slow down as the namespace grows. `serve` also skips the time-travel
checkpoint after every write, which reads the whole namespace (`--checkpoint-mutations` turns it
back on); snapshots taken on request still work. A sign-in drops token rows that are already dead
(past their lifetime or idle hour); revoked ones stay until then. Rx-UUID searches read an index,
never every order. A read at a checkpoint (`x-mockingbird-at` on main) shows the namespace as it
was there and changes nothing: no intake runs and no Data Push is sent, and the bearer token is
checked against the live namespace, so any token that works live reads history. Such a read
does not count as token use: it leaves the live token's idle hour running.

Rate limits count per vendor id per minute on the namespace's mock clock: a header naming a
vendor the namespace does not know shares one `unknown` window, and windows from past minutes are
dropped. A frozen clock never reaches the next minute, so a suite that freezes time and makes over
1,000 calls (or 120 sign-ins) sees `429` until it advances the clock or sets `rateLimits: null`.

`bun run soak` drives 20 simulated tests a minute for 30 minutes (`soak:long` for six hours), each
in its own namespace plus one order in the long-lived default namespace, and fails if any call
after the warm-up window takes over 50 ms, p95 drifts over 10 % (and over 1 ms, so sub-millisecond
jitter does not count), heap grows over 50 MB after warm-up, push p95 passes 1 s, live namespaces
pile up, or the default namespace holds over 4 records per order.
The compressed soak in `bun test` checks only the resource bounds; timing is the script's job.

### Deliberately not modelled

- Documents, linked orders, practice notes, pricing, and shipping-service writes (not in the
  contract this package ships).
- EPCS signing and controlled-substance rules.
- The pharmacy's own business rules (California, phones, product ids): the API does not check
  them, so neither does the emulator.
- The real Data Push format and its retry policy (provisional until recorded).
- Messages for expired, revoked or forged tokens and for an expired secret (guessed).
- IP allow-lists.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `LifeFileV2API` | class | The in-process emulator: `fetch(request)`, `reset()`, `orders()`, `orderDto(order)`, `setStatus(id, code, {push?})`, `emitPush(id, tracking, badCredentials?)`, `revokeTokens()`, `expireSecret(clientId)`, `runDue()`, `state`. Options: `sqlite`, `now`, `namespace`, `settings`, `apiUsers`, `onPush`. |
| `createRuntime` | function | The emulator with the full service contract. Options: `latency`, `push: {url, username, password, retryDelaysMs?, fetch?}`, `settings`, `apiUsers`, `namespaceIdleMs`, `maxRecords`, `maxSnapshots`, `clock`, `seed`, `adminPrefix`, `adminKey`, `adminControls`, `onLog`. |
| `LIFEFILE_V2_PRESETS` | object | Every named fault preset. |
| `LIFEFILE_V2_NAMESPACE` | string | The service name, `"lifefile-v2"`. |
| `tokenCredential` | function | The client id a request's bearer token (or Basic header) names. |
| `LifeFileState` | class | One namespace's collections (orders, rx index, tokens, API users, settings). |
| `CATALOG_DATA`, `CATALOGS`, `SANDBOX_STATUSES`, `PRODUCTION_STATUSES`, `CORPUS_VERSION` | values | The reference lists per catalog. |
| `DEFAULT_SETTINGS`, `DEFAULT_CLIENT`, `RECORDED_LATENCY_MS` | values | Default settings, the seeded API user, the recorded latency per operation. |
| `pushBody`, `basicPushSigner`, `PUSH_EVENT`, `PUSH_SHAPE_HEADER`, `PROVISIONAL_PUSH_SHAPE`, `PUSH_RETRY_DELAYS_MS` | values / functions | The provisional push body, its Basic-auth signer and markers. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target (`--push-url`, `--push-username`, `--push-password`, `--catalog`, `--client-id`, `--client-secret`, `--open-enrollment`, `--no-latency`, `--namespace-idle-ms`, `--max-orders`, `--max-api-users`, `--max-records`, `--max-snapshots`, `--checkpoint-mutations`); port 8932. |

## Development

```bash
bun test                       # acceptance through test/consumer.ts, runtime contract, the 149-call
                               # sandbox replay, self-parity and field-limit properties, a short soak
bun run parity                 # replay corpus/probe-calls.json and print every diff; then, with
                               # LIFEFILE_V2_CLIENT_ID / _CLIENT_SECRET / _VENDOR_ID, compare read-only
                               # calls against the live sandbox (exits 2 without them)
bun run soak                   # 30 minutes; soak:long for 6 hours; report in .soak/
bun scripts/vendor-openapi.ts <LifeFile openapi.json>   # re-vendor openapi.yaml, then bun run generate
bun scripts/record-corpus.ts <probe runs dir> <reference dir>   # re-sanitize a new probe into corpus/
```

Part of [mockingbird](https://github.com/crvouga/mockingbird).
