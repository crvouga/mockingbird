# @crvouga/mockingbird-service-livekit

Stateful LiveKit mock for `livekit-server-sdk`. It serves Twirp JSON room APIs, validates genuine HS256 LiveKit grants, models participant/track/data state, exposes deterministic SIP and egress controls, and emits correctly signed lifecycle webhooks.

## Install

```bash
npm install -D @crvouga/mockingbird-service-livekit
```

ESM only. Node 22+ or Bun 1.2+.

## Usage

```ts
import { createServer } from "@crvouga/mockingbird-service-livekit/server"

const mock = await createServer({
  keys: { fixture: "fixture-secret-that-is-at-least-32-chars" },
})
const health = await fetch(`${mock.url}/health`)
```

Point `RoomServiceClient` at `mock.url`. Supported RoomService calls include CreateRoom, ListRooms, DeleteRoom, UpdateRoomMetadata, ListParticipants, GetParticipant, RemoveParticipant, UpdateParticipant, MutePublishedTrack, and SendData. Room creation is idempotent by name and participant identity is unique within a room.

## Controls

- `POST /__admin/rooms/:room/participants` joins a synthetic participant.
- `DELETE /__admin/rooms/:room/participants/:identity` disconnects it.
- `POST /__admin/rooms/:room/participants/:identity/tracks` publishes a track.
- `GET /__admin/rooms/:room/participants/:identity/inbox` inspects targeted data.
- `GET /__admin/resources` and `POST /__admin/resources/:id/transition` inspect and advance SIP/egress state.
- Fault presets include rate limiting, network loss, and webhook duplicate/reorder/drop delivery.

Webhooks cover room, participant, track, egress, and SIP transitions. Each raw body is signed by a short-lived LiveKit access token whose `sha256` claim is accepted by the official `WebhookReceiver`.

## API

- `LiveKitAPI`, `LiveKitAPIOptions`, `LiveKitEvent`: portable handler and event contract.
- `LiveKitRoom`, `LiveKitParticipant`, `LiveKitTrack`, `DataMessage`, `AsyncResource`: durable state.
- `createRuntime`, `LiveKitRuntime`, `LiveKitRuntimeOptions`: full runtime and webhook hub.
- `LIVEKIT_NAMESPACE`, `LIVEKIT_PRESETS`: constants and fault controls.
- `document`, `operationIds`, `supportedOperationIds`: generated OpenAPI metadata.
- `createServer`, `LiveKitServerOptions`, `DEFAULT_PORT`, `serveTarget` from `./server`: Node adapter and CLI integration.

## Deliberately not modelled

WebRTC media transport, signaling sockets, transcoding, PSTN calls, production scaling, billing, and dashboards are not modelled. The deterministic server API and lifecycle contract is the initial fidelity boundary.

Official oracle: [LiveKit RoomService API](https://docs.livekit.io/reference/other/roomservice-api/).
