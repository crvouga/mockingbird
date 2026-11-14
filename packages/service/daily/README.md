# @crvouga/mockingbird-service-daily

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful emulator of the **Daily.co** REST API for test suites: rooms (create, get, update,
delete, presence, eject), meeting tokens (mint and validate), meetings (list and get),
verification of the HS256 meeting
tokens our backend signs itself, and the end-of-call webhooks (`transcription.stopped` or Daily's
`transcript.ready-to-download` / `transcript.error`, and `recording.ready-to-download`) with the
transcript written to the stack's S3. Every EMR
booking creates a room and a token; today a broken Daily integration is silent because booking
swallows the error. Against the emulator it is observable and assertable.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/daily/SUPPORT.md)
- The contract (`openapi.yaml`) is trimmed from Daily's documented REST API to the calls our
  backend and EMR make, with the fields they send.

## Install

```bash
npm install -D @crvouga/mockingbird-service-daily
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-daily serve`, `createServer` from `./server` (Node), or `createRuntime` with
any Fetch server.

## Usage

Point the apps at the emulator (the G-D1 seams):

| App | Env | Value |
| --- | --- | --- |
| backend | `DAILY_API_BASE_URL` | `http://127.0.0.1:8800/v1` (needs the http-loopback exception) |
| backend | `DAILY_API_KEY`, `DAILY_API_DOMAIN_ID` | any key (or `--api-key`), and the same value as `--domain-id` |
| EMR backend | `DailyService.baseUrl` | `http://127.0.0.1:8800/v1` (hardcoded today) |
| EMR backend | `DEFAULT_DAILY_BASE_URL` | the same value as `--room-url-base` |
| EMR backend | `DAILY_WEBHOOK_SECRET` | the same value as `--webhook-secret` |
| member-app | `EXPO_PUBLIC_DAILY_BASE_URL` | the same value as `--room-url-base` |

```bash
npx mockingbird-daily serve --port 8800 \
  --room-url-base https://acme-mock.daily.test/ \
  --domain-id "$DAILY_API_DOMAIN_ID" \
  --webhook-url http://127.0.0.1:4000/v1/webhooks/daily \
  --webhook-secret "$DAILY_WEBHOOK_SECRET" \
  --s3-endpoint http://127.0.0.1:4569 --s3-bucket "$S3_BUCKET_NAME"
```

```ts
import { createServer } from "@crvouga/mockingbird-service-daily/server"

// Test setup: the emulator, its webhook receiver and the S3 bucket transcripts land in.
const server = await createServer({
  settings: { roomUrlBase: "https://acme-mock.daily.test/" },
  webhooks: { url: "http://127.0.0.1:4000/v1/webhooks/daily", secret: "whsec-daily" },
  transcripts: { endpoint: "http://127.0.0.1:4569", bucket: "emr-transcripts" },
})

// Application code: DAILY_API_BASE_URL is `${server.url}/v1`. The EMR books an appointment.
const baseUrl = `${server.url}/v1`
const headers = { authorization: "Bearer daily-api-key", "content-type": "application/json" }
const created = await fetch(`${baseUrl}/rooms`, {
  method: "POST",
  headers,
  body: JSON.stringify({ privacy: "private" }),
})
const room = (await created.json()) as { name: string; url: string }
const minted = await fetch(`${baseUrl}/meeting-tokens`, {
  method: "POST",
  headers,
  body: JSON.stringify({ properties: { room_name: room.name, user_id: "prac-1", is_owner: true } }),
})
const { token } = (await minted.json()) as { token: string }

// Test control: end the call. Writes <room>/<session>.json to S3, then fires transcription.stopped.
await fetch(`${server.url}/__admin/rooms/${room.name}/session`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    participants: [{ userId: "prac-1" }, { userId: "pat-1" }],
    durationSec: 1200,
    transcript: [{ s: "prac-1", t: "How are you feeling?", ts: 0.5, te: 2.1 }],
  }),
})
await server.close()
```

### Browser call-object stand-in

Import `createCallObject` from `@crvouga/mockingbird-service-daily/browser` and
inject it as the application's Daily factory:

```ts
import { createCallObject } from "@crvouga/mockingbird-service-daily/browser"

// Supply a room URL and meeting token created by the emulator REST API.
async function previewCall(roomUrl: string, token: string) {
  const call = createCallObject({
    baseUrl: "http://localhost:8800",
    // Optional: fetch: request => runtime.fetch(request), for a worker transport.
  })
  call.on("participant-joined", ({ participant }) => console.log(participant))
  await call.join({ url: roomUrl, token })
  await call.setLocalVideo(false)
  await call.leave()
  await call.destroy()
}
```

