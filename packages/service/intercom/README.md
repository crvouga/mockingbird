# @crvouga/mockingbird-service-intercom

Stateful mock of the **Intercom REST API (version 2.11)** for test suites. It serves the calls
our backend makes:

- **contacts:** search, create (409 on duplicates, the way Intercom does), update and get;
- **conversations:** create (optional `Idempotency-Key`), update, reply as the member or as an
  admin (JSON or multipart attachments), close/open/snooze/assign, get with
  `?display_as=plaintext`, and cursor-paginated search;
- **identity:** `/admins` and `/me`.

Admin replies and close/open send Intercom's `notification_event` webhooks, signed with
`X-Hub-Signature: sha1=<hex HMAC-SHA1>`, to both of our receivers: the backend's
`POST /messaging/webhook` and the EMR's `POST /v1/webhooks/intercom`.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/intercom/SUPPORT.md)
- The contract (`openapi.yaml`) is trimmed from Intercom's published 2.11 reference to what our
  consumers use.

## Install

```bash
npm install -D @crvouga/mockingbird-service-intercom
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-intercom serve`, `createServer` from `./server` (Node), or `createRuntime` with
any Fetch server.

## Usage

```bash
npx mockingbird-intercom serve --port 8807 \
  --webhook-url http://127.0.0.1:3000/messaging/webhook \
  --emr-webhook-url http://127.0.0.1:4000/v1/webhooks/intercom \
  --webhook-secret "$INTERCOM_WEBHOOK_SECRET"
```

| Consumer | Setting |
| --- | --- |
| Member messaging adapter (`intercom-messaging.adapter.ts`) | `INTERCOM_API_BASE_URL=http://127.0.0.1:8807` (already read), `INTERCOM_ACCESS_TOKEN=<any>` |
| Intercom sync adapter (`intercom-api.adapter.ts`) | Seam **G-I1**: this adapter hardcodes `https://api.intercom.io` today, so it needs an env base URL. Its writes are also gated by `FEATURE_INTERCOM_SYNC_ENABLED`. |
| Both webhook receivers | `INTERCOM_WEBHOOK_SECRET` = `--webhook-secret` |

```ts
import { createRuntime } from "@crvouga/mockingbird-service-intercom"

const intercom = createRuntime({
  webhooks: {
    urls: ["http://127.0.0.1:3000/messaging/webhook", "http://127.0.0.1:4000/v1/webhooks/intercom"],
    secret: "whsec-test",
  },
})
// …the member opens a conversation through the app (POST /conversations)…

// Support answers: appends an admin comment and fires the signed conversation.admin.replied.
await intercom.fetch(
  new Request("http://intercom.test/__admin/conversations/215470000000001/admin-reply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminId: "1000001", body: "Your results are in" }),
  }),
)
```

### Routes

Every route needs `Authorization: Bearer <token>`. Any non-empty token is accepted unless
`tokens` is set. `Intercom-Version` defaults to 2.11, and a malformed value answers 400
`intercom_version_invalid`. Every error uses Intercom's envelope:
`{type: "error.list", request_id, errors: [{code, message}]}`.

| Route | Behaviour |
| --- | --- |
| `POST /contacts/search` | `{query, pagination?}` → `{type: "list", data, total_count, pages}`. See "Search" below. |
| `POST /contacts` | `{role, external_id?, email?, name?, phone?, signed_up_at?, custom_attributes?}` → the contact, whose `id` is 24 hex characters. A `user` needs an email or external_id. A second `user` with the same `external_id`, or the same email (case-insensitive), answers **409** `conflict`: "A contact matching those details already exists with id=…". The sync adapter then searches and PUTs. Leads never conflict. |
| `PUT /contacts/{id}` | Partial update. `custom_attributes` are merged. 404 `User Not Found`; 409 if the new identifiers collide. |
| `GET /contacts/{id}` | The contact (`name`, `email`, `external_id`, …), or 404. |
| `POST /conversations` | `{from: {type: "user", id}, body}` → `{type: "user_message", id, created_at, body, message_type: "inapp", conversation_id}`. The contact must exist (404 otherwise). An `Idempotency-Key` header replays the stored response for the same body. A different body with the same key is a 409. |
| `PUT /conversations/{id}` | `{read?, title?, custom_attributes?}` (for example `{custom_attributes: {chatbot_escalation: true}}` or `{read: true}`) → the conversation. |
| `POST /conversations/{id}/reply` | JSON `{message_type: "comment", type: "user", intercom_user_id \| user_id \| email, body, attachment_files?: [{content_type, name, data (base64)}], attachment_urls?}`, or `{type: "admin", admin_id, message_type: "comment" \| "note" \| "quick_reply", body}`. **Or multipart**, with the same fields plus `attachment_files[]` file parts. Returns the conversation. |
| `POST /conversations/{id}/parts` | `{message_type: "close" \| "open" \| "snoozed" \| "assignment", type: "admin", admin_id, snoozed_until?, assignee_id?}` → the conversation. |
| `GET /conversations/{id}?display_as=plaintext` | `id, state, open, read, created_at, source{id, body, author{type, id, name, email}, attachments, delivered_as}, contacts.contacts[0].external_id, conversation_parts.conversation_parts[]` (every part type, including close/open/note; our adapter keeps `comment`), teammates, custom_attributes. |
| `POST /conversations/search` | `{query, pagination: {per_page ≤ 150, starting_after}, sort_field, sort_order}` → `{type: "conversation.list", conversations, total_count, pages: {page, per_page, total_pages, next?: {page, starting_after}}}`. Like the real API, results carry **no `conversation_parts`**. |
| `GET /admins` | `{type: "admin.list", admins: [{id, name, email, …}]}`. The seeded admins are `1000001` (`support@mock.intercom.local`) and `1000002` (`clinician@mock.intercom.local`). |
| `GET /me` | The token's admin and app. |

