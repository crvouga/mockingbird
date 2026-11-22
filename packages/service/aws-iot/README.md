# @crvouga/mockingbird-service-aws-iot

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful emulator of the **AWS IoT Core data plane** for test suites and local development:
IoTDataPlane `Publish` over HTTP with Signature Version 4 verification, and the MQTT 5 message
broker over TCP and WebSocket (`/mqtt`) with custom-authorizer policies, AWS IoT's persistent
session rules and its documented departures from the MQTT specification. It runs in the test
process on OS-assigned ports with no AWS account, and session expiry follows a clock the suite
moves instead of waiting.

- Operation coverage (HTTP): [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/aws-iot/SUPPORT.md)
- No AWS account was used as an oracle. Behaviour follows the
  [Publish API reference](https://docs.aws.amazon.com/iot/latest/apireference/API_iotdata_Publish.html),
  the [MQTT](https://docs.aws.amazon.com/iot/latest/developerguide/mqtt.html),
  [custom authentication](https://docs.aws.amazon.com/iot/latest/developerguide/custom-auth.html),
  [policy](https://docs.aws.amazon.com/iot/latest/developerguide/pub-sub-policy.html) and
  [quota](https://docs.aws.amazon.com/general/latest/gr/iot-core.html#message-broker-limits)
  pages, and AWS's SDK signer. What those do not settle is listed under [Unverified](#unverified).
- It is not the EMQX emulator with another name: where the two vendors differ
  (`@crvouga/mockingbird-service-emqx`), each follows its own.

## Install

```bash
npm install -D @crvouga/mockingbird-service-aws-iot
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-aws-iot serve` or `createServer` from `./server` (Node and Bun). `createRuntime`
(the default entry) is portable: it serves `Publish` over `fetch` and MQTT through
`runtime.attach`, with no listener.

## Usage

Point the app's IoT data endpoint at `url` and its MQTT URL at `mqttUrl` or `wsUrl`. There is no
TLS: use the `http://`, `mqtt://` and `ws://` URLs as given.

```ts
import { createServer } from "@crvouga/mockingbird-service-aws-iot/server"
import { IoTDataPlaneClient, PublishCommand } from "@aws-sdk/client-iot-data-plane"
import mqtt from "mqtt"

// Test setup: start the emulator with the credentials and authorizer policies the test needs.
const arn = (resource: string) => `arn:aws:iot:us-east-1:123456789012:${resource}`
const iot = await createServer({
  settings: {
    // HTTP: SigV4 signatures are verified against these keys.
    credentials: [{ accessKeyId: "test-key", secretAccessKey: "test-secret" }],
    // MQTT: what the custom authorizer answers for a username and password.
    authorizers: [
      {
        username: "alice",
        password: "alice-token",
        policyDocuments: [
          {
            Version: "2012-10-17",
            Statement: [
              { Effect: "Allow", Action: "iot:Connect", Resource: arn("client/alice-*") },
              { Effect: "Allow", Action: "iot:Subscribe", Resource: arn("topicfilter/user/alice") },
              { Effect: "Allow", Action: "iot:Receive", Resource: arn("topic/user/alice") },
            ],
          },
        ],
      },
    ],
  },
})

// Application code: the MQTT client and AWS SDK client it already uses, pointed at the emulator.
const device = await mqtt.connectAsync(iot.mqttUrl, {
  protocolVersion: 5,
  clientId: "alice-phone",
  clean: false,
  properties: { sessionExpiryInterval: 600 },
  username: "alice",
  password: "alice-token",
})
await device.subscribeAsync("user/alice", { qos: 1 })

const client = new IoTDataPlaneClient({
  region: "us-east-1",
  endpoint: iot.url,
  credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" },
})
await client.send(new PublishCommand({ topic: "user/alice", qos: 1, payload: '{"hello":"alice"}' }))

await device.endAsync()
await iot.close() // closes every listener and drops every client
```

```bash
npx mockingbird-aws-iot serve --port 8851 --mqtt-port 8883 \
  --credential test-key:test-secret --settings ./aws-iot-settings.json
```

Each `createServer()` is its own broker with its own ports; two of them share nothing. Under
Bun, `mqtt`'s Node WebSocket transport does not start (Bun's `ws` has no
`createWebSocketStream`), so connect to `wsUrl` with the library's browser transport
(`new MqttClient((c) => browserStreamBuilder(c, options), options)` from `mqtt/lib/connect/ws`),
or use `connectStream(runtime)` from `./server` for a socket-free connection. On Node the plain
`mqtt.connect("ws://…/mqtt")` works.

Topics are what the client sends. AWS IoT separates levels with `/` and gives `:` no meaning,
so an application that calls a topic `user:example` and publishes it as `user/example` does that
mapping itself; the emulator, like AWS, never sees the first form.

### Routes

| Route | Behaviour |
| --- | --- |
| `POST /topics/{topic}?qos=0\|1` | IoTDataPlane `Publish`. The body is the payload, taken as the bytes sent. The topic is percent-decoded once (`user%2Fexample` is `user/example`; `a%252Fb` is the literal `a%2Fb`); unencoded slashes are accepted too, as in AWS's own examples. `200 {"message": "OK", "traceId": "…"}` whether or not anyone subscribes. Also read: `retain`, `contentType`, `responseTopic`, `messageExpiry` (adjusted into 1…604800), and the `x-amz-mqtt5-user-properties`, `x-amz-mqtt5-payload-format-indicator` and `x-amz-mqtt5-correlation-data` headers, which reach subscribers as MQTT 5 properties. |
| errors | `{"message": "…", "traceId": "…"}` with `x-amzn-ErrorType`. `400 InvalidRequestException` for a topic that is empty, has wildcards, exceeds 256 bytes or 7 slashes, or starts with `$`; a `qos` other than 0 or 1; a bad `retain`, `messageExpiry` or MQTT 5 header; a malformed percent escape; a payload over 128 KB. `401 UnauthorizedException` when the signing identity's policy does not allow `iot:Publish` on the topic. `403` (`Forbidden`) when the request is unsigned or its signature does not verify. `405 MethodNotAllowedException` for any other verb or path. An `x-mockingbird-reason` header says which check failed. |

**SigV4.** With `credentials` empty, any request carrying a well-formed
`Authorization: AWS4-HMAC-SHA256 …` header is accepted unverified (as Mockingbird's other AWS
emulators do), and an unsigned request is still refused. With credentials configured the
signature must verify: service `iotdata`, the configured region, `host` and `x-amz-date` signed,
the path encoded a second time in the canonical request (as every service but S3), the payload
hash the SHA-256 of the body, and `x-amz-security-token` matching for temporary credentials.
A credential's `policyDocuments`, when given, must allow `iot:Publish` on
`arn:aws:iot:<region>:<account>:topic/<topic>`.

### MQTT

MQTT 5.0 over TCP and over WebSocket at `/mqtt` (subprotocol `mqtt`). Both reach the same
sessions, and the same sessions `Publish` delivers to.

| Area | Behaviour |
| --- | --- |
| Authentication | Custom authentication only. `authorizers` lists the outcomes of a custom authorizer by MQTT username and password (the username's `?x-amz-customauthorizer-name=…` query is read and stripped); or pass `authorizer` to `createRuntime`, a function that receives the Lambda event (`protocolData.mqtt.{username, password (base64), clientId}`) and returns `{isAuthenticated, principalId, policyDocuments}`. No matching entry, `isAuthenticated: false`, a failing function, or a policy that does not allow `iot:Connect` on `client/<clientId>` is CONNACK `0x87`. With neither configured every client connects, allowed everything. |
| Policies | `iot:Connect` on `client/<id>`, `iot:Publish` and `iot:Receive` on `topic/<name>`, `iot:Subscribe` on `topicfilter/<filter>`. Default deny; an explicit `Deny` overrides any `Allow`. `*` and `?` are wildcards (`*` spans levels); MQTT's `+` and `#` in a policy are ordinary characters, so a policy must name the filter a client subscribes with. `${iot:ClientId}` expands. A denied SUBSCRIBE is SUBACK `0x87`; a denied QoS 1 PUBLISH is PUBACK `0x87`; a subscriber without `iot:Receive` for a topic silently receives nothing from it. |
| CONNACK | Maximum QoS 1, Retain Available 0 (see below), Maximum Packet Size 149504, Topic Alias Maximum 8, Receive Maximum 100, Wildcard Subscription Available 1, Subscription Identifier Available 0, Shared Subscription Available 0. Server Keep Alive when AWS would change the client's: 1200 for `0` or more than 1200, 30 for less than 30. |
| Persistent sessions | Clean Start 0 with a Session Expiry Interval above 0. The interval is capped at the account quota (`persistentSessionExpirySeconds`, one hour by default, seven days at most) and the adjusted value is returned in the CONNACK. A session keeps its subscriptions and QoS 1 messages only (QoS 0 is not stored). The timer starts when the connection ends; at expiry the session and its queue are discarded. |
| Client id | At most 128 bytes (CONNACK `0x85` beyond). A second connection with a connected client id is accepted and the first is sent DISCONNECT `0x8E`. |
| Topics | At most 256 bytes and 7 forward slashes; topics and filters beginning with `$` are refused (SUBACK `0x8F`, PUBACK `0x90`). `sensor/#` matches `sensor/` and `sensor/a/b` and not `sensor`. |
| QoS | 0 and 1. A SUBSCRIBE asking for QoS 2 gets no SUBACK; a QoS 2 PUBLISH is answered DISCONNECT `0x9B`. A publish nobody subscribes to is acknowledged `0x00`. |
| Payload | At most 128 KB; a larger PUBLISH disconnects the client. |
| Subscription Identifiers | Not supported, as on AWS: DISCONNECT `0xA1`. |

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `GET /__admin/publishes` | `{total, publishes}`: the last 1000 accepted publishes as metadata (`topic`, `qos`, `bytes`, `source: "http" \| "mqtt" \| "admin"`, `clientId`, `matched`, `at`). Payloads are never kept. |
| `GET /__admin/clients`, `GET /__admin/clients/:clientId` | Sessions: `connected`, `transport`, `sessionExpiryInterval`, `expiresAt`, counts of `subscriptions`, `queued`, `inflight`; one session also lists its `topics`. |
| `GET /__admin/subscriptions?clientId=` | Subscriptions: `topicFilter`, granted `qos`, options. |
| `POST /__admin/inject` | `{topic, payload \| payloadBase64, qos?: 0 \| 1}`: deliver raw bytes to the topic's subscribers, bypassing signing, validation and publish policy (`iot:Receive` still applies). Use it for bytes a consumer's parser must refuse. Answers `{matched}`. |
| `POST /__admin/transport/cut` | `{clientId?}`: a network outage for one client, or for all. Live connections die with no DISCONNECT and new CONNECTs are dropped unanswered. Sessions are untouched and expire on their own schedule. |
| `POST /__admin/transport/restore` | `{clientId?}`: end the outage. `GET /__admin/transport` lists what is cut. |
| `POST /__admin/clients/:clientId/disconnect` | `{reasonCode?}`: send DISCONNECT (default `0x98`) and close; the session stays. |
| `GET` / `PUT /__admin/settings` | `{credentials?, authorizers?, region?, accountId?, persistentSessionExpirySeconds?}` for the calling namespace. A policy document the emulator cannot evaluate is refused with `400`. Reset returns to the values the runtime was created with. |
| `POST /__admin/clock` | Standard. Moving the clock settles session expiry at once. |
| `POST /__admin/reset`, checkpoints | Standard. Reset drops every connection and session. Restoring a checkpoint restores sessions, subscriptions and queues, and drops live connections. |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`; `GET /__admin/faults/presets`):
`publish_throttled` (`429 ThrottlingException`), `publish_unauthorized` (`401
UnauthorizedException`), `publish_internal_failure` (`500 InternalFailureException`),
`connect_not_authorized` (CONNACK `0x87`), `connect_bad_credentials` (`0x86`),
`connect_quota_exceeded` (`0x97`). A CONNECT is the fault operation `MqttConnect`, so any reason
code can be forced: `{"operationId": "MqttConnect", "effect": "connack", "params": {"reasonCode": 137}}`.

### Namespaces

Parallel workers isolate themselves by namespace. HTTP: `x-mockingbird-namespace`, a
`/__admin/ns/<name>` prefix on the endpoint, or by access key id
(`PUT /__admin/credentials {"credentials": {"<AWS_ACCESS_KEY_ID>": "<namespace>"}}`). MQTT: the
WebSocket URL `ws://…/__admin/ns/<name>/mqtt`, or the same credential map keyed by the CONNECT's
username (without its query string), then its client id. Unmapped clients use the default
namespace.

### Unverified

The documentation does not settle these; the emulator's choice is stated so a suite does not
mistake it for the vendor's:

- The success body. The API reference says `Publish` answers an empty body; AWS's custom
  authentication tutorial shows `{"message": "OK", "traceId": "…"}`. The emulator sends the
  latter, which the SDK ignores.
- Refused credentials. For an unsigned request or a signature that does not verify the emulator
  answers `403 {"message": "Forbidden", "traceId"}` with `x-amzn-ErrorType: ForbiddenException`:
  the body is the one AWS documents for a rejected custom-authorizer signature, the status and
  header are inferred. For a valid signature without `iot:Publish` it answers the documented
  `401 UnauthorizedException`; whether AWS answers 401 or 403 there was not confirmed.
- Whether AWS sends `x-amzn-ErrorType`, the `message` text of each `400`, and the HTTP error for
  a payload over 128 KB (the emulator uses `400 InvalidRequestException`).
- "128 KB" and "146 KB" are taken as 131072 and 149504 bytes. AWS's MQTT page also says the
  Maximum Packet Size "cannot exceed 128 KB"; the quota page's 146 KB is used.
- What the client sees for `isAuthenticated: false` (AWS says it "terminates the connection";
  the emulator sends CONNACK `0x87` first), for a topic over the limits or beginning with `$`
  (AWS says such operations "can result in a terminated connection"; the emulator answers
  SUBACK `0x8F` / PUBACK `0x90` and keeps the connection), and for an oversized MQTT payload
  (DISCONNECT `0x95`).
- A QoS 2 SUBSCRIBE getting no SUBACK is AWS's documented behaviour, stated without a protocol
  version; it is applied to MQTT 5 as written.
- The Receive Maximum (100, from the quota on unacknowledged publishes), when Server Keep Alive
  is sent, the format of an assigned client id, and whether the Lambda event's `username`
  includes the query string (the emulator strips it).
- Signing dates are not checked against the clock, so a suite can freeze time.

### Deliberately not modelled

- MQTT 3.1 and 3.1.1 (refused with that protocol's return code 1), TLS, X.509 client
  certificates, ALPN and SNI, and SigV4-presigned WebSocket URLs.
- Custom authorizers over HTTP, token signing, and `disconnectAfterInSeconds` /
  `refreshAfterInSeconds` (accepted, not enforced).
- Policy `Condition`, `NotAction` and `NotResource` (a document using them is refused), policy
  variables other than `${iot:ClientId}`, and `iot:RetainPublish`.
- Retained messages: the CONNACK says Retain Available 0, a retained MQTT publish is answered
  DISCONNECT `0x9A`, and `retain=true` over HTTP is `400`. AWS itself supports them.
- Will messages (accepted in CONNECT, never published), shared subscriptions (SUBACK `0x9E`),
  keep-alive timeouts, message expiry, outbound topic aliases, and reserved `$aws/…` topics.
- Rate and count quotas (publishes per second, subscriptions per connection or per SUBSCRIBE,
  the 10 messages per second replay of a stored session).
- The thing registry, shadows, rules and actions, jobs, provisioning, the other data-plane
  operations, billing and infrastructure management.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `createRuntime` | function | The emulator with the full service contract. Options: `settings`, `authorizer`, `clock`, `seed`, `adminPrefix`, `adminKey`, `onLog`, `sqlite`. Adds `attach(transport, info?, namespace?)` for an MQTT connection, `webSocketPath(pathname)`, `endpoints`, and `stop()`. |
| `AwsIotAPI` | class | One namespace: `fetch(request)` for `Publish`, `broker` for MQTT, `state`, `reset()`. Options: `sqlite`, `now`, `namespace`, `settings`, `authorizer`, `connectFault`. |
| `AWS_IOT_PRESETS` | object | Every named fault preset. |
| `AWS_IOT_NAMESPACE` | string | The service name, `"aws-iot"`. |
| `SIGNING_NAME` | string | `"iotdata"`, the SigV4 signing name. |
| `MQTT_CONNECT_OPERATION`, `MQTT_WEBSOCKET_PATH` | strings | `"MqttConnect"`, the operation id a fault rule uses for a CONNECT; and `"/mqtt"`. |
| `MAX_PAYLOAD_BYTES`, `MAX_PACKET_SIZE`, `MAX_TOPIC_BYTES`, `MAX_TOPIC_SLASHES`, `MAX_CLIENT_ID_BYTES`, `MAX_MESSAGE_EXPIRY_SECONDS`, `MAX_PERSISTENT_SESSION_EXPIRY_SECONDS`, `KEEP_ALIVE_RANGE` | numbers | AWS IoT Core's limits as the emulator enforces them. |
| `DEFAULT_SETTINGS` | object | Region `us-east-1`, account `123456789012`, no credentials or authorizers, a one-hour session quota. |
| `parseSettings` | function | Validate a settings patch from JSON; throws naming the field that is wrong. |
| `parsePolicyDocument`, `isAllowed`, `resourceArn`, `PolicyError` | functions, class | Parse a policy document (object or JSON string), evaluate it for an action and target, and build the ARN an action is checked against. |
| `accessKeyCredential`, `splitUsername` | functions | The access key id of a signed request; an MQTT username and the authorizer its query string names (how credentials map to namespaces). |
| `ReasonCode` | object | MQTT 5 reason codes by name. |
| `document`, `operationIds`, `supportedOperationIds` | values | The HTTP contract and its operation ids. |
| `createServer`, `connectStream`, `loadSettingsFile`, `serveTarget`, `DEFAULT_PORT`, `DEFAULT_MQTT_PORT` (`./server`) | Node | Serve HTTP, WebSocket and TCP (`{url, mqttUrl, mqttPort, wsUrl, runtime, close()}`; options add `port`, `mqttPort`, `host`, `sweepMs`); an in-process MQTT stream; read a `--settings` file; the `serve` CLI target; ports 8851 and 8883. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
