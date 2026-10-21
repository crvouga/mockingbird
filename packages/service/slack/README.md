# @crvouga/mockingbird-service-slack

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful emulator of **Slack** for test suites: incoming webhooks, the Web API methods our apps
call, and the Socket Mode control plane Bolt needs in order to boot, with an **outbox** of
everything the app "sent". A suite asserts that an alert fired
(`GET /__admin/outbox?webhook=…` or `?channel=…`) without a real workspace, and drives the
retry paths (429 with `retry-after`, 5xx) and the terminal ones (`no_text`, `no_service`,
`channel_not_found`) with named presets.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/slack/SUPPORT.md)
- Slack publishes no maintained OpenAPI for these methods: the contract (`openapi.yaml`) is
  hand-authored from Slack's documented wire shapes and our consumers.

## Install

```bash
npm install -D @crvouga/mockingbird-service-slack
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-slack serve`, `createServer` from `./server` (Node), or `createRuntime` with
any Fetch server.

## Usage

Point every `SLACK_*_WEBHOOK_URL` (`SLACK_PIPELINE_ALERT_WEBHOOK_URL`,
`SLACK_ERX_ALERTS_WEBHOOK_URL`, `SLACK_BILLING_ALERT_WEBHOOK_URL`,
`SLACK_CRITICAL_ALERT_WEBHOOK_URL`, `RECONCILER_SLACK_WEBHOOK_URL`, …) at
`http://127.0.0.1:8808/services/T000/B000/<anything>`. Any path is accepted until you register
hooks. The Web API callers hardcode `https://slack.com/api/…`; point them at
`http://127.0.0.1:8808/api/…` (for `@slack/web-api`, `slackApiUrl: "http://127.0.0.1:8808/api/"`).
Bolt in Socket Mode uses that same `clientOptions.slackApiUrl` (Bolt copies it into
`SocketModeReceiver`) plus an `xapp-` app token. `apps.connections.open` returns a `ws://` URL
on this process.

```bash
npx mockingbird-slack serve --port 8808
```

```ts
import { IncomingWebhook } from "@slack/webhook"
import { WebClient } from "@slack/web-api"
import { createServer } from "@crvouga/mockingbird-service-slack/server"

const server = await createServer()

// The app's own Slack clients. Only the URLs they are given change.
const webhook = new IncomingWebhook(`${server.url}/services/T000/B000/XXXX`)
await webhook.send({ text: "reconcile failed", blocks: [{ type: "divider" }] }) // { text: "ok" }
const slack = new WebClient("xoxb-fixture", { slackApiUrl: `${server.url}/api/` })
await slack.chat.postMessage({ channel: "#alerts", text: "deploy finished" }) // { ok: true, ts, … }

// Test controls. Make the next post fail the way Slack does under load; our clients retry at 0/2/8 s.
server.runtime.applyPreset("rate_limited", "default", { count: 1 })

const outbox = await fetch(`${server.url}/__admin/outbox?webhook=/services/T000/B000/XXXX`)
// { messages: [{ text: "reconcile failed", blocks: [...], ts: "1700000000.000001", thread_ts: null, … }] }
await server.close()
```

### Routes