Conversation state follows Intercom:

- Admin comments set `read: false`, meaning unread for the member.
- Member replies set `read: true`, set `waiting_since`, and reopen a closed or snoozed
  conversation.
- `PUT {read: true}` marks the conversation read.
- Notes change nothing the member sees.
- Bodies are stored as HTML. Plain text is wrapped in `<p>`, one paragraph per line, and
  `display_as=plaintext` turns it back into text.

Attachments keep their metadata only: name, content type, size, and a
`downloads.intercomcdn.com` URL that is not served. The uploaded bytes are never stored.

### Search

A query is either a filter `{field, operator, value}` or a compound
`{operator: "AND" | "OR", value: [query, …]}`, nested up to two levels.

- **Operators:** `=`, `!=`, `IN`, `NIN` (these two take an array), `<`, `>`, `~` (contains),
  `!~`, `^` (starts with) and `$` (ends with). String comparisons are case-insensitive.
- **Contact fields:** `id`, `external_id`, `email`, `name`, `phone`, `role`, the timestamps,
  and `custom_attributes.<name>`.
- **Conversation fields:** `id`, `contact_ids`, `teammate_ids`, `admin_assignee_id`,
  `team_assignee_id`, `state`, `open`, `read`, `priority`, `title`, the timestamps, and
  `source.{id,type,delivered_as,subject,body,author.id,author.type,author.name,author.email}`.
- **Unknown fields or operators** answer 400 `parameter_invalid`.
- **Sorting:** `updated_at` descending by default, with the id as tiebreaker.
- **Cursors:** opaque base64, 20 per page by default.

### Webhooks

The mock sends webhooks for these events:

| Event | Topic |
| --- | --- |
| Admin comment or quick reply (API or `POST /__admin/conversations/:id/admin-reply`) | `conversation.admin.replied` |
| Close (`/parts` or `POST /__admin/conversations/:id/close`) | `conversation.admin.closed` |
| Open (`/parts` or `POST /__admin/conversations/:id/open`) | `conversation.admin.opened` |
| Admin-initiated conversation (`POST /__admin/conversations`) | `conversation.admin.single.created` |

Snooze and assignment publish `conversation.admin.snoozed` and `.assigned`, but the default
endpoints do not subscribe to them. Member messages and notes send nothing: the EMR treats every
`notification_event` it receives as an admin event, so a real subscription must not include
member topics either.

Each delivery is a JSON body posted with `X-Hub-Signature: sha1=<hex HMAC-SHA1(secret, rawBody)>`:

```json
{ "type": "notification_event", "app_id": "mockapp", "topic": "conversation.admin.replied",
  "id": "notif_…", "created_at": 1760000000, "delivery_status": "pending", "delivery_attempts": 1,
  "data": { "type": "notification_event_data", "item": { "type": "conversation", "id": "…",
    "source": { "delivered_as": "customer_initiated", "author": { "email": "…" }, "body": "…" },
    "contacts": { "contacts": [{ "id": "…", "external_id": "1652" }] },
    "conversation_parts": { "conversation_parts": [ { "id": "…", "part_type": "comment", "body": "<p>…</p>", "created_at": 1760000000 } ] } } } }
```

- **Only the new part.** `item.conversation_parts` holds just the part that caused the event,
  as in Intercom's own payloads.
- **Wall-clock timestamps.** The part's timestamps and the envelope's `created_at` use real
  time, never the mock clock, because the EMR rejects parts more than 5 minutes old against its
  own clock.
