# Opt-in LiveKit signaling and media fixtures

The package accepts unmodified `livekit-client@2.15.8` through real WebRTC and protobuf signaling.
The emulator owns JWT validation, rooms, participants, tracks, inboxes and controls. Peer connections
are ephemeral and supplied by a browser page or an explicit Node WebRTC provider. This is a tested
fixture contract based on SDK/protocol source, **not oracle-verified production SFU parity**.

## Browser and worker

A page can use `createBrowserSignalServer({ api: runtime.instance("preview") })` from
`@crvouga/mockingbird-service-livekit/browser`. `createSignalWebSocket(server)` returns a
WebSocket-shaped constructor; the host routes only its fixture origin to it. Nothing replaces
global WebSocket/fetch automatically. `server.validate(URL)` serves `/rtc/validate` (200/401).
The exported `SignalPeer` interface also accepts a host's own message stream adapter.

For a runtime inside a worker, bind a private `MessagePort` to one namespace in the worker:

```ts
import { createRuntime } from "@crvouga/mockingbird-service-livekit"
import { hostSignalState } from "@crvouga/mockingbird-service-livekit/signal-state"

const runtime = createRuntime()
self.onmessage = ({ data }) => {
  hostSignalState(data.port, runtime.instance("preview"))
}
```

On the page, transfer one end of a `MessageChannel` to that worker, then pass
`connectSignalState(otherPort)` as `api` to `createBrowserSignalServer`. Await `server.ready`
before issuing audio controls. The page owns real `RTCPeerConnection` instances; the worker owns
keys and persisted state. This private port is a capability to control its namespace, **not an
untrusted-network authentication boundary**. Use only synthetic fixture keys in public previews.
Await `server.close()`, close the state port, then terminate the worker when finished.

## Node

`createServer` from `./server` accepts a `signaling` option. It attaches `/rtc` WebSocket upgrades
and `/rtc/validate` to the existing server port. Token refusal happens before the upgrade with
HTTP 401. The query parameter `namespace` selects the namespace for browser WebSocket clients;
Node callers can also use `x-mockingbird-namespace`.

```ts
import { createServer, type LiveKitServerOptions } from "@crvouga/mockingbird-service-livekit/server"

export async function startFixture(signaling: NonNullable<LiveKitServerOptions["signaling"]>) {
  return createServer({ signaling })
}
```

The host supplies `createPeerConnection(): RTCPeerConnection`. For scripted audio, also supply
`createMediaStream(tracks)` and `createAudio(input)`, returning a track, its duration in milliseconds,
and `close()`. The provider must implement the WebRTC methods used by the fixture, including
`getStats`, ICE restart, data channels and track publication. Node has no built-in WebRTC stack.
The acceptance test uses `werift@0.27.0` with a small DOM-shape adapter and `opusscript@0.1.1` to
encode actual PCM tones to Opus/RTP. Those packages are test-only; consumers choose their provider.
Without `signaling`, the existing default `/rtc` and `/rtc/validate` response remains explicit 501.
Without an audio factory, the audio control returns explicit 501 without creating a track.
Await `server.close()` to terminate sockets, media generators, peers and pending cleanup.

## Controls and state

All routes below use the existing admin prefix, admin authentication and namespace selection.
The participant must already exist (join it through the existing participants control or dispatch).

| Route below `/__admin` | Body or result |
| --- | --- |
| `POST /rooms/:room/participants/:identity/attributes` | `{attributes:{"lk.agent.state":"listening"}}`; empty values remove keys |
| `POST /rooms/:room/participants/:identity/data` | `{payload:"<base64>",topic?,reliable?,destinationIdentities?}` |
| `POST /rooms/:room/participants/:identity/transcription` | `{text,trackId?,id?,final?,destinationIdentities?}` |
| `POST /rooms/:room/participants/:identity/text` | `{text,topic,destinationIdentities?}`; header, chunk and trailer packets |
| `POST /rooms/:room/participants/:identity/rpc-response` | `{requestId,payload,destinationIdentities?}`; sends acknowledgment then response |
| `POST /rooms/:room/participants/:identity/audio` | `{tone:{hz,ms}}` or `{pcm:"<base64 mono signed16 little-endian>",sampleRate}` |
| `GET /rooms/:room/participants/:identity/inbox` | Existing inbox, including authenticated sender and complete protobuf JSON in `packet` |
| `GET /rooms/:room/participants/:identity/media` | Measured `packetsReceived`/`bytesReceived` per published track |
| `GET /signal/connections` | Open, reconnecting and closed connections, participant identity and resume count |
| `POST /signal/disconnect` | `{room,identity?}`; drops selected signaling sockets |
| `POST /faults/presets/network_loss` | Drops all signaling sockets in the selected namespace |

The browser's default audio factory uses `AudioContext` for a tone or PCM buffer. Audio is limited
to 60 seconds; PCM accepts 8–96 kHz. The host must permit audio playback (a browser user gesture or
an explicit test autoplay policy). Scripted activity emits `ActiveSpeakersChanged` while its source
runs; this is a fixture activity signal, not inferred speech detection. Source expiry unpublishes
the track, emits inactive state and closes its resources.

Client user, RPC, transcription and stream packets enter the same inbox collections. The sender
comes from the authenticated participant, not the supplied packet identity. Destination and
publish/subscribe permissions apply. Rooms, tracks, messages, counters and connection records take
part in namespace snapshots; a snapshot does not serialize live peer connections.

Network-loss controls retain peers and participant IDs for a ten-second reconnect window. A valid
`reconnect=1&sid=...` resumes the existing session and negotiates ICE restart. The SDK emits
`SignalReconnecting` for signaling-only loss, then `Reconnected`; it does not emit its broader
`Reconnecting` event for this case. Missing, expired or mismatched sessions are refused.
Reset, participant removal and room deletion close matching live sessions. Scripted audio is also
stopped on reset. Controls do not fabricate vendor webhooks: real participant/track lifecycle
operations use the existing webhook path; transport bookkeeping stays internal.

For direct page fixtures, `sendData`, `sendTranscription` and `publishAudio` are async helpers.
`publishAudio` takes a host-owned track and returns its metadata plus `stop()`; the host owns the
source generator. `onTrack` exposes incoming tracks and `onData` exposes decoded client packets.
Application agents, TTS, business topics and RPC implementations belong to the consuming app.

## Evidence and limits

The Chromium Node fixture uses the real SDK over a native WebSocket, publishes a fake-device
microphone, verifies actual inbound RTP counters, receives encoded remote audio bytes and
transcription/data, writes the inbox, refuses a bad JWT handshake and tears down its peers.
The independent worker fixture proves microphone/media counters, attributes, text stream handlers,
client RPC/inbox and scripted response, tone/PCM tracks, active-speaker start/stop, and same-ID
recovery through the network-loss preset. Other tests cover token signatures, expiry, scope,
permissions, malformed controls, namespace isolation and snapshot restoration.

Not modelled: a production-scale SFU, transcoding, full congestion/quality adaptation, arbitrary
vendor codecs, actual Python agent execution, TTS/speech recognition, persistent media recovery
across process restart, or every LiveKit signaling extension. New scripted audio publications
reach currently connected subscribers; late-subscriber replay is not provided. Raw track helpers
require explicit source cleanup. No live LiveKit oracle or perceptual audio-quality claim is made.
