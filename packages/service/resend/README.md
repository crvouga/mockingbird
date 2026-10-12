# @crvouga/mockingbird-service-resend

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful emulator of the **Resend** email API for test suites. Every send lands in an **outbox**
that tests read (`GET /__admin/outbox`, and the links in each email). `Idempotency-Key` replays
return the first send's id. Inbound emails are stored and announced with a Svix-signed
`email.received` webhook, and the received-email endpoints serve their content and
attachments. With `--forward-to-inbox`, every sent email is also copied into the
[Mailosaur emulator](../mailosaur), so one inbox holds every code and link.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/resend/SUPPORT.md)
- `openapi.yaml` is trimmed from Resend's published API reference to what `resend@4.8.0` and
  our backend call.

## Install

```bash
npm install -D @crvouga/mockingbird-service-resend
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-resend serve`, `createServer` from `./server` (Node), or `createRuntime` with
any Fetch server.

## Usage

`resend@4.x` reads `RESEND_BASE_URL` **once, when the module is first imported**, so set it in
the app's environment (or before the first `import("resend")` in a test). Set the app's
`RESEND_INBOUND_WEBHOOK_SECRET` and pass the same `whsec_…` value as `--webhook-secret`.

```bash
npx mockingbird-resend serve --port 8794 \
  --webhook-url http://127.0.0.1:3000/messaging/inbound/email \
  --webhook-secret "$RESEND_INBOUND_WEBHOOK_SECRET" \
  --forward-to-inbox http://127.0.0.1:8793
RESEND_BASE_URL=http://127.0.0.1:8794 node app.js
```

```ts
import { createServer } from "@crvouga/mockingbird-service-resend/server"

// Test setup: the emulator, and the base URL the Resend SDK reads at import.
const emulator = await createServer()
process.env.RESEND_BASE_URL = emulator.url
const { Resend } = await import("resend")

// The app's own Resend call.
await new Resend("re_test").emails.send({
  from: "Acme <no-reply@acme.example>",
  to: ["invitee@example.com"],
  subject: "You're invited",
  html: '<a href="https://app.test/family/invitations/claim?token=abc">Join</a>',
})

// The test reads the mail back from the outbox.
const { messages } = await (await fetch(`${emulator.url}/__admin/outbox?to=invitee@example.com`)).json()
const { links } = await (await fetch(`${emulator.url}/__admin/outbox/${messages[0].id}/links`)).json()
// links[0] === "https://app.test/family/invitations/claim?token=abc"
await emulator.close()
```

The outbox is the assertion surface for every send. An `idempotencyKey` replay returns the first
send's id and leaves one message in it:

```ts
import { createServer } from "@crvouga/mockingbird-service-resend/server"

const emulator = await createServer()
process.env.RESEND_BASE_URL = emulator.url
const { Resend } = await import("resend")

const resend = new Resend("re_test")
const email = { from: "no-reply@example.com", to: ["invitee@example.com"], subject: "Hi", text: "Hello" }
const first = await resend.emails.send(email, { idempotencyKey: "invite-1" })
const retry = await resend.emails.send(email, { idempotencyKey: "invite-1" })
// retry.data?.id === first.data?.id

const sent = await (await fetch(`${emulator.url}/__admin/outbox?to=invitee@example.com`)).json()
// sent.messages.length === 1
await emulator.close()
```

### Routes

