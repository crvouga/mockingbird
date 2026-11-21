import { expect, test } from "bun:test"
import { DataPacket, UserPacket } from "@livekit/protocol"
import { createRuntime } from "./src/runtime.js"
import { connectSignalState, hostSignalState } from "./src/signal-state.js"

test("signal packets use authenticated identity, destinations, permissions and persistent namespace collections", async () => {
  const runtime = createRuntime()
  const api = runtime.instance("default")
  api.join("room", { identity: "sender" })
  api.join("room", { identity: "target" })
  api.join("room", { identity: "other" })
  const denied = api.join("room", { identity: "denied", permission: { canPublishData: false } })
  expect(denied).toBeDefined()
  const bytes = new DataPacket({
    participantIdentity: "spoof",
    destinationIdentities: ["target"],
    value: {
      case: "user",
      value: new UserPacket({ payload: new TextEncoder().encode("fixture"), topic: "topic" }),
    },
  }).toBinary()
  api.deliverPacket("room", "sender", bytes)
  expect(api.state.inbox.list()).toHaveLength(1)
  const message = api.state.inbox.list()[0]?.value
  expect(message?.senderIdentity).toBe("sender")
  expect(JSON.parse(message?.packet ?? "{}").participantIdentity).toBe("sender")
  expect(message?.participantSid).toBe(api.getParticipant("room", "target")?.sid)
  expect(() => api.deliverPacket("room", "denied", bytes)).toThrow("cannot publish")
  expect(runtime.instance("other").state.inbox.list()).toHaveLength(0)
  const snapshotResponse = await runtime.fetch(
    new Request("http://mock/__admin/snapshots", { method: "POST" }),
  )
  const snapshot = (await snapshotResponse.json()) as { id: string }
  await api.reset()
  expect(api.state.inbox.list()).toHaveLength(0)
  const restored = await runtime.fetch(
    new Request(`http://mock/__admin/snapshots/${snapshot.id}/restore`, { method: "POST" }),
  )
  expect(restored.status).toBe(200)
  expect(api.state.inbox.list()[0]?.value).toEqual(message)
})

test("MessagePort state calls report errors, isolate namespace and reject work after close", async () => {
  const runtime = createRuntime()
  const channel = new MessageChannel()
  const stop = hostSignalState(channel.port1, runtime.instance("port"))
  const api = connectSignalState(channel.port2)
  try {
    await api.join("room", { identity: "participant" })
    expect((await api.listParticipants("room")).map((p) => p.identity)).toEqual(["participant"])
    expect(runtime.instance("default").listParticipants("room")).toEqual([])
    expect(
      await Promise.resolve(api.deliverPacket("room", "missing", new Uint8Array([1]))).catch(
        (error) => error.message,
      ),
    ).toBe("Participant cannot publish data")
    api.close()
    await expect(api.listParticipants("room")).rejects.toThrow("closed")
  } finally {
    api.close()
    stop()
  }
})

test("malformed signal controls refuse without creating inbox state", async () => {
  const runtime = createRuntime()
  const api = runtime.instance("default")
  api.join("room", { identity: "sender" })
  api.join("room", { identity: "target" })
  for (const [operation, body] of [
    ["data", { payload: "invalid base64!" }],
    ["attributes", { attributes: { state: 4 } }],
    ["text", { topic: "t", text: 4 }],
    ["rpc-response", { requestId: "id", payload: 4 }],
    ["data", { payload: "", destinationIdentities: [3] }],
    ["data", { payload: "", reliable: "true" }],
    ["transcription", { text: "words", final: "yes" }],
    ["audio", { tone: { hz: 440, ms: 10, unsupported: true } }],
  ] as const) {
    const response = await runtime.fetch(
      new Request(`http://mock/__admin/rooms/room/participants/sender/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    )
    expect(response.status).toBe(400)
  }
  expect(api.state.inbox.list()).toHaveLength(0)
  expect(api.getParticipant("room", "sender")?.attributes).toEqual({})
})

test("audio controls explicitly refuse a missing media factory without publishing a track", async () => {
  const runtime = createRuntime()
  const api = runtime.instance("default")
  api.join("room", { identity: "scripted" })
  const response = await runtime.fetch(
    new Request("http://mock/__admin/rooms/room/participants/scripted/audio", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tone: { hz: 440, ms: 100 } }),
    }),
  )
  expect(response.status).toBe(501)
  expect(api.getParticipant("room", "scripted")?.tracks).toEqual([])
})
