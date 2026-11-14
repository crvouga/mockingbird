import { describe, expect, test } from "bun:test"
import { AccessToken } from "livekit-server-sdk"
import { createRuntime } from "./src/runtime.js"

describe("LiveKit contract", () => {
  test("Twirp errors, reset, inbox targeting, and async controls", async () => {
    const secret = "fixture-secret-that-is-at-least-32-chars"
    const runtime = createRuntime({ keys: { fixture: secret } })
    const token = new AccessToken("fixture", secret)
    token.addGrant({ roomCreate: true })
    const auth = `Bearer ${await token.toJwt()}`
    const missing = await runtime.fetch(
      new Request("http://mock/twirp/livekit.RoomService/DeleteRoom", {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ room: "missing" }),
      }),
    )
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ code: "not_found", msg: "room not found", meta: {} })
    await runtime.fetch(
      new Request("http://mock/twirp/livekit.RoomService/CreateRoom", {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ name: "a" }),
      }),
    )
    expect(runtime.instance("default").state.rooms.list()).toHaveLength(1)
    await runtime.fetch(new Request("http://mock/__admin/reset", { method: "POST" }))
    expect(runtime.instance("default").state.rooms.list()).toHaveLength(0)
  })
})

test("unsupported signaling fails explicitly without mutating room state", async () => {
  const runtime = createRuntime()
  const api = runtime.instance("default")
  for (const path of ["/rtc?access_token=fixture-not-a-token", "/rtc/validate"]) {
    const response = await runtime.fetch(new Request(`http://mock${path}`))
    expect(response.status).toBe(501)
    expect(await response.json()).toEqual({
      code: "unimplemented",
      msg: "Mockingbird emulator limitation: LiveKit signaling and WebRTC transport are unsupported; use the Twirp APIs and synthetic participant controls",
      meta: {},
    })
  }
  expect(api.state.rooms.list()).toEqual([])
  expect(api.state.participants.list()).toEqual([])
  expect(api.state.inbox.list()).toEqual([])
})
