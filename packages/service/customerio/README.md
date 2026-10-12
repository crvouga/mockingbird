# @crvouga/mockingbird-service-customerio

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful emulator of **Customer.io** for test suites, serving all three hosts our code talks to from
one process: the Segment-compatible **CDP** (`identify`, `track`, `batch`, exactly as
`@customerio/cdp-analytics-node` posts them), the **App API** transactional sends (email, SMS,
inbox message), message catalog, profile attribute reads, sender opt-out reconciliation, and delivery-status reads, and the
**link-tracking** click endpoint. Sends land in an outbox a suite asserts on (and reads links out
of); reporting events (`unsubscribed`, `subscribed`, `spammed`, subscription preferences,
`clicked`) are posted to our reporting webhook, signed the way Customer.io signs them.

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
tracking domain at the emulator. Customer.io only runs when `CUSTOMERIO_RUNTIME_ENABLED` is on and
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

// The application's CDP client. Only its host changes.
const analytics = new Analytics({ writeKey: "wk", host: cio.url, maxEventsInBatch: 1 })
analytics.identify({ userId: "42", traits: { email: "ada@example.com" } })
await analytics.closeAndFlush()

// Test control. The member unsubscribes in Customer.io: the signed reporting event reaches the backend.
await fetch(`${cio.url}/__admin/reporting-events`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ metric: "unsubscribed", userId: "42", objectType: "customer" }),
})
await cio.close()
```

Transactional sends go through the App API client (`customerio-node`), pointed at the same
emulator. The test then reads back what the app sent:

```ts
import { Analytics } from "@customerio/cdp-analytics-node"
import { APIClient, SendEmailRequest } from "customerio-node"
import { createServer } from "@crvouga/mockingbird-service-customerio/server"

const cio = await createServer()

// The application's clients. Only the CDP host and the App API url change.
const analytics = new Analytics({ writeKey: "wk", host: cio.url, maxEventsInBatch: 1 })
const api = new APIClient("app-key", { url: `${cio.url}/v1` })
analytics.identify({ userId: "42", traits: { email: "ada@example.com" } })
await analytics.closeAndFlush()
await api.sendEmail(
  new SendEmailRequest({ transactional_message_id: 1, identifiers: { id: "42" }, to: "ada@example.com" }),
)