| Route | Behaviour |
| --- | --- |
| `POST /services/{T}/{B}/{X}` | Incoming webhook. JSON `{text, blocks?, attachments?, thread_ts?}` (or form `payload=<json>`) → `200 ok` (text/plain). `400 invalid_payload` (not a JSON object), `400 no_text` (no text, blocks or attachments), `400 invalid_blocks` (structure and Block Kit limits, also inside `attachments[].blocks`; see below), `400 too_many_attachments`, `404 no_service` (unregistered hook, once any hook is registered), `404 channel_not_found`, `410 channel_is_archived`. |
| `POST /api/chat.postMessage` | `{channel, text?, blocks?, attachments?, thread_ts?, unfurl_links?}` → `{ok, channel, ts, message}`. `channel` is an id or `#name`; unknown channels are created on first use unless `strictChannels`. The outbox keeps `text`, `blocks`, `unfurl_links`, `thread_ts`, and `workspace` (the team id). Errors: `channel_not_found`, `no_text`, `invalid_blocks`, `invalid_blocks_format`, `msg_too_long`, `is_archived`. |
| `POST /api/chat.update` | `{channel, ts, text?, blocks?}` → `{ok, channel, ts, text, message}` with `edited`; `message_not_found`, `cant_update_message` (webhook posts). Omitted blocks are kept. |
| `POST /api/chat.postEphemeral` | `{channel, user, text}` → `{ok, message_ts}`; `user_not_found`. Recorded in the outbox with `ephemeral: true`. |
| `GET\|POST /api/chat.getPermalink` | `channel`, `message_ts` → `{ok, channel, permalink}` (`https://<domain>.slack.com/archives/C…/p…`); `message_not_found`. |
| `POST /api/reactions.add`, `/reactions.remove`, `GET\|POST /api/reactions.get` | Per message (`channel`, `timestamp`, `name`); `already_reacted`, `no_reaction`, `message_not_found`, `no_item_specified`. `reactions.get` answers `{ok, type: "message", channel, message}` with `reactions[{name, users, count}]`. |
| `GET\|POST /api/auth.test` | `{ok, url, team, user, team_id, user_id, bot_id}` from the workspace settings. |
| `POST /api/conversations.join` | `{ok, channel}`; already a member → `warning: "already_in_channel"`; `method_not_supported_for_channel_type` (private), `is_archived`. |
| `GET\|POST /api/users.info`, `/users.lookupByEmail` | `{ok, user}` with `profile.email`/`real_name`; `user_not_found`, `users_not_found`. Seeded: `U0ADA` (`ada@example.com`) and the bot. |
| `GET\|POST /api/files.info` | `{ok, file}` with `url_private_download` on `files.slack.com`; `file_not_found`. Seeded: `F0REPORT`. |
| `POST /api/views.open` | `{trigger_id, view}` → `{ok, view: {id: "V…", hash, state, …}}`; `invalid_arguments`. |
| `POST /api/apps.connections.open` | `Authorization: Bearer xapp-…` (header only) → `{ok, url}` where `url` is `ws://<this host>/link/?ticket=…&app_id=…`. One WebSocket per ticket; a second upgrade or a closed ticket is rejected. Missing token → `not_authed`; a bot token → `not_allowed_token_type`; malformed → `invalid_auth`; a token in `revokedAppTokens` → `token_revoked`; an app token that is not in this namespace's `appTokens` (when that list is non-empty) → `invalid_auth`. |
| WebSocket `/link/?ticket=` | On upgrade, one JSON `hello` (`type`, `connection_info.app_id`, `num_connections`, `debug_info.approximate_connection_time`). No events are pushed. Client pings are ponged; the server pings every 2s. `{envelope_id}` acks are accepted and not answered. `disconnect` reasons `warning`, `refresh_requested`, and `link_disabled` match Slack's envelope (no reconnect URL: `@slack/socket-mode@2.0.4` calls `apps.connections.open` again). |

Web API bodies may be JSON or form-encoded (structures JSON-encoded in form fields), as Slack
accepts both; read methods also take query arguments. Auth is `Authorization: Bearer xox…` (or a
`token` form field): missing → `not_authed`, anything but an `xoxb-`/`xoxp-`/`xoxa-` token (or
one outside `settings.tokens`) → `invalid_auth`. Logical errors are HTTP 200 `{ok: false, error}`;
a JSON post without `charset` succeeds with Slack's `missing_charset` warning.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `GET /__admin/outbox?webhook=<path>&channel=<id\|#name>&thread_ts=&source=webhook\|api&since=&limit=` | Every message sent, oldest first: `text`, `blocks`, `attachments`, `thread_ts`, `ts`, `channel`, `webhook`, `method`, `ephemeral`, `edited`, `reactions`, `unfurl_links`, `workspace`. `webhook` takes `/services/T/B/X`, `T/B/X` or a full URL. `GET /__admin/outbox/:id` reads one. |
| `POST /__admin/hooks` | `{path, channel?}` or `{hooks: [...]}`: register webhooks (and route them to a channel). Once any hook exists, unknown hooks answer `404 no_service`. `GET` lists, `DELETE [?path=]` removes. |
| `POST /__admin/channels`, `/users`, `/files` | Seed workspace records (`{id?, name, is_private?, is_archived?, is_member?}`, `{id, name?, real_name?, email?}`, `{id, name?, mimetype?, size?}`). `GET /__admin/channels`, `/users`, `/views` list them. |
| `PUT /__admin/settings` | `{teamId?, teamName?, teamDomain?, botUserId?, botId?, appId?, tokens?, appTokens?, revokedAppTokens?, socketLifetimeMs?, strictChannels?}` for the calling namespace. `socketLifetimeMs` closes an open Socket Mode connection with `reason: "warning"`. |
| `GET /__admin/socket/connections` | Open and closed Socket Mode sockets for the calling namespace: `namespace`, `appId`, `ticket`, `connectedAt`, `state`, `reconnectCount`. Never tokens. |
| `POST /__admin/socket/disconnect` | `{reason?: "warning"\|"refresh_requested"\|"link_disabled", code?: 1000}`. Sends Slack's `disconnect` envelope, then closes. `code: 1006` drops the TCP connection instead. |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n, "params"?: {...}}`):

