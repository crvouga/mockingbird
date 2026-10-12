# @crvouga/mockingbird-service-fcm

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful emulator of the **Firebase Cloud Messaging HTTP v1** send API (`POST /v1/projects/{project_id}/messages:send`), the call `firebase-admin` makes. Projects, access tokens, and registration tokens are fixtures. There is no FCM sandbox. This package is `status: "wip"`.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/fcm/SUPPORT.md)
- The contract (`openapi.yaml`) is hand-authored from the FCM REST reference and firebase-admin 12.7.0 / 13.5.0.

## Install

```bash
npm install -D @crvouga/mockingbird-service-fcm
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with `npx mockingbird-fcm serve`, `createServer` from `./server` (Node), or `createRuntime` with any Fetch server.

## Usage

`firebase-admin` hardcodes `https://fcm.googleapis.com`. Point it at the emulator with `createAdminTransport` (an `https.Agent` that dials the emulator) and call `enableLegacyHttpTransport()` so multicast sends honor that agent. `send` is already HTTP/1.1. The fixture project is `demo-project`, the fixture device token is `fixture-device-token`, and any bearer is accepted until you turn on `strict`.

```ts
import { deleteApp, initializeApp } from "firebase-admin/app"
import { getMessaging } from "firebase-admin/messaging"
import { createServer } from "@crvouga/mockingbird-service-fcm/server"
import { createAdminTransport } from "@crvouga/mockingbird-service-fcm/admin"

// Test setup: the emulator, plus a credential and an agent that reach it.
const fcm = await createServer()
const transport = await createAdminTransport({ origin: fcm.url, token: "fixture-token" })

// The application's firebase-admin app. Only its credential and httpAgent change.
const app = initializeApp({
  projectId: "demo-project",
  credential: transport.credential,
  httpAgent: transport.agent,
})
const messaging = getMessaging(app)
messaging.enableLegacyHttpTransport()
const name = await messaging.send({
  token: "fixture-device-token",
  notification: { title: "Hello", body: "World" },
})
// name → "projects/demo-project/messages/<id>"

// Test control: every message the emulator accepted.
const outbox = await (await fetch(`${fcm.url}/__admin/outbox`)).json()
void outbox

await deleteApp(app)
await transport.close()
await fcm.close()
```

### Routes

| Route | Behaviour |
| --- | --- |
| `POST /v1/projects/{project_id}/messages:send` | Bearer required. Body `{ message, validate_only? }`. One registration `token` (topic and condition are rejected). Success is `{ name: "projects/{project_id}/messages/{id}" }`. Errors are a Google RPC envelope. `validate_only: true` validates and returns a name without storing anything. |
| `GET /__admin/health` | Liveness, plus the `x-mockingbird` header on every response. |

### Admin

| Route | Behaviour |
| --- | --- |
| `GET /__admin/outbox` | Accepted messages, oldest first. Filters: `token`, `platform`, `project`, `since` (epoch ms), `collapseKey`, `state`. Each row has the normalized fields and the original `wire` message. |
| `POST /__admin/tokens` | Register `{ token, platform?, project?, state?, appId? }`. `tokens: [...]` registers a batch. |
| `POST /__admin/tokens/:token/expire` | Mark expired. Optional `{ replacement }`. |
| `POST /__admin/tokens/:token/state` | `{ state: active \| expired \| unregistered \| sender_mismatch }`. |
| `GET /__admin/inbox/:token` | Device inbox, in delivery order. |
| `POST /__admin/inbox/:token` | `{ action: "ack" }` drops the oldest item. `{ action: "clear" }` empties it. |
| `POST /__admin/deliver` | Deliver accepted messages. Expired ones stay in the outbox as `expired`. |
| `POST /__admin/messages/:id/deliver` | Deliver one accepted message. |
| `POST /__admin/messages/:id/drop` | Mark `dropped` and do not inbox it. |
| `POST /__admin/messages/:id/duplicate` | Copy the inbox entry again. |
| `GET /__admin/settings`, `PUT /__admin/settings` | `strict`, `automaticDelivery` (default true), `collapse` (default false), `credentials` (bearer → `{ project, expired? }`), `clockOffsetMs`. |
| `POST /__admin/time` | `{ advanceMs }` moves this namespace's offset only. |
| `POST /__admin/scripts` | `{ token?, errorCode, count, httpStatus? }`. The next `count` sends to that token (or every token when `token` is omitted) return that Google RPC error and store nothing. Then the token's own state applies. |
| `GET /__admin/scripts`, `DELETE /__admin/scripts` | List or clear scripts. `?token=` clears one. |