This is a **best guess, not oracle-verified**, based on Daily's
[lifecycle events](https://docs.daily.co/reference/daily-js/events/lifecycle-events)
and [participants](https://docs.daily.co/reference/daily-js/instance-methods/participants)
reference. It implements `join`, `leave`, `destroy`, `on`, `off`, `meetingState`,
`participants`, `setLocalAudio`, and `setLocalVideo`; inject the factory in place of
Daily's factory. It does not intercept an already-created daily-js call or load the CDN.
Signed joins require `settings.apiKeys` to contain the key used to mint the meeting token.
`headers` carries namespace and admin authentication headers; this is a test-only admin
transport and must not be exposed as a production authorization boundary.

Presence shares room state, namespaces, snapshots and reset with the REST API. Peers
poll every 100 ms (`pollIntervalMs` overrides it); `refresh()` lets tests advance
observation explicitly. A removed participant or deleted room emits `left-meeting`.
`getUserMedia` obtains local tracks; inject it for deterministic permission/media tests.
Permission refusal emits `camera-error`. Remote tracks report `loading` until disabled
(`off`); remote audio/video transport and placeholder media are not implemented.
The error labels and polling timing are emulator choices, not verified Daily wire parity.
The complete DailyCall interface and unmodified SDK/Chromium compatibility are not claimed.

Synthetic peers use `POST /__admin/rooms/:name/participants` with
`{user_name, owner?, video?, audio?}`. List with `GET` on that route, and update or
remove a session using `PATCH` (`{video?, audio?}`) or `DELETE` on
`/__admin/rooms/:name/participants/:id`. Joins and leaves through these routes emit
`participant.joined` / `participant.left`, plus `meeting.started` / `meeting.ended`
when entering an empty room or removing its last participant.

### Routes

| Route | Behaviour |
| --- | --- |
| `GET /v1/rooms` | `{total_count, data}` in newest-first creation order; `limit` (default 100), `ending_before` and `starting_after` use room IDs. Shares state with room creation, updates and deletion. |
| `POST /v1/rooms` | `{name?, privacy?, properties?}`; unknown properties, bad types and a duplicate `name` are 400 `{error: "invalid-request-error", info}`. No name → a random 20-character one. Answers `{id, name, api_created, privacy, url: <roomUrlBase><name>, created_at, config}` with `config` echoing the properties. Accepts both the backend's strict body and the EMR's `generateRoomConfig` body. |
| `GET /v1/rooms/:name` | The room, or 404 `{error: "not-found", info: "room <name> not found"}` (the EMR branches on `message.includes('404')`). |
| `POST /v1/rooms/:name` | Merge `properties` (and `privacy`) into the room; 404 when missing. |
| `DELETE /v1/rooms/:name` | `{deleted: true, name}`; 404 when missing (the EMR tolerates it). |
| `GET /v1/rooms/:name/presence` | `{total_count, data: [{room, id, userId, userName, joinTime, duration}]}` — exactly the backend's strict schema. Participants come from `PUT /__admin/rooms/:name/presence`. |
| `POST /v1/rooms/:name/eject` | `{user_ids?, ids?}` → `{ejectedIds}` (participant session ids), removing them from presence. |
| `POST /v1/meeting-tokens` | `{properties}` → `{token}`: an HS256 JWT signed with the caller's API key, claims under Daily's abbreviations (`r`, `d`, `o`, `u`, `ud`, `nbf`, `exp`, `ejt`, `eje`, `er`, `erui`, `sr`, `ast`, `p`, …) plus `iat`. |
| `GET /v1/meetings` | `{total_count, data: [{id, room, start_time, duration, ongoing, max_participants, participants: [{user_id, participant_id, user_name, join_time, duration}]}]}`, newest first, from the sessions ended with `POST /__admin/rooms/:name/session` (the meeting `id` is the session id). `room` (repeatable), `timeframe_start` / `timeframe_end` (unix seconds, on `start_time`), `limit` (default 100), `starting_after` / `ending_before` (meeting ids), `ongoing=true` (always empty: emulated meetings have ended) and `no_participants=true` (drops `participants`). Every participant is in for the whole session. **Best guess** from Daily's reference, not oracle-verified. |
| `GET /v1/meetings/:meeting` | `{id, room, start_time, duration, ongoing, max_participants}`, else 404 `not-found`. |
| `GET /v1/meeting-tokens/:token` | Verifies a token (minted by the emulator **or self-signed by our backend**) with the caller's API key and its `nbf`/`exp` on the emulator clock (`?ignoreNbf=true` skips nbf); answers its properties under full names, else 400. |

**Auth.** `Authorization: Bearer <DAILY_API_KEY>`; any key unless `apiKeys` is set. Missing →
401 `{error: "authentication-error"}`.

**Milliseconds.** Some of our callers pass `nbf`/`exp` in milliseconds (e.g. the EMR's
`generatePatientToken` passes `Date.parse(end)`). The emulator accepts them, interprets values
≥ 1e11 as ms in time checks, records each in `GET /__admin/warnings`, and tags the journal entry
(`ids.warning: "exp in milliseconds"`).

### Webhooks

Admin sessions post Daily-shaped events: `{version: "1.0.0", type, event, id, event_ts,
payload}` (our receiver reads `event`; Daily documents `type`; both are sent).

- `transcription.stopped` — `payload: {room_name, session_id, duration, s3_key, instance_id}`.
- `recording.ready-to-download` — `payload: {type: "cloud", recording_id, room_name, session_id,
  start_ts, status: "finished", max_participants, duration, s3_key}` (our EMR just acks it).

**Daily's transcript storage** (`transcriptFormat: "vtt"` on `createRuntime`, `--transcript-format
vtt`, or per session in the admin body). The session writes WebVTT (`text/vtt`) at
`{domain}/{roomName}/{epochMs}.vtt` — `domain` is the first label of `roomUrlBase`, `epochMs` the
session start — with one numbered cue per entry and the speaker as a voice span (`<v prac-1>How
are you feeling?`), and emits, in place of `transcription.stopped`:

- `transcript.ready-to-download` (envelope `version: "1.1.0"`) — `payload: {id, room_id,
  room_name, mtg_session_id, duration, participant_minutes, status: "t_finished", domain_id,
  out_params: {s3: {key, bucket, region}}}`.
- `transcript.error` instead, with no file written, when the session body has `transcriptError:
  "<message>"` — `payload: {…, info: {instanceId, startTs, endTs}, max_participants, status:
  "t_error", error}`.

The payloads follow Daily's event reference
([ready-to-download](https://docs.daily.co/reference/rest-api/webhooks/events/transcript-ready-to-download),
[error](https://docs.daily.co/reference/rest-api/webhooks/events/transcript-error)). Daily does not
document the object key rule or its cue layout: the `<domain>/<room>/<13-digit>.vtt` keys in its
examples and the voice spans are a **best guess, not oracle-verified**.

`POST /__admin/events {type, payload?, version?}` posts any other Daily event (`meeting.started`,
`participant.joined`, …) with the same envelope and signature.

**Signature.** By default (`signature: "hex"`) `x-webhook-signature` = **hex**
HMAC-SHA256(`DAILY_WEBHOOK_SECRET`, raw body), which is what our EMR verifies (only when the
secret is set). `webhooks: {signature: "daily"}` (`--webhook-signature daily`) signs with
[Daily's documented scheme](https://docs.daily.co/reference/rest-api/webhooks): base64
HMAC-SHA256 over `"<X-Webhook-Timestamp>.<raw body>"`, keyed by the base64-decoded secret (pass
the base64 `hmac` Daily would hand out). Daily does not state the timestamp unit; the emulator
sends unix seconds (a best guess). `x-webhook-timestamp` is sent with both.
Retries: immediately, 5 s, 5 min, 30 min, 2 h (`retryDelaysMs: []` means one attempt, no
retries); `GET /__admin/webhooks`, `…/events`, `…/replay`, `…/flush` as usual.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `POST /__admin/rooms/:name/session` | `{participants: [{userId, userName?}], durationSec, transcript?: [{s, t, ts, te}], sessionId?, recording?, transcriptFormat?: "json" \| "vtt", transcriptError?}` writes the transcript JSON to S3 at `{roomName}/{sessionId}.json` (SigV4 `PutObject` to the `--s3-endpoint` / `transcripts` target; a synthetic transcript alternating between participants when none is given), clears presence, then emits `transcription.stopped` (and `recording.ready-to-download` unless `recording: false`); the `vtt` format follows Daily's transcript storage (see Webhooks). The session is listed by `GET /v1/meetings`. Answers `{sessionId, s3Key, transcript: "s3://…" \| null, events}`; 502 when S3 refuses. The transcript text is never kept. |
| `POST /__admin/events` | `{type, payload?, version?}` posts that Daily webhook event; answers the event. |
| `PUT /__admin/rooms/:name/presence` | `{participants: [{userId, userName?, joinedAt?}]}` — who `GET …/presence` reports. |
| `POST /__admin/tokens/decode` | `{token, apiKey?}` → `{decodable, header, claims, properties, signatureValid, room, joinable, problems, warnings}`: signature (against `apiKey` or `apiKeys`), the backend's strict claim set, `ud` ≤ 36, domain id, ms timestamps, and the token and room `nbf`/`exp` windows on the emulator clock (owners may enter before the room's `nbf`). |
| `GET /__admin/rooms`, `GET /__admin/rooms/:name` | Rooms with config, presence and session metadata. |
| `GET /__admin/warnings` | Tolerated oddities (millisecond timestamps, tokens for rooms that do not exist). |
| `PUT /__admin/settings` | `{apiKeys?, domainId?, roomUrlBase?}` for the calling namespace (`GET` masks keys). |

Time rules run on the emulator clock (`POST /__admin/clock`): token/room `nbf` and `exp`, and
therefore the backend's 13 h room-creation delay and 30-min guardrail window as seen by Daily.

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`): `room_not_found`
(404 on `/v1/rooms/:name…`), `unauthorized` (401), `rate_limited` (429), `server_error` (500),
`webhook_duplicate`, `webhook_reorder`, `webhook_drop`.

### Namespaces

`x-mockingbird-namespace`, a `/__admin/ns/<name>` prefix on the base URL, or by API key:
`PUT /__admin/credentials {"credentials": {"<DAILY_API_KEY>": "<namespace>"}}`.

### Deliberately not modelled

- The media plane: SFU, WebRTC, knocking/admission, recording and transcription themselves.
  daily-js loads Daily's CDN bundle; inject the browser stand-in factory described above
  for the supported call lifecycle subset.
- The room page at `https://<domain>.daily.co/<room>?t=` (the URL is produced, not served).
- Daily's webhook registration API (`/v1/webhooks`): receivers are configured on the emulator.
- Ongoing meetings in `GET /v1/meetings` and `GET /v1/meetings/:meeting/participants`.
- Recordings/transcripts REST APIs, dial-out, streaming.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `DailyAPI` | class | The in-process emulator: `fetch(request)`, `reset()`, `inspectToken(token, keys?)`, `setPresence(name, participants)`, `endSession(name, input)`, `emit(type, payload, version?)`, `rooms()`. Options: `sqlite`, `now`, `namespace`, `settings`, `onWebhook`, `transcripts`, `transcriptFormat`. |
| `createRuntime` | function | The emulator with the full service contract. Options: `webhooks: {url, secret, signature?: "hex" \| "daily", retryDelaysMs?, fetch?}`, `transcripts: {endpoint, bucket, region?, accessKeyId?, secretAccessKey?, keyPattern?, fetch?}`, `transcriptFormat?: "json" \| "vtt"`, `settings`, `clock`, `seed`, `adminKey`, `onLog`. |
| `DAILY_PRESETS` | object | Every named fault preset. |
| `DAILY_NAMESPACE` | string | The service name, `"daily"`. |
| `WEBHOOK_PATH` | string | `"/v1/webhooks/daily"`, our EMR receiver's route. |
| `dailyWebhookSigner` | function | The default `x-webhook-signature` signer (hex HMAC-SHA256 of the raw body). |
| `dailyDocumentedWebhookSigner` | function | Daily's documented signer (base64 HMAC-SHA256 of `"<ts>.<body>"`, base64 secret). |
| `transcriptToVtt` | function | A `[{s, t, ts, te}]` transcript as the WebVTT the `vtt` format writes. |
| `signToken`, `decodeToken`, `verifySignature` | functions | HS256 meeting-token helpers. |
| `claimsToProperties`, `propertiesToClaims`, `CLAIM_NAMES` | values | Daily's abbreviated claim names ↔ full property names. |
| `synthesizeTranscript` | function | The default transcript for a session with none given. |
| `document`, `operationIds`, `supportedOperationIds` | values | The vendored OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target; port 8800. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).

For a one-shot join failure, `POST /__admin/call-fault {type}` accepts `ejected`,
`exp-token`, `no-room`, `exp-room`, `nbf-room`, or `room-full`. The next browser join
in that namespace consumes it without adding a participant.
