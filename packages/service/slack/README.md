# @crvouga/mockingbird-service-slack

Stateful mock of **Slack** for test suites: incoming webhooks and the Web API methods our apps
call, with an **outbox** of everything the app "sent". A suite asserts that an alert fired
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

```bash
npx mockingbird-slack serve --port 8808
```

```ts
import { createRuntime } from "@crvouga/mockingbird-service-slack"

const slack = createRuntime()
await slack.fetch(
  new Request("http://slack.test/services/T000/B000/XXXX", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "reconcile failed", blocks: [{ type: "divider" }] }),
  }),
) // 200 "ok"

// Make the next post fail the way Slack does under load; our clients retry at 0/2/8 s.
slack.applyPreset("rate_limited", "default", { count: 1 })

const outbox = await slack.fetch(
  new Request("http://slack.test/__admin/outbox?webhook=/services/T000/B000/XXXX"),
)
// { messages: [{ text: "reconcile failed", blocks: [...], ts: "1700000000.000001", thread_ts: null, … }] }
```

### Routes

| Route | Behaviour |
| --- | --- |
| `POST /services/{T}/{B}/{X}` | Incoming webhook. JSON `{text, blocks?, attachments?, thread_ts?}` (or form `payload=<json>`) → `200 ok` (text/plain). `400 invalid_payload` (not a JSON object), `400 no_text` (no text, blocks or attachments), `400 invalid_blocks`, `400 too_many_attachments`, `404 no_service` (unregistered hook, once any hook is registered), `404 channel_not_found`, `410 channel_is_archived`. |
| `POST /api/chat.postMessage` | `{channel, text?, blocks?, attachments?, thread_ts?}` → `{ok, channel, ts, message}`. `channel` is an id or `#name`; unknown channels are created on first use unless `strictChannels`. Errors: `channel_not_found`, `no_text`, `invalid_blocks`, `invalid_blocks_format`, `msg_too_long`, `is_archived`. |
| `POST /api/chat.update` | `{channel, ts, text?, blocks?}` → `{ok, channel, ts, text, message}` with `edited`; `message_not_found`, `cant_update_message` (webhook posts). Omitted blocks are kept. |
| `POST /api/chat.postEphemeral` | `{channel, user, text}` → `{ok, message_ts}`; `user_not_found`. Recorded in the outbox with `ephemeral: true`. |
| `GET\|POST /api/chat.getPermalink` | `channel`, `message_ts` → `{ok, channel, permalink}` (`https://<domain>.slack.com/archives/C…/p…`); `message_not_found`. |
| `POST /api/reactions.add`, `/reactions.remove`, `GET\|POST /api/reactions.get` | Per message (`channel`, `timestamp`, `name`); `already_reacted`, `no_reaction`, `message_not_found`, `no_item_specified`. `reactions.get` answers `{ok, type: "message", channel, message}` with `reactions[{name, users, count}]`. |
| `GET\|POST /api/auth.test` | `{ok, url, team, user, team_id, user_id, bot_id}` from the workspace settings. |
| `POST /api/conversations.join` | `{ok, channel}`; already a member → `warning: "already_in_channel"`; `method_not_supported_for_channel_type` (private), `is_archived`. |
| `GET\|POST /api/users.info`, `/users.lookupByEmail` | `{ok, user}` with `profile.email`/`real_name`; `user_not_found`, `users_not_found`. Seeded: `U0ADA` (`ada@example.com`) and the bot. |
| `GET\|POST /api/files.info` | `{ok, file}` with `url_private_download` on `files.slack.com`; `file_not_found`. Seeded: `F0REPORT`. |
| `POST /api/views.open` | `{trigger_id, view}` → `{ok, view: {id: "V…", hash, state, …}}`; `invalid_arguments`. |

Web API bodies may be JSON or form-encoded (structures JSON-encoded in form fields), as Slack
accepts both; read methods also take query arguments. Auth is `Authorization: Bearer xox…` (or a
`token` form field): missing → `not_authed`, anything but an `xoxb-`/`xoxp-`/`xoxa-` token (or
one outside `settings.tokens`) → `invalid_auth`. Logical errors are HTTP 200 `{ok: false, error}`;
a JSON post without `charset` succeeds with Slack's `missing_charset` warning.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `GET /__admin/outbox?webhook=<path>&channel=<id\|#name>&thread_ts=&source=webhook\|api&since=&limit=` | Every message sent, oldest first: `text`, `blocks`, `attachments`, `thread_ts`, `ts`, `channel`, `webhook`, `method`, `ephemeral`, `edited`, `reactions`. `webhook` takes `/services/T/B/X`, `T/B/X` or a full URL. `GET /__admin/outbox/:id` reads one. |
| `POST /__admin/hooks` | `{path, channel?}` or `{hooks: [...]}`: register webhooks (and route them to a channel). Once any hook exists, unknown hooks answer `404 no_service`. `GET` lists, `DELETE [?path=]` removes. |
| `POST /__admin/channels`, `/users`, `/files` | Seed workspace records (`{id?, name, is_private?, is_archived?, is_member?}`, `{id, name?, real_name?, email?}`, `{id, name?, mimetype?, size?}`). `GET /__admin/channels`, `/users`, `/views` list them. |
| `PUT /__admin/settings` | `{teamId?, teamName?, teamDomain?, botUserId?, botId?, appId?, tokens?, strictChannels?}` for the calling namespace. |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n, "params"?: {...}}`):

| Preset | Effect |
| --- | --- |
| `rate_limited` | Webhooks `429 rate_limited`, Web API `429 {ok: false, error: "ratelimited"}`, both with `retry-after` (`params.retryAfter`, default 1 s). |
| `5xx` | `500 internal_error` everywhere (`params.status: 503` gives `service_unavailable`). |
| `service_unavailable` | `503 service_unavailable` everywhere. |
| `channel_not_found` | Webhooks `404 channel_not_found`; Web API channel methods `{ok: false, error: "channel_not_found"}`. |
| `no_service` | Webhooks `404 no_service` (a revoked hook). |
| `invalid_auth` | Web API `{ok: false, error: "invalid_auth"}` (a revoked token). |

### Namespaces

`x-mockingbird-namespace`, a `/ns/<name>` prefix on the webhook URL or API base, or by
credential: `PUT /__admin/credentials {"credentials": {"xoxb-worker-a": "a", "T000/B000/XXXX": "b"}}`
maps a bot token or a webhook's `T/B/X` path to a namespace.

### Deliberately not modelled

- Socket Mode, the Events API and interactivity payloads (Bolt in notification-service is not
  in the local stack).
- File uploads and downloads: `files.info` answers seeded metadata; the `files.slack.com` URLs
  are not served.
- Real per-method rate-limit tiers: 429s come only from the `rate_limited` preset.
- Channel membership rules for posting (`not_in_channel`), `chat:write.public` scopes, and
  trigger-id expiry for `views.open`.
- Message formatting (mrkdwn parsing, link unfurling, mention resolution): text and blocks are
  stored verbatim.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `SlackAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `messages()`, `state`. Options: `sqlite`, `now`, `namespace`, `settings`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, outbox, namespaces, credentials, presets). Options: `settings`, `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `SLACK_PRESETS` | object | Every named fault preset. |
| `SLACK_NAMESPACE` | string | The service name, `"slack"`. |
| `slackCredential` | function | The bearer token, or a webhook's `T/B/X` path (how credentials map to namespaces). |
| `DEFAULT_SETTINGS`, `DEFAULT_CHANNELS`, `DEFAULT_USERS`, `DEFAULT_FILES` | values | The seeded workspace. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target; port 8808. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