// Test assertions read the emulator's state.
const profiles = await (await fetch(`${cio.url}/__admin/profiles`)).json()
const deliveries = await (await fetch(`${cio.url}/__admin/outbox?userId=42`)).json()
await cio.close()
```

### Routes

| Route | Behaviour |
| --- | --- |
| `POST /v1/identify`, `/v1/track`, `/v1/batch` | CDP, `Authorization: Basic base64(<write key>:)` (else 401 `{error}`). Segment events (`batch` of `identify` / `track`); each needs `userId` or `anonymousId` (else 400 `{error}`, which the SDK does not retry). A batch is validated before any entry is applied. → `{success: true}`. Identify shallow-merges traits; `cio_subscription_preferences.channels` / `.topics` merge one level so omitted keys and explicit `false` remain. Concurrent identifies on one profile are serialized. A repeated `messageId` is recorded as a duplicate and not applied. |
| `POST /v1/send/email`, `/v1/send/sms`, `/v1/send/inbox_message` | App API, `Authorization: Bearer <app key>` (else 401 `{meta: {error}}`). `{transactional_message_id (id or trigger name, case-insensitive), identifiers: exactly one of id \| email \| cio_id, to?, from?, subject?, message_data?, send_to_unsubscribed?, tracked?, disable_message_retention?, headers?, attachments?}` → `{delivery_id, queued_at}`. Validation errors are 400 `{meta: {error}}`. SMS `to`, when present, must be E.164. With `strictMessages`, an unknown id is 400 `{meta: {error: "transactional_message_id not found"}}`. An `identifiers.id` with no profile creates a minimal one; `to` stays the literal recipient. Accepted sends start `pending` (not delivered). A profile that unsubscribed, or whose email/SMS channel is `false`, gets `suppressed` unless `send_to_unsubscribed` (inbox follows only the unsubscribed flag). `disable_message_retention` drops `message_data` from the outbox unless `retainMessageDataForTests`. `tracked: true` rewrites every URL to `<trackingBase>/click/<linkId>`. There is no send idempotency: a repeat creates another delivery. |
| `GET /v1/transactional` | `{messages: [{id, name, trigger_name, description, send_to_unsubscribed, link_tracking, …}]}`, no pagination (the whole catalog, including hundreds of rows). Seeded with `acme_<key>` for every legacy email key the consumer app has, plus `acme_inbox_message` and `acme_playground_notification` (ids 1–21). `transactionalListKey: "transactional"` renames the array key. |
| `GET /v1/transactional/{id}` | `{message: {...}}` by id or trigger name (case-insensitive), or 404. |
| `GET /v1/customers/{customer_id}/attributes?id_type=id\|email\|cio_id` | `{customer: {identifiers: {id, email?, cio_id}, attributes, devices}}`. Unknown `id_type` is 400; an unknown customer is 404. Attributes spread stored traits, then `id`, `cio_id`, `email`, and `unsubscribed` win. |
| `GET /v1/optouts?limit=&start=&from=` | Workspace sender opt-outs as `{optouts: [{customer_id, cio_id, optouts: [{channel, from}]}], next?}`. `limit` defaults to 100 (1–1000); follow `next` using `start` until it is absent. `from` filters sender/channel entries, omitting people with no matches. Sender values are trimmed and lowercased; E.164 numbers retain their form. |
| `GET /v1/customers/{customer_id}/optouts?id_type=id\|email\|cio_id` | `{optouts: [{channel, from}]}` for an existing profile, empty if none, 404 for unknown people. Uses the same identity state as CDP identify and profile updates. App API authentication applies to both reads. |
| `GET /v1/messages/{delivery_id}` | `{message: {id, type, recipient, customer_id, created, state, status, metrics}}`. `type` is `in_app` for inbox. No `message_data`. 404 when the id is missing or still inside `statusVisibleAfterMs`. Failure states add `failure_message`, `rejection_reason`, and `error`. |
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
| `GET /__admin/outbox?to=&recipient=&since=&channel=&transactional_message_id=&userId=&deliveryId=` | Transactional deliveries, oldest first (`GET /__admin/outbox/:id` for one): `channel`, `to`, `identifiers`, `subject`, `messageData`, `links`, `originalLinks`, `tracked`, `state` (`pending` until transitioned, or `suppressed`), `reason`, `metrics`, `clicks`, `attachments` (filenames). `recipient` matches `to`. The journal records method, path, and status, never the body, the API key, or message content. |
| `POST /__admin/reporting-events` | `{metric, userId? \| email? \| deliveryId?, objectType?, preferences?: {topics?, channels?}}`: apply it to the profile (`unsubscribed`, `subscribed`, `spammed`, `cio_subscription_preferences_changed`) and post the signed event. Any other metric (`delivered`, `opened`, `bounced`, …) is posted as-is. |
| `GET /__admin/cdp/events?userId=&type=&event=` | CDP calls received (with `duplicate`). |
| `GET /__admin/profiles`, `GET /__admin/profiles/:id`, `PUT /__admin/profiles/:id` | Profiles (traits, `cioId`, `unsubscribed`, `channelsOff`, `preferences`). PUT merges `{traits?, email?, unsubscribed?, preferences?}`. |
| `POST /__admin/optouts` | `{customerId, from, optout: boolean, channel?: "sms"\|"whatsapp"}` scripts STOP (`true`) or START (`false`) for an existing person; unknown people are 404. Only that sender/channel changes. Marketing preferences and reporting webhooks stay independent. State participates in namespaces, snapshots, Timeline, clocks and reset. |
| `POST /__admin/deliveries/:id` | `{"state": "pending"\|"sent"\|"delivered"\|"bounced"\|"dropped"\|"failed"\|"spammed"\|"undeliverable"\|"suppressed"}`. Stamps `metrics[state]` with unix seconds on the namespace clock. `delivered` is success; the failure states are terminal. |
| `POST /__admin/namespace-clock` | `{"advance": <ms>}` adds to this namespace's clock offset only. |
| `GET\|PUT /__admin/transactional` | Read or replace the workspace's transactional messages (`[{id?, name?, trigger_name, link_tracking?, send_to_unsubscribed?}]`). |
| `GET\|PUT /__admin/settings` | `{strictMessages?, trackingBase?, keys?, statusVisibleAfterMs?, clockOffsetMs?, retainMessageDataForTests?, transactionalListKey?}` (`keys` restricts accepted write / App API keys). |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`; `GET /__admin/faults/presets`):
`transactional_message_missing` (400 meta.error: `trigger_name_missing`, then fallback; no delivery),
`transactional_404`, `request_timeout_408` (408 before enqueue, no delivery, ambiguous), `server_error`
(500 before enqueue, no delivery, ambiguous), `accepted_but_500` (queued, then 500), `rate_limited`
(429 with numeric `Retry-After`, definite, no delivery), `invalid_app_key`, `send_drop` and
`send_drop_before_accept` (socket closes before enqueue: ambiguous, no delivery),
`send_drop_after_accept` (delivery recorded, then the socket closes: ambiguous, one delivery),
`cdp_unavailable` (503; the SDK retries), `cdp_bad_request` (400; no retry), `cdp_slow` (15 s, past
the 10 s delivery timeout), `transactional_list_unavailable`, `omit_trigger_names` (omit every
`trigger_name`, or only `params.ids`), `webhook_duplicate`, `webhook_drop`, `webhook_reorder`.
A manual fault can inject 403 or 503, or a 429 whose `Retry-After` is an HTTP-date. ECONNREFUSED
(a definite failure) is a stopped emulator, not a preset. 401 is `{error}` on the CDP and
`{meta: {error}}` on the App API. Keys mapped to the same namespace share profiles and deliveries;
two namespaces do not, including faults and clock offsets. Resetting one namespace leaves the other.