| Preset | Effect |
| --- | --- |
| `rate_limited` | Webhooks `429 rate_limited`, Web API `429 {ok: false, error: "ratelimited"}`, both with `retry-after` (`params.retryAfter`, default 1 s). |
| `5xx` | `500 internal_error` everywhere (`params.status: 503` gives `service_unavailable`). |
| `service_unavailable` | `503 service_unavailable` everywhere. |
| `channel_not_found` | Webhooks `404 channel_not_found`; Web API channel methods `{ok: false, error: "channel_not_found"}`. |
| `no_service` | Webhooks `404 no_service` (a revoked hook). |
| `invalid_auth` | Web API `{ok: false, error: "invalid_auth"}` (a revoked token). |
| `connections_open_invalid_auth` | `apps.connections.open` answers `{ok:false, error:"invalid_auth"}` and mints no ticket. |
| `connections_open_429` | `apps.connections.open` answers `429 {ok:false, error:"ratelimited"}` with `retry-after` (`params.retryAfter`, default 1). |
| `connections_open_5xx` | `apps.connections.open` answers `500 internal_error` (`params.status: 503` gives `service_unavailable`). |
| `socket_close_after_hello` | The next Socket Mode socket sends `hello`, then a normal close. |
| `socket_abnormal_close` | The next Socket Mode socket sends `hello`, then drops the connection (code 1006). |
| `socket_hello_latency` | Delay `hello` by `params.latencyMs` milliseconds. The HTTP response itself is not delayed. |

### Namespaces

`x-mockingbird-namespace`, a `/__admin/ns/<name>` prefix on the webhook URL or API base, or by
credential: `PUT /__admin/credentials {"credentials": {"xoxb-worker-a": "a", "T000/B000/XXXX": "b"}}`
maps a bot token or a webhook's `T/B/X` path to a namespace.

### Deliberately not modelled

- Inbound Events API and interactivity delivery. Socket Mode's connection lifecycle is
  modelled (`apps.connections.open`, `hello`, ping/pong, `disconnect`) so Bolt can boot and
  shut down; the emulator does not push events on connect. A `disconnect` envelope has no
  reconnect URL, matching Slack's documented shape and `@slack/socket-mode@2.0.4`, which
  calls `apps.connections.open` again.
- File uploads and downloads: `files.info` answers seeded metadata; the `files.slack.com` URLs
  are not served.
- Real per-method rate-limit tiers: 429s come only from the `rate_limited` preset.
- Channel membership rules for posting (`not_in_channel`), `chat:write.public` scopes, and
  trigger-id expiry for `views.open`.
- Message formatting (mrkdwn parsing, link unfurling, mention resolution): text and blocks are
  stored verbatim.
- Block Kit limits are a **best guess, not oracle-verified** (from the per-block pages on
  docs.slack.dev; the exact status and message Slack returns for each rule was never observed
  live). `blocks` and each `attachments[].blocks` are rejected as `invalid_blocks` (webhook: `400
  invalid_blocks`; `chat.postMessage`, `chat.update`, `chat.postEphemeral`: `200 {ok: false, error:
  "invalid_blocks", response_metadata: {messages}}`, the messages being the emulator's own wording)
  when: there are more than 50 blocks (in each array; whether Slack applies 50 inside attachments is
  unconfirmed); a block's `type` is not a Block Kit block type; a `section` `text` is over 3000
  characters or its `fields` are over 10 items or 2000 characters each; a `header` `text` is not
  `plain_text` or is over 150 characters; `context` has over 10 `elements` or `actions` over 25; a
  `block_id` is over 255 characters; a text object is empty. Exactly-at-limit values are accepted
  and stored verbatim, and a rejected message stores nothing (an update leaves the original
  untouched). Required-field rules (a `section` with neither `text` nor `fields`, an `image`
  without `alt_text`), element-level validation inside `actions` / `context` / `input` / `rich_text`,
  and the other attachment fields are not modelled.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `SlackAPI` | class | The in-process emulator: `fetch(request)`, `reset()`, `messages()`, `state`. Options: `sqlite`, `now`, `namespace`, `settings`. |
| `createRuntime` | function | The emulator with the full service contract (health, admin, outbox, namespaces, credentials, presets). Options: `settings`, `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `SLACK_PRESETS` | object | Every named fault preset. |
| `SLACK_NAMESPACE` | string | The service name, `"slack"`. |
| `slackCredential` | function | The bearer token, or a webhook's `T/B/X` path (how credentials map to namespaces). |
| `DEFAULT_SETTINGS`, `DEFAULT_CHANNELS`, `DEFAULT_USERS`, `DEFAULT_FILES` | values | The seeded workspace. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target; port 8808. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
