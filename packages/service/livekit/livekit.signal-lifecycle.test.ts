import { expect, test } from "bun:test"
import { AddTrackRequest, SignalRequest, TrackSource, TrackType } from "@livekit/protocol"
import { type AudioSource, createBrowserSignalServer, type SignalPeer } from "./src/browser.js"
import { jwt } from "./src/crypto.js"
import { LiveKitAPI } from "./src/index.js"

const secret = "fixture-secret-that-is-at-least-32-chars"
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const audioSource = (close: () => void): AudioSource => ({
  track: { kind: "audio", addEventListener() {} } as unknown as MediaStreamTrack,
  durationMs: 10000,
  close,
})
const mediaStream = () => ({}) as MediaStream

test("active signaling consults permissions changed through the real admin API", async () => {
  const api = new LiveKitAPI()
  let packets = 0
  let message: ((bytes: Uint8Array) => void) | undefined
  const server = createBrowserSignalServer({
    api,
    createPeerConnection: () =>
      ({
        createDataChannel: () => ({
          readyState: "open",
          send() {
            packets++
          },
        }),
        createOffer: async () => ({ sdp: "" }),
        setLocalDescription: async () => {},
        close() {},
      }) as unknown as RTCPeerConnection,
  })
  try {
    const token = await jwt(secret, {
      iss: "fixture",
      sub: "client",
      exp: Date.now() / 1000 + 60,
      video: { roomJoin: true, room: "room" },
    })
    const peer: SignalPeer = {
      url: new URL(`ws://fixture/rtc?access_token=${token}`),
      onMessage(listener) {
        message = listener
      },
      onClose() {},
      deliver() {},
      accept() {},
      refuse() {
        throw new Error("Unexpected refusal")
      },
      close() {},
    }
    await server.accept(peer)
    const admin = await jwt(secret, {
      iss: "fixture",
      exp: Date.now() / 1000 + 60,
      video: { roomAdmin: true, room: "room" },
    })
    const response = await api.fetch(
      new Request("http://fixture/twirp/livekit.RoomService/UpdateParticipant", {
        method: "POST",
        headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
        body: JSON.stringify({
          room: "room",
          identity: "client",
          permission: { canPublish: false, canSubscribe: false, canPublishData: false },
        }),
      }),
    )
    expect(response.status).toBe(200)
    api.join("room", { identity: "sender" })
    await server.sendData("room", "sender", new Uint8Array([1]))
    message?.(
      new SignalRequest({
        message: {
          case: "addTrack",
          value: new AddTrackRequest({
            cid: "track",
            name: "track",
            type: TrackType.AUDIO,
            source: TrackSource.MICROPHONE,
          }),
        },
      }).toBinary(),
    )
    await tick()
    expect(packets).toBe(0)
    expect(api.getParticipant("room", "client")?.tracks.length ?? 0).toBe(0)
  } finally {
    await server.close()
  }
})

for (const ending of ["close", "remove", "room", "reset"] as const) {
  test(`pending audio is cancelled on ${ending} and a late source is disposed`, async () => {
    const api = new LiveKitAPI()
    api.join("room", { identity: "agent" })
    let finish!: (source: AudioSource) => void
    let closed = 0
    const server = createBrowserSignalServer({
      api,
      createMediaStream: mediaStream,
      createAudio: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    })
    await server.ready
    const pending = api.requestAudio("room", "agent", { tone: { hz: 440, ms: 10000 } }).then(
      () => "published",
      () => "cancelled",
    )
    if (ending === "close") await server.close()
    else if (ending === "remove") api.remove("room", "agent")
    else if (ending === "room") api.deleteRoom("room")
    else await api.reset()
    finish(
      audioSource(() => {
        closed++
      }),
    )
    try {
      expect(await pending).toBe("cancelled")
      await tick()
      expect(closed).toBe(1)
      expect(api.getParticipant("room", "agent")?.tracks.length ?? 0).toBe(0)
    } finally {
      await server.close()
    }
  })
  test(`active audio is stopped on ${ending}`, async () => {
    const api = new LiveKitAPI()
    api.join("room", { identity: "agent" })
    let closed = 0
    const server = createBrowserSignalServer({
      api,
      createMediaStream: mediaStream,
      createAudio: () =>
        audioSource(() => {
          closed++
        }),
    })
    await server.ready
    await api.requestAudio("room", "agent", { tone: { hz: 440, ms: 10000 } })
    if (ending === "close") await server.close()
    else if (ending === "remove") api.remove("room", "agent")
    else if (ending === "room") api.deleteRoom("room")
    else await api.reset()
    try {
      await tick()
      expect(closed).toBe(1)
    } finally {
      await server.close()
    }
  })
}