### Namespaces

`x-mockingbird-namespace`, a `/__admin/ns/<name>` prefix on a host, or by key: the CDP write key (Basic
username) or the App API key (Bearer) through `PUT /__admin/credentials {"credentials":
{"<key>": "<namespace>"}}`. The click endpoint carries no credential: use the header or prefix.

### Deliberately not modelled

- Opt-out writes through the public PUT API, phone identifier workspace configuration, Twilio sender identity casing recovery, and automatic carrier STOP callbacks. Use the admin control to script reconciler state; it does not model carrier delivery enforcement.
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
| `CustomerIoAPI` | class | The in-process emulator: `fetch(request)`, `reset()`, `report(input)`, `profiles()`, `mergeProfile(id, patch)`, `transitionDelivery(id, state)`, `advanceClock(ms)`, `state`. Options: `sqlite`, `now`, `wallClock`, `namespace`, `messages`, `settings`, `onReport`. |
| `createRuntime` | function | The emulator with the full service contract (health, admin, namespaces, credentials, presets, outbox, reporting webhooks). Options: `webhooks: {url, secret, retryDelaysMs?, fetch?}`, `messages`, `settings`, `clock`, `wallClock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `CUSTOMERIO_PRESETS` | object | Every named fault preset. |
| `CUSTOMERIO_NAMESPACE` | string | The service name, `"customerio"`. |
| `REPORTING_WEBHOOK_PATH` | string | Our receiver's path, `/v1/customer-io/reporting-webhook`. |
| `signReporting` | function | `(secret, timestampSeconds, body)` → the hex `x-cio-signature`. |
| `customerIoCredential` | function | The write key or App API key a request carries. |
| `DEFAULT_TRANSACTIONAL_MESSAGES`, `DEFAULT_SETTINGS`, `TRANSACTIONAL_EMAIL_KEYS` | values | The seeded catalog, settings, and our backend's legacy email keys. |
| `DELIVERY_STATES` | values | Delivery lifecycle states. An accepted send starts at `pending`. |
| `FAILURE_STATES` | values | Terminal failure states: `bounced`, `dropped`, `failed`, `spammed`, `undeliverable`, `suppressed`. `delivered` is success; `sent` stays open. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target; port 8810. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