Logical message time is `clockOffsetMs` plus the process-wide runtime clock. `POST /__admin/clock` still moves every namespace. Records, faults, outboxes, inboxes, and message ids are per namespace.

### Presets

`POST /__admin/faults {"preset": "<name>"}`. Each one targets `SendMessage`:

| Preset | Effect |
| --- | --- |
| `invalid_auth` | 401 `UNAUTHENTICATED`, nothing stored |
| `permission_denied` | 403 `PERMISSION_DENIED`, nothing stored |
| `invalid_argument` | 400 `INVALID_ARGUMENT`, nothing stored |
| `unregistered` | 404 `NOT_FOUND` + FcmError `UNREGISTERED`, nothing stored |
| `sender_mismatch` | 403 + FcmError `SENDER_ID_MISMATCH`, nothing stored |
| `quota_exceeded` | 429 `RESOURCE_EXHAUSTED`, `Retry-After`, `google.rpc.RetryInfo`, FcmError `QUOTA_EXCEEDED` |
| `unavailable` | 503 + FcmError `UNAVAILABLE` |
| `internal` | 500 + FcmError `INTERNAL` |
| `slow` | waits 15s (the Firebase Admin send timeout) |
| `drop` | connection drop before accept; outbox stays empty |
| `accepted_then_network_drop` | outbox record is stored, then the connection drops |

### Namespaces

`x-mockingbird-namespace`, a `/__admin/ns/<name>/` prefix, or `PUT /__admin/credentials` (bearer → namespace). A bearer listed in `settings.credentials` authorizes only that project. `strict: true` rejects bearers that are not listed. Webhooks: none. The device inbox is a test control, not a callback.

### SDK error codes

firebase-admin maps `error.details[].errorCode` when `@type` is `type.googleapis.com/google.firebase.fcm.v1.FcmError`, otherwise `error.status`. Two mappings differ from a naive reading of the error-code names, and the emulator follows firebase-admin 12.7.0 and 13.5.0:

- A JSON 401 with status `UNAUTHENTICATED` and no FcmError details becomes `messaging/third-party-auth-error`. `messaging/authentication-error` is what the SDK uses for a non-JSON 401.
- FcmError `DEADLINE_EXCEEDED` is not in the messaging map, so the SDK reports `messaging/unknown-error`. `UNAVAILABLE` is `messaging/server-unavailable`.

`INVALID_ARGUMENT`, `SENDER_ID_MISMATCH`, `QUOTA_EXCEEDED`, `UNAVAILABLE`, and `INTERNAL` map to `messaging/invalid-argument`, `messaging/mismatched-credential`, `messaging/message-rate-exceeded`, `messaging/server-unavailable`, and `messaging/internal-error`. Status `PERMISSION_DENIED` (a bearer for another project) is also `messaging/mismatched-credential`.

### Deliberately not modelled

- Firebase Auth, Firestore, Realtime Database, Hosting, Remote Config, Analytics, and client installation APIs.
- Topic and condition sends, and topic subscription management.
- APNs and Android transport, real devices, app callbacks, notification rendering, badges, and sounds.
- Production quotas and Google's unpublished retry schedule. The Admin SDK's own retry (503, `ECONNRESET`, `ETIMEDOUT`) is left to the SDK.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `FcmAPI` | class | In-process emulator: `fetch(request)`, `reset()`, `logicalNow()`, `outbox(query)`, `inbox(token)`, `registerToken`, `setTokenState`, `ackInbox`, `deliverPending`, `dropMessage`, `duplicateMessage`, `putScript`. Options: `sqlite`, `now`, `namespace`, `settings`. |
| `createRuntime` | function | Emulator plus `/__admin/health`, `/__admin/*`, namespaces, clock, presets, and the journal. Options: `sqlite`, `clock`, `seed`, `adminKey`, `onLog`, `settings`. |
| `FCM_PRESETS` | object | Named fault presets. |
| `FCM_NAMESPACE` | string | Service name, `"fcm"`. |
| `FCM_FIXTURE_PROJECT` | string | Seeded project id, `"demo-project"`. |
| `FCM_FIXTURE_TOKEN` | string | Seeded Android registration token, `"fixture-device-token"`. |
| `FCM_FIXTURE_BEARER` | string | Bearer the playground sends, `"fixture-token"`. Accepted whenever `strict` is off. |
| `fcmCredential` | function | `(accessToken?)` → `{ getAccessToken }` for `initializeApp({ credential })`. |
| `document`, `operationIds`, `supportedOperationIds` | values | The OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`. CLI flag `--strict`. Port 8826. |
| `createAdminTransport` (`./admin`) | Node | `{ origin, token? }` → `{ credential, agent, port, close }`. `agent` is an `https.Agent` aimed at the emulator. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
