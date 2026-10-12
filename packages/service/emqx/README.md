# @crvouga/mockingbird-service-emqx

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful emulator of an **EMQX 5** MQTT broker for test suites and local development: an MQTT 5
broker over TCP and WebSocket (`/mqtt`), EMQX's password and JWT authentication with JWT ACLs,
persistent sessions with offline QoS 1 queues, and the two REST v5 endpoints a publish-only
client needs (`POST /api/v5/publish`, `DELETE /api/v5/clients/{clientid}`). It runs in the test
process on OS-assigned ports, with no installed broker, Docker, or native binary, and session
expiry follows a clock the suite moves instead of waiting.

- Operation coverage (HTTP): [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/emqx/SUPPORT.md)
- No EMQX broker was available as an oracle, so behaviour follows the
  [MQTT 5.0 specification](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html), the
  [EMQX documentation](https://docs.emqx.com/en/emqx/latest/) and the EMQX 5.8.6 source. What
  those do not settle is listed under [Unverified](#unverified).

## Install

```bash
npm install -D @crvouga/mockingbird-service-emqx
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-emqx serve` or `createServer` from `./server` (Node and Bun). `createRuntime`
(the default entry) is portable: it serves the REST API over `fetch` and MQTT through
`runtime.attach`, with no listener.

## Usage

Point the app's MQTT URL at `mqttUrl` (or `wsUrl`), its EMQX API origin at `url`, and give it the
API key, MQTT user and JWT secret you configured here.

```ts
import { createServer } from "@crvouga/mockingbird-service-emqx/server"
import mqtt from "mqtt"

const emqx = await createServer({
  settings: {
    apiKeys: [{ key: "test-key", secret: "test-secret" }],
    users: [{ username: "service", password: "service-password", superuser: true }],
    jwt: { secret: "test-jwt-secret" }, // HS256 token in the CONNECT password
    authorization: { noMatch: "deny" },
  },
})
// emqx.url      http://127.0.0.1:<port>       REST API and /__admin
// emqx.mqttUrl  mqtt://127.0.0.1:<port>       MQTT 5 over TCP
// emqx.wsUrl    ws://127.0.0.1:<port>/mqtt    MQTT 5 over WebSocket

const client = await mqtt.connectAsync(emqx.mqttUrl, {
  protocolVersion: 5,
  clientId: "device-1",
  clean: false,
  properties: { sessionExpiryInterval: 600 },
  username: "service",
  password: "service-password",
})
await client.subscribeAsync("space:example", { qos: 1 })

// EMQX publishes no JavaScript SDK for its REST API, so the publisher calls it over HTTP.
await fetch(`${emqx.url}/api/v5/publish`, {
  method: "POST",
  headers: {
    authorization: `Basic ${btoa("test-key:test-secret")}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ topic: "space:example", payload: "hello", qos: 1, retain: false }),
})

// Test control: move time instead of waiting for a session to expire.
await fetch(`${emqx.url}/__admin/clock`, { method: "POST", body: '{"advance": "600s"}' })

await client.endAsync()
await emqx.close() // closes every listener and drops every client
```

```bash
npx mockingbird-emqx serve --port 8850 --mqtt-port 1883 \
  --api-key test-key:test-secret --mqtt-user service:service-password \
  --jwt-secret test-jwt-secret --no-match deny