| Route | Behaviour |
| --- | --- |
| `POST /emails` | `{from, to, subject, html?, text?, cc?, bcc?, reply_to?, headers?, tags?, attachments?, scheduled_at?}` → `{id}` (a UUID). The SDK renders `react` to HTML before sending, so the emulator sees HTML. Violations answer Resend's body `{statusCode, name, message}`: 422 `missing_required_field` (`Missing \`to\` field.`, or no `html`/`text`), 422 `validation_error` for a malformed address (`Invalid \`from\` field. The email address needs to follow …`), a tag outside `[A-Za-z0-9_-]`, or any other contract violation. `Idempotency-Key`: the same key and payload replay the first 200 byte for byte (`idempotent-replayed: true`); another payload is 409 `invalid_idempotent_request`; a key still in flight is 409 `concurrent_idempotent_requests`; a key outside 1–256 characters is 400 `invalid_idempotency_key`. Only 200s are remembered. |
| `GET /emails/{id}` | `emails.get`: `{object: "email", id, to, from, created_at, subject, html, text, cc, bcc, reply_to, last_event: "delivered" \| "scheduled", scheduled_at, headers, tags}`. `headers` keeps the names and values from the send; `to` keeps the original address form and order. |
| `GET /emails` | Newest-first sent email metadata, `{object: "list", has_more, data}`. `limit` defaults to 20 (1–100); `after`/`before` use email IDs and exclude the cursor. Content is available from the detail endpoint. |
| `GET /emails/receiving` | Newest-first received email metadata with the same envelope and ID cursors. Without `limit`, returns every received email; an explicit limit must be 1–100. Includes attachment metadata and size. |
| `GET /emails/receiving/{id}` | A received email: `{object: "email", id, to, from, cc, bcc, reply_to, created_at, subject, html, text, headers, message_id, attachments[{id, filename, content_type, content_disposition, content_id}]}`. |
| `GET /emails/receiving/{id}/attachments` | `{object: "list", has_more: false, data: [{id, filename, content_type, content_disposition, content_id, size, download_url, expires_at}]}`. |
| `GET /downloads/inbound/{attachment_id}` | The `download_url`: unauthenticated, the bytes with `content-type` and `content-length`. In a non-default namespace the URL carries `/__admin/ns/<name>`. |

Auth is `Authorization: Bearer <key>`; any key works; none is 401 `missing_api_key`.

**SDK error mapping.** `resend@4.8.0` never throws: a non-2xx JSON body comes back verbatim as
`{data: null, error: {statusCode, name, message}}`; a non-JSON body becomes
`{name: "application_error", message: "Internal server error. …"}`; a dropped connection
becomes `{name: "application_error", message: "Unable to fetch data. The request could not be resolved."}`.
`resend@2.1.0` also reads `RESEND_BASE_URL` at import and returns that JSON error object, but its
client does not catch a non-JSON body or a dropped socket (those reject). It also has no
`idempotencyKey` option; send the `Idempotency-Key` header yourself, as `resend@4.8.0` does.

### Webhooks

`POST /__admin/inbound` stores the email, then posts to every endpoint:

```json
{"type": "email.received", "created_at": "…",
 "data": {"email_id": "…", "created_at": "…", "from": "…", "to": ["care+tok@care.example"], "cc": [], "bcc": [],
          "subject": "…", "message_id": "<…>", "attachments": [{"id", "filename", "content_type", "content_disposition", "content_id"}]}}
```

Like Resend's, the body carries no `text`, `html`, `headers` or download URLs, so a receiver
hydrates them through the received-email routes. Pass `"inline": true` to include them. Each
delivery is signed the Svix way: `svix-id`, `svix-timestamp` (wall clock, even when the emulator
clock moves), `svix-signature: v1,<base64 HMAC-SHA256(secret bytes, "id.ts.body")>`. The
official `svix` `Webhook.verify` accepts them. Non-2xx answers are retried (immediately, 5 s,
5 min, 30 min, 2 h). `GET /__admin/webhooks`, `…/events`, `…/flush`, `…/:id/replay` and
`PUT /__admin/webhook-endpoints` (per-namespace receivers) come with the contract.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `GET /__admin/outcomes` | `{accepted, lost, replayed}` for sends whose response was dropped after acceptance, those lost responses, and idempotent replays. |
| `GET /__admin/outbox?to=&tag=<name>:<value>&since=&limit=` | Sent emails, oldest first: `{id, from, to (bare, lower-cased), toHeader, cc, bcc, replyTo, subject, html, text, tags, headers, attachments (filename, contentType, size), idempotencyKey, scheduledAt, createdAt}`. `tag=category` matches any value. `GET /__admin/outbox/:id` returns one. |
| `GET /__admin/outbox/:id/links` | `{id, links}`: every `href` in the HTML, entity-decoded (every URL in the text when there is no HTML). |
| `POST /__admin/inbound` | `{from, to, cc?, bcc?, replyTo?, subject?, text?, html?, headers?, messageId?, attachments?: [{filename, content (base64), contentType?, contentId?, contentDisposition?}], inline?}` → 201 `{id, webhook, event}`. |
| `GET /__admin/inbound` | Received emails, oldest first. |
| `GET /__admin/forwarding` | `{target, forwarded, failed, lastError}` for `--forward-to-inbox`. |