- **Stable id.** The notification `id` stays the same on retries and on `webhook_duplicate`, so
  the backend's `delivery_id ?? id` dedupe and the EMR's processed-marker dedupe both hold.
- **Retries.** A non-2xx answer is retried after 5 s, 5 min, 30 min and 2 h.
- **Admin plane.** `GET /__admin/webhooks`, `…/events`, `…/flush`, `…/:id/replay` and
  `PUT /__admin/webhook-endpoints` are the standard webhook admin routes.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `POST /__admin/conversations/:id/admin-reply` | `{adminId? (default: first admin), body, messageType?: "comment" \| "note"}` appends an admin part and fires the webhook. |
| `POST /__admin/conversations/:id/close`, `…/open` | `{adminId?}` closes or reopens as an admin and fires the webhook. |
| `POST /__admin/conversations` | `{contactId \| externalId, adminId?, body}` creates an admin-initiated conversation. The EMR then looks the member up by `contacts[0].external_id`. |
| `GET /__admin/conversations`, `GET /__admin/contacts` | The namespace's records. |
| `PUT /__admin/admins` | Replace the admins: `[{id, name, email}]`. |
| `GET/PUT /__admin/settings` | `{tokens?: string[], customAttributes?: string[] \| null}`. With `customAttributes` set, writing an undefined attribute is a 400, as in a real workspace. |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`):

| Preset | Effect |
| --- | --- |
| `rate_limited` | Every call answers 429 `rate_limit_exceeded`. The adapter maps it to 429. |
| `unauthorized` | Every call answers 401. |
| `server_error` | Every call answers 500. The adapter throws. |
| `service_unavailable` | Every call answers 503. The adapter throws. |
| `contact_stale_404` | The next conversation search answers 404. The adapter drops its cached contact id, re-resolves it and retries once. |
| `search_unavailable` | Search answers `conversations: null`. The admin inbox answers 503. |
| `repeated_cursor` | Search keeps answering the same `next.starting_after`. The admin inbox detects the loop and answers 503. |
| `webhook_duplicate` | Deliver the next webhook twice. |
| `webhook_reorder` | Swap the next two webhooks. |
| `webhook_drop` | Never deliver the next webhook. |

### Namespaces

- the `x-mockingbird-namespace` header;
- a `/ns/<name>` prefix on `INTERCOM_API_BASE_URL`;
- the access token: `PUT /__admin/credentials {"credentials": {"<INTERCOM_ACCESS_TOKEN>": "<namespace>"}}`.

The request journal records operation ids, statuses and contact, conversation and part ids. It
never records message bodies or contact details.

### Deliberately not modelled

- The member-app Messenger SDK and web widget (`@intercom/intercom-react-native`,
  `@intercom/messenger-js-sdk`). They talk to Intercom's own hosts over their own protocol. The
  web widget has no test-stage gate, so QA should block it.
- Attachment downloads: URLs are recorded but not served.
- Tags, notes, companies, segments, tickets, articles, data-attribute management, teams and
  SLAs. These appear only as empty lists where a payload has them.
- Rate-limit headers on normal responses. Only `rate_limited` sends them.
- Intercom's exact wording for the idempotency conflict, which is unverified: the mock answers
  409 `conflict`.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `IntercomAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `appendPart(…)`, `manage(…)`, `startAdminConversation(…)`, `conversations()`, `contacts()`, `conversationBody(…)`, `contactBody(…)`, `error(…)`, `state`. Options: `sqlite`, `now`, `wallClock`, `namespace`, `admins`, `settings`, `onWebhook`. |
| `IntercomError` | class | A vendor error (status, code, message) raised by the admin-facing methods. |
| `createRuntime` | function | The mock with the full service contract (health, admin, namespaces, credentials, presets, webhooks). Options: `webhooks: {urls, secret?, events?, retryDelaysMs?, fetch?}`, `admins`, `settings`, `clock`, `wallClock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `INTERCOM_PRESETS` | object | Every named fault preset. |
| `INTERCOM_NAMESPACE` | string | The service name, `"intercom"`. |
| `INTERCOM_TOPICS` | array | Every webhook topic the mock can send. |
| `HUB_SIGNATURE_HEADER`, `signHub` | values | `X-Hub-Signature` and the `sha1=<hex>` signer, for your own receivers. |
| `DEFAULT_ADMINS`, `DEFAULT_SETTINGS` | values | The seeded admins and default settings. |
| `toHtml`, `toPlaintext`, `encodeCursor`, `decodeCursor` | functions | Body rendering and the search cursor format. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target (`--webhook-url`, `--emr-webhook-url`, `--webhook-secret`, `--access-token`); port 8807. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
