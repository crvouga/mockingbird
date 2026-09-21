# @crvouga/mockingbird-service-customerio

Stateful mock of **Customer.io** for test suites, serving all three hosts our code talks to from
one process: the Segment-compatible **CDP** (`identify`, `track`, `batch`, exactly as
`@customerio/cdp-analytics-node` posts them), the **App API** transactional sends (email, SMS,
inbox message) and message catalog, and the **link-tracking** click endpoint. Sends land in an
outbox a suite asserts on (and reads links out of); reporting events (`unsubscribed`,
`subscribed`, `spammed`, subscription preferences, `clicked`) are posted to our reporting webhook,
signed the way Customer.io signs them.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/customerio/SUPPORT.md)
- The contract (`openapi.yaml`) is hand-authored from Customer.io's CDP (Segment spec) and App API
  references, trimmed to what our consumers send.

## Install

```bash
npm install -D @crvouga/mockingbird-service-customerio
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-customerio serve`, `createServer` from `./server` (Node), or `createRuntime`
with any Fetch server.

## Usage

The app hardcodes Customer.io's hosts per region (`customer-io.config.ts`, seam G-Y1): once
they are env-driven, point the CDP host (the SDK's `host`), the App API host and the link
tracking domain at the mock. Customer.io only runs when `CUSTOMERIO_RUNTIME_ENABLED` is on and
the stage is in `CUSTOMERIO_ALLOWED_STAGES`.

```bash
npx mockingbird-customerio serve --port 8810 \
  --webhook-url http://127.0.0.1:3000/v1/customer-io/reporting-webhook \
  --webhook-secret "$CUSTOMERIO_REPORTING_WEBHOOK_SIGNING_KEY"
```

```ts
import { Analytics } from "@customerio/cdp-analytics-node"
import { createServer } from "@crvouga/mockingbird-service-customerio/server"

const cio = await createServer({
  webhooks: { url: "http://127.0.0.1:3000/v1/customer-io/reporting-webhook", secret: "k".repeat(32) },
})
const analytics = new Analytics({ writeKey: "wk", host: cio.url, maxEventsInBatch: 1 })
analytics.identify({ userId: "42", traits: { email: "ada@example.com" } })
await analytics.closeAndFlush()

// The member unsubscribes in Customer.io: the signed reporting event reaches the backend.
await fetch(`${cio.url}/__admin/reporting-events`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ metric: "unsubscribed", userId: "42", objectType: "customer" }),
})
```

### Routes

| Route | Behaviour |
| --- | --- |
| `POST /v1/identify`, `/v1/track`, `/v1/batch` | CDP, `Authorization: Basic base64(<write key>:)` (else 401 `{error}`). Segment events (`batch` of `identify` / `track`); each needs `userId` or `anonymousId` (else 400 `{error}`, which the SDK does not retry). → `{success: true}`. Identify merges traits into the profile (`email`, `unsubscribed`); a repeated `messageId` is recorded as a duplicate and not applied. |
| `POST /v1/send/email`, `/v1/send/sms`, `/v1/send/inbox_message` | App API, `Authorization: Bearer <app key>` (else 401 `{meta: {error}}`). `{transactional_message_id (id or trigger name), identifiers: {id \| email \| cio_id}, to?, from?, subject?, message_data?, send_to_unsubscribed?, tracked?, disable_message_retention?, headers?, attachments?}` → `{delivery_id, queued_at}`. Validation errors are 400 `{meta: {error}}`. With `strictMessages`, an id that is neither a catalog id nor a trigger name is 400 `{meta: {error: "transactional_message_id not found"}}`. A profile that unsubscribed (or switched the channel off) gets a `suppressed` delivery unless `send_to_unsubscribed`. `disable_message_retention` keeps no `message_data` in the outbox. `tracked: true` rewrites every URL in `message_data` to `<trackingBase>/click/<linkId>`. `to` defaults to the profile's email (email) or `phone` trait (SMS). |
| `GET /v1/transactional` | `{messages: [{id, name, trigger_name, description, send_to_unsubscribed, link_tracking, …}]}`, no pagination. Seeded with `geviti_<key>` for every legacy email key our backend has, plus `geviti_inbox_message` and `geviti_playground_notification` (ids 1–21). |
| `GET /v1/transactional/{id}` | `{message: {...}}` by id or trigger name, or 404. |
| `POST /click/{linkId}` | Our backend's click report (unauthenticated) → 200, counts the click and posts a `clicked` reporting event. Unknown link: plain-text 404. |
| `GET /click/{linkId}` | A browser following a tracked link → 302 to the original URL. |

### Reporting webhook

`POST <webhook-url>` with `x-cio-timestamp: <unix seconds>` and `x-cio-signature: <hex
HMAC-SHA256(secret, "v0:<timestamp>:<body>")>` (wall-clock timestamps). Body: `{event_id,
object_type, metric, timestamp, data: {identifiers: {id, email, cio_id}, customer_id,
email_address, delivery_id?, transactional_message_id?, href?, link_id?, content?}}`; `content`
is the JSON string of subscription preferences. `timestamp` never runs ahead of wall-clock time
(our receiver rejects events > 5 min in the future). Retries, `GET /__admin/webhooks`,
`…/events`, `…/replay`, `…/flush` and `PUT /__admin/webhook-endpoints` work as usual.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `GET /__admin/outbox?to=&since=&channel=&transactional_message_id=&userId=` | Transactional deliveries, oldest first (`GET /__admin/outbox/:id` for one): `channel`, `to`, `identifiers`, `subject`, `messageData`, `links`, `tracked`, `state` (`sent` / `suppressed`), `clicks`, `attachments` (filenames). |
| `POST /__admin/reporting-events` | `{metric, userId? \| email? \| deliveryId?, objectType?, preferences?: {topics?, channels?}}`: apply it to the profile (`unsubscribed`, `subscribed`, `spammed`, `cio_subscription_preferences_changed`) and post the signed event. Any other metric (`delivered`, `opened`, `bounced`, …) is posted as-is. |
| `GET /__admin/cdp/events?userId=&type=&event=` | CDP calls received (with `duplicate`). |
| `GET /__admin/profiles`, `GET /__admin/profiles/:id` | Profiles (traits, `unsubscribed`, `channelsOff`). |
| `GET\|PUT /__admin/transactional` | Read or replace the workspace's transactional messages (`[{id?, name?, trigger_name, link_tracking?, send_to_unsubscribed?}]`). |
| `GET\|PUT /__admin/settings` | `{strictMessages?, trackingBase?, keys?}` (`keys` restricts accepted write / App API keys). |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`; `GET /__admin/faults/presets`):
`transactional_message_missing` (400 meta.error: `trigger_name_missing`, then fallback),
`transactional_404`, `request_timeout_408` (ambiguous: the reservation is kept), `server_error`
(500, ambiguous), `accepted_but_500` (queued, then 500), `rate_limited` (429, definite),
`invalid_app_key`, `send_drop` (socket closes mid-request: ambiguous), `cdp_unavailable` (503;
the SDK retries), `cdp_bad_request` (400; no retry), `cdp_slow` (15 s), `transactional_list_unavailable`,
`omit_trigger_names` (the validator falls back to per-id reads), `webhook_duplicate`,
`webhook_drop`. ECONNREFUSED (a definite failure) is a stopped mock, not a preset.

### Namespaces

`x-mockingbird-namespace`, a `/ns/<name>` prefix on a host, or by key: the CDP write key (Basic
username) or the App API key (Bearer) through `PUT /__admin/credentials {"credentials":
{"<key>": "<namespace>"}}`. The click endpoint carries no credential: use the header or prefix.

### Deliberately not modelled

- Rendering: templates are not rendered; the outbox holds `message_data`, not HTML.
- Campaigns, segments, journeys, broadcasts and the Track API (`track.customer.io`).
- CDP `page`, `screen`, `group` and `alias` calls (our consumers send none).
- Attachments are recorded by filename only. Customer.io documents a `{filename: base64}` map;
  our backend sends `[{filename, content, content_type}]`. Both are accepted; whether the real
  API accepts the array form is unverified (no sandbox credentials).
- Response bodies of the CDP host (`{success: true}`) and exact App API error strings other than
  `transactional_message_id not found` are unverified.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `CustomerIoAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `report(input)`, `profiles()`, `state`. Options: `sqlite`, `now`, `namespace`, `messages`, `settings`, `onReport`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, namespaces, credentials, presets, outbox, reporting webhooks). Options: `webhooks: {url, secret, retryDelaysMs?, fetch?}`, `messages`, `settings`, `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `CUSTOMERIO_PRESETS` | object | Every named fault preset. |
| `CUSTOMERIO_NAMESPACE` | string | The service name, `"customerio"`. |
| `REPORTING_WEBHOOK_PATH` | string | Our receiver's path, `/v1/customer-io/reporting-webhook`. |
| `signReporting` | function | `(secret, timestampSeconds, body)` → the hex `x-cio-signature`. |
| `customerIoCredential` | function | The write key or App API key a request carries. |
| `DEFAULT_TRANSACTIONAL_MESSAGES`, `DEFAULT_SETTINGS`, `TRANSACTIONAL_EMAIL_KEYS` | values | The seeded catalog, settings, and our backend's legacy email keys. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target; port 8810. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
