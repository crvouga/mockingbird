# @crvouga/mockingbird-service-livekit

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful LiveKit emulator for `livekit-server-sdk`. It serves Twirp JSON room and agent-dispatch APIs, validates genuine HS256 LiveKit grants, models participant/track/data state, exposes deterministic SIP and egress controls, and emits correctly signed lifecycle webhooks.

## Install

```bash
npm install -D @crvouga/mockingbird-service-livekit
```

ESM only. Node 22+ or Bun 1.2+.

## Usage

```ts
import { RoomServiceClient } from "livekit-server-sdk"
import { createServer } from "@crvouga/mockingbird-service-livekit/server"

// Test setup: the emulator, with the API key and secret the application signs with.
const emulator = await createServer({
  keys: { fixture: "fixture-secret-that-is-at-least-32-chars" },
})

// The application's client. Only the host changes.
const rooms = new RoomServiceClient(emulator.url, "fixture", "fixture-secret-that-is-at-least-32-chars")
const room = await rooms.createRoom({ name: "consult", emptyTimeout: 60, maxParticipants: 4 })
const listed = await rooms.listRooms() // [room]

await emulator.close()
```

Point `RoomServiceClient` at `emulator.url`. Supported RoomService calls include CreateRoom, ListRooms, DeleteRoom, UpdateRoomMetadata, ListParticipants, GetParticipant, RemoveParticipant, UpdateParticipant, MutePublishedTrack, and SendData. Room creation is idempotent by name and participant identity is unique within a room.

`AgentDispatchClient` uses the same URL and genuine `roomAdmin` JWTs for `createDispatch`, `listDispatch`, `getDispatch`, and `deleteDispatch`. Both snake_case and camelCase request fields work. A dispatch creates a missing room, starts with no assigned jobs, and preserves its agent name and opaque metadata. Lists read shared room dispatch state, with an optional dispatch-id filter; deleting a dispatch removes its membership. Deleting or expiring a room removes its dispatches. Dispatch/job timestamps are emulator-clock Unix seconds encoded as protobuf JSON strings (the SDK exposes bigint values). Tests exercise the existing 2.19.1 SDK and the reporter's exact 2.19.0 over HTTP.

## Controls

- `POST /__admin/rooms/:room/participants` joins a synthetic participant.
- `DELETE /__admin/rooms/:room/participants/:identity` disconnects it.
- `POST /__admin/rooms/:room/participants/:identity/tracks` publishes a track.
- `GET /__admin/rooms/:room/participants/:identity/inbox` inspects targeted data.
- `GET /__admin/resources` and `POST /__admin/resources/:id/transition` inspect and advance SIP/egress state.
- `POST /__admin/dispatches/:id/jobs` scripts one room job with `{status?: "JS_PENDING"|"JS_RUNNING"|"JS_SUCCESS"|"JS_FAILED", workerId?, agentId?, participantIdentity?, error?}`. First assignment creates a stable job id; later calls update it and stamp its start/end/update times. The default status is running.
- Dispatches and jobs participate in namespaces, reset, snapshots, Timeline and fault recovery alongside room state.
- Fault presets include rate limiting, network loss, and webhook duplicate/reorder/drop delivery.

Webhooks cover room, participant, track, egress, and SIP transitions. Each raw body is signed by a short-lived LiveKit access token whose `sha256` claim is accepted by the official `WebhookReceiver`.

## API

- `LiveKitAPI`, `LiveKitAPIOptions`, `LiveKitEvent`: handler and event contract.
- `LiveKitRoom`, `LiveKitParticipant`, `LiveKitTrack`, `DataMessage`, `AsyncResource`, `AgentDispatch`, `AgentJob`, `JobStatus`: durable state.
- `createRuntime`, `LiveKitRuntime`, `LiveKitRuntimeOptions`: full runtime and webhook hub.
- `LIVEKIT_NAMESPACE`, `LIVEKIT_PRESETS`: constants and fault controls.
- `document`, `operationIds`, `supportedOperationIds`: generated OpenAPI metadata.
- `createServer`, `LiveKitServerOptions`, `DEFAULT_PORT`, `serveTarget` from `./server`: Node adapter and CLI integration.

## Deliberately not modelled

Real agent worker registration, job execution, publisher dispatch, restart/deployment policies, WebRTC media transport, signaling sockets, transcoding, PSTN calls, production scaling, billing, and dashboards are not modelled. The deterministic server API and lifecycle contract is the initial fidelity boundary.

Official oracles: [LiveKit RoomService API](https://docs.livekit.io/reference/other/roomservice-api/) and [AgentDispatchService API](https://docs.livekit.io/reference/agents/agent-dispatch-service-api/).