```

Each `createServer()` is its own broker with its own ports; two of them share nothing. Under
Bun, `mqtt`'s Node WebSocket transport does not start (Bun's `ws` has no
`createWebSocketStream`), so connect to `wsUrl` with the library's browser transport
(`new MqttClient((c) => browserStreamBuilder(c, options), options)` from `mqtt/lib/connect/ws`),
or use `connectStream(runtime)` from `./server` for a socket-free connection. On Node the plain
`mqtt.connect("ws://…/mqtt")` works.

### MQTT

MQTT 5.0 over TCP and over WebSocket at `/mqtt` (subprotocol `mqtt`, also `mqtt-v3`,
`mqtt-v3.1.1`, `mqtt-v5`; an upgrade without one is answered `400`, as EMQX does with
`fail_if_no_subprotocol`). Both transports reach the same sessions.

| Packet | Behaviour |
| --- | --- |
| CONNECT / CONNACK | Clean Start and Session Expiry Interval as in the specification: `clean: false` resumes a stored session (`sessionPresent: true`), a clean start discards it. EMQX takes the client's interval as sent. The CONNACK carries Maximum Packet Size 1048576, Topic Alias Maximum 65535, Receive Maximum 32, Wildcard Subscription Available 1, Subscription Identifier Available 1, and what this emulator does not do: Maximum QoS 1, Retain Available 0, Shared Subscription Available 0. An empty client id is assigned 16 characters. |
| Authentication | EMQX's chain: the built-in database (`users`), then the JWT authenticator (`jwt`). With neither configured anyone connects, as on a fresh EMQX. A wrong password is CONNACK `0x86`; a token that verifies but is expired (`exp`), not yet valid (`nbf`), fails `verify_claims` or has a malformed `acl` is `0x86`; a token that does not verify, or credentials no authenticator recognises, is `0x87`. |
| Second CONNECT with a connected client id | The old connection gets DISCONNECT `0x8E` Session taken over; the new one resumes the session unless it asked for a clean start. |
| SUBSCRIBE / SUBACK | Exact filters and `+` / `#` wildcards, No Local, Subscription Identifiers. Granted QoS is at most 1. A denied filter is SUBACK `0x87`; `$share/…` is `0x9E`. |
| PUBLISH / PUBACK | QoS 0 and 1. PUBACK is `0x00`, `0x10` when nobody subscribes (EMQX's behaviour), or `0x87` when denied (the message is dropped; a denied QoS 0 publish is dropped silently). Properties (content type, response topic, correlation data, user properties, payload format indicator, message expiry interval) are forwarded. Inbound topic aliases work. |
| Offline | A session whose connection is gone keeps its subscriptions and queues messages (QoS 0 too, as `mqtt.mqueue_store_qos0`; at most 1000, oldest dropped, as `mqtt.max_mqueue_len`). Messages sent and not acknowledged are resent with DUP on resume. At most 32 QoS 1 messages are in flight (`mqtt.max_inflight`), fewer if the client's Receive Maximum is lower. |
| Session expiry | `Session Expiry Interval` seconds after the connection ends, on the emulator clock. `0` (or absent) ends the session with the connection. |
| JWT expiry | With `disconnectAfterExpire` (EMQX's default) a connected client is sent DISCONNECT `0x87` when its token's `exp` passes; with it off the connection stays and its ACL denies everything. |

**JWT ACL.** The token's `acl` claim (name configurable) is asked before anything else:

- Object form, `{"pub": [...], "sub": [...], "all": [...]}`: listed topics are allowed and
  everything else is denied.
- List form, `[{"permission": "allow" | "deny", "action": "pub" | "sub" | "all", "topic": "…",
  "qos"?: [0, 1], "retain"?: false}]`: the first matching rule decides; a topic no rule matches
  falls to `authorization.noMatch` (`allow` by default, as in EMQX 5; EMQX 6 changed its default
  to `deny`).

ACL topics are MQTT filters with `${clientid}` and `${username}` expanded; `eq <topic>` compares
literally. A requested filter is matched word by word as written, so the rule `a/+` covers a
subscription to `a/#` (EMQX's `emqx_topic:match/2`). A superuser from `users` skips
authorization. With `authorization.denyAction: "disconnect"` a denied operation ends the
connection with DISCONNECT `0x87` instead.

The emulator models what the broker does with a topic and nothing else: `space:example` is one
topic level. Mapping an application's logical names onto topics is the client's job.

### Routes

Every route needs `Authorization: Basic <api key>:<secret>`. With `apiKeys` empty any pair is
accepted; a missing header is always refused.

| Route | Behaviour |
| --- | --- |
| `POST /api/v5/publish` | JSON `{topic, payload, qos?: 0\|1\|2, retain?, payload_encoding?: "plain"\|"base64", properties?}`. `200 {"id": "<32 hex>"}` when at least one session matched (a session that is offline counts: the message is queued); `202 {"reason_code": 16, "message": "no_matching_subscribers"}` when none did. `400 {"code": "BAD_REQUEST", "message"}` for a body that fails the schema (missing `topic`, non-string `payload`, `qos` out of range, unknown field, invalid JSON); `400 {"reason_code": 144, "message": "topic_name_invalid"}` for an empty topic or one with wildcards; `400 {"reason_code": 151, "message": "packet_too_large"}` above 1 MB; `415` when the body is not `application/json`. QoS 2 is accepted and delivered at the subscription's granted QoS. |
| `DELETE /api/v5/clients/{clientid}` | Kicks the client out: a connected client gets DISCONNECT `0x98` Administrative action, and the session, its subscriptions and its queue are discarded (an offline session too). `204`, or `404 {"code": "CLIENTID_NOT_FOUND", "message": "Client ID not found"}`. |
| any, without credentials | `401 {"code": "AUTHORIZATION_HEADER_ERROR", "message": "Support authorization: basic/bearer "}`; a wrong key or secret is `401 {"code": "BAD_API_KEY_OR_SECRET", "message": "Check api_key/api_secret"}`; a bearer token is `401 BAD_TOKEN`. All carry `WWW-Authenticate: Basic Realm="emqx-dashboard"`. |

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `GET /__admin/clients` | Every session: `clientId`, `username`, `connected`, `transport`, `sessionExpiryInterval`, `connectedAt`, `disconnectedAt`, `expiresAt`, and counts of `subscriptions`, `queued` and `inflight` messages. |
| `GET /__admin/clients/:clientId` | One session, with its subscriptions under `topics`. |
| `GET /__admin/subscriptions?clientId=` | Subscriptions: `topicFilter`, granted `qos`, options. |
| `GET /__admin/publishes` | `{total, publishes}`: the last 1000 publishes as metadata (`topic`, `qos`, `bytes`, `source: "mqtt" \| "http" \| "admin"`, `clientId`, `matched`, `at`). Payloads are never kept. |
| `POST /__admin/inject` | `{topic, payload \| payloadBase64, qos?: 0 \| 1}`: deliver raw bytes to the topic's subscribers, bypassing the REST schema and every ACL. Use it to hand a consumer a payload its parser must refuse. Answers `{matched}`. |
| `POST /__admin/transport/cut` | `{clientId?}`: a network outage for one client, or for all. Live connections die with no DISCONNECT and new CONNECTs are dropped unanswered. Sessions are untouched and expire on their own schedule. |
| `POST /__admin/transport/restore` | `{clientId?}`: end the outage. `GET /__admin/transport` lists what is cut. |
| `POST /__admin/clients/:clientId/disconnect` | `{reasonCode?}`: send DISCONNECT (default `0x98`) and close. Unlike the vendor's kick, the session stays. |
| `GET` / `PUT /__admin/settings` | `{apiKeys?, users?, jwt?: {secret, from?, aclClaimName?, verifyClaims?, secretBase64Encoded?, disconnectAfterExpire?} \| null, authorization?: {noMatch?, denyAction?}}` for the calling namespace. Reset returns to the values the runtime was created with. |
| `POST /__admin/clock` | Standard. Moving the clock settles expiries at once: sessions past their interval are discarded and clients with an expired token are disconnected. |
| `POST /__admin/reset`, checkpoints | Standard. Reset drops every connection and session. Restoring a checkpoint restores sessions, subscriptions and queues, and drops live connections (a checkpoint cannot hold a socket). |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`; `GET /__admin/faults/presets`):
`connect_bad_credentials` (CONNACK `0x86`), `connect_not_authorized` (`0x87`),
`connect_server_unavailable` (`0x88`), `publish_unavailable` (REST publish answers `503
{"reason_code": 131, "message": "failed_to_dispatch"}`), `api_unauthorized` (every REST call
answers `401`). A CONNECT is the fault operation `MqttConnect`, so any reason code can be
forced: `{"operationId": "MqttConnect", "effect": "connack", "params": {"reasonCode": 151}}`.

### Namespaces

Parallel workers isolate themselves by namespace. HTTP: `x-mockingbird-namespace`, a
`/__admin/ns/<name>` prefix on the API origin, or by API key
(`PUT /__admin/credentials {"credentials": {"<api key>": "<namespace>"}}`). MQTT: the WebSocket
URL `ws://…/__admin/ns/<name>/mqtt`, or the same credential map keyed by the CONNECT's username,
then its client id. Unmapped clients use the default namespace.

### Unverified

Taken from the EMQX 5.8.6 source or left open, not observed on a broker:

- The `message` text of a schema `400` (EMQX prints its config library's error; the emulator
  prints `{"kind": "validation_error", "path": "root.<field>", "reason": …}`), of a bad base64
  payload, and of an unknown path's `404`.
- EMQX coerces an integer `payload` to its decimal string; the emulator refuses it.
- The CONNACK Receive Maximum is EMQX's `min(client's, 32)`; the emulator always sends 32.
- The `is_superuser` token claim is not read.

### Deliberately not modelled

- MQTT 3.1 and 3.1.1: such a CONNECT is refused with that protocol's return code 1.
- QoS 2: the CONNACK says Maximum QoS 1, a QoS 2 subscription is granted QoS 1, and a QoS 2
  publish is answered DISCONNECT `0x9B`. EMQX itself supports QoS 2.
- Retained messages: the CONNACK says Retain Available 0, a retained publish is answered
  DISCONNECT `0x9A`, and `retain: true` on the REST API is `400`.
- Will messages (accepted in CONNECT, never published), shared subscriptions, enhanced
  authentication (AUTH), keep-alive timeouts (PINGREQ is answered; use a transport cut for a dead
  connection), message expiry, and outbound topic aliases.
- Public-key and JWKS tokens, password hashing, and authenticators or authorizers other than the
  built-in database and JWT.
- Clustering, the dashboard and its login tokens, the rule engine, bridges, billing, TLS and
  listener configuration.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `createRuntime` | function | The emulator with the full service contract. Options: `settings`, `clock`, `seed`, `adminPrefix`, `adminKey`, `onLog`, `sqlite`. Adds `attach(transport, info?, namespace?)` for an MQTT connection, `webSocketPath(pathname)`, `endpoints`, and `stop()`. |
| `EmqxAPI` | class | One namespace's broker: `fetch(request)` for the REST API, `broker` for MQTT, `state`, `reset()`. Options: `sqlite`, `now`, `namespace`, `settings`, `connectFault`. |
| `EMQX_PRESETS` | object | Every named fault preset. |
| `EMQX_NAMESPACE` | string | The service name, `"emqx"`. |
| `MQTT_CONNECT_OPERATION` | string | `"MqttConnect"`, the operation id a fault rule uses for a CONNECT. |
| `MQTT_WEBSOCKET_PATH` | string | `"/mqtt"`. |
| `MAX_PACKET_SIZE` | number | `1048576`, EMQX's `mqtt.max_packet_size`. |
| `DEFAULT_SETTINGS`, `DEFAULT_JWT_AUTHENTICATOR` | objects | A fresh EMQX: no authenticator, `no_match = allow`; and the JWT authenticator's defaults. |
| `apiKeyCredential` | function | The API key of a request (how credentials map to namespaces). |
| `parseAcl`, `checkAcl` | functions | Parse an `acl` claim, and ask it about one publish or subscribe (`allow`, `deny` or `nomatch`). |
| `ReasonCode` | object | MQTT 5 reason codes by name. |
| `document`, `operationIds`, `supportedOperationIds` | values | The REST contract and its operation ids. |
| `createServer`, `connectStream`, `serveTarget`, `DEFAULT_PORT`, `DEFAULT_MQTT_PORT` (`./server`) | Node | Serve HTTP, WebSocket and TCP (`{url, mqttUrl, mqttPort, wsUrl, runtime, close()}`; options add `port`, `mqttPort`, `host`, `sweepMs`); an in-process MQTT stream; the `serve` CLI target; ports 8850 and 1883. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