`--forward-to-inbox <url>` copies every accepted send (not replays) to the Mailosaur emulator's
`POST /__admin/ingest`, under the **same namespace name**, and waits up to 2 s for it. A failing
inbox never fails the send; it is counted in `/__admin/forwarding`. Map the same key to the
same namespace on both emulators and a worker reads its forwarded mail through the Mailosaur SDK.

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`; `GET /__admin/faults/presets`):
`send_422` (`{statusCode: 422, name: "validation_error", message}`), `send_429`
(`rate_limit_exceeded` with `retry-after` and `ratelimit-*` headers), `send_500`
(`internal_server_error`), `non_json_500` (an HTML 500 page), `network_drop` (the connection
dies before acceptance, so nothing is stored), `accepted_then_network_drop` (the send is stored,
then the connection dies before any response bytes; the same key replays), `receiving_500` (the received-email routes answer 500),
`webhook_duplicate`, `webhook_reorder`, `webhook_drop`.

### Namespaces

`new Resend(key)` cannot add headers, so map API keys to namespaces:
`PUT /__admin/credentials {"credentials": {"<RESEND_API_KEY>": "<namespace>"}}`. Also
`x-mockingbird-namespace`, or a `/__admin/ns/<name>` prefix on `RESEND_BASE_URL`.

### Deliberately not modelled

- Delivery itself: no SMTP, bounces, complaints, opens or clicks, and no `email.sent` /
  `email.delivered` webhooks. `last_event` is `delivered` at once (`scheduled` with
  `scheduled_at`, which is stored but never fires).
- Batch send, templates, domains, API keys, audiences, contacts and broadcasts (our code calls none).
- Attachment `path` URLs are not fetched; sent attachments keep metadata only.
- Rate limits, except through `send_429`.
- The idempotency window: keys never expire (Resend keeps them 24 h).

## API

| Export | Kind | Description |
| --- | --- | --- |
| `ResendAPI` | class | The in-process emulator: `fetch(request)`, `reset()`, `sent()`, `sendOutcomes()`, `inbound()`, `receive(input, origin)`, `state`. Options: `sqlite`, `now`, `namespace`, `publicNamespace`, `onSent`, `onOutcome`. |
| `createRuntime` | function | The emulator with the full service contract (health, admin, namespaces, credentials, presets, Svix webhooks, outbox). Options: `webhooks: {url, secret, retryDelaysMs?, fetch?}`, `forwardToInbox: {url, adminKey?, timeoutMs?, fetch?}`, `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `forwardToInbox` | function | Copy one sent email into a Mailosaur emulator's ingest route. |
| `RESEND_PRESETS` | object | Every named fault preset. |
| `RESEND_NAMESPACE` | string | The service name, `"resend"`. |
| `DOWNLOAD_URL_TTL_MS` | number | The advertised lifetime of a `download_url` (1 h). |
| `bareAddress` | function | `Name <a@b.co>` → `a@b.co` (how the outbox's `?to=` compares). |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target (`--webhook-url`, `--webhook-secret`, `--forward-to-inbox`); port 8794. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
