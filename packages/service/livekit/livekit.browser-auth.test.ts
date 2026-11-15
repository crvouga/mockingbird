import { expect, test } from "bun:test"
import { createBrowserSignalServer, type SignalPeer } from "./src/browser.js"
import { jwt } from "./src/crypto.js"
import { LiveKitAPI } from "./src/index.js"

const secret = "fixture-secret-that-is-at-least-32-chars"
const now = 1_800_000_000_000
const claims = {
  iss: "fixture",
  sub: "visitor",
  exp: now / 1000 + 60,
  video: { roomJoin: true, room: "allowed" },
}

test("browser signaling refuses invalid signatures, expiry, room scope and missing grant without changing state", async () => {
  const api = new LiveKitAPI({ now: () => now })
  const server = createBrowserSignalServer({
    api,
    createPeerConnection: () => {
      throw new Error("Invalid token reached WebRTC")
    },
  })
  const valid = await jwt(secret, claims)
  const tokens = [
    await jwt("wrong-key", claims),
    await jwt(secret, { ...claims, exp: now / 1000 }),
    await jwt(secret, { ...claims, video: { room: "allowed" } }),
    `${valid}.suffix`,
  ]
  for (const token of tokens) {
    let refused = false
    const peer: SignalPeer = {
      url: new URL(`ws://fixture/rtc?access_token=${token}`),
      refuse: () => {
        refused = true
      },
      accept: () => {
        throw new Error("Unexpected accept")
      },
      deliver: () => {},
      close: () => {},
      onMessage: () => {},
      onClose: () => {},
    }
    await server.accept(peer)
    expect(refused).toBe(true)
    expect((await server.validate(peer.url)).status).toBe(401)
  }
  expect(
    (await server.validate(new URL(`http://fixture/rtc/validate?room=other&access_token=${valid}`)))
      .status,
  ).toBe(401)
  expect(api.state.rooms.list()).toHaveLength(0)
  expect(api.state.participants.list()).toHaveLength(0)
  expect(await api.authorizeJoin(valid)).toMatchObject({ room: "allowed", identity: "visitor" })
  server.close()
})

test("signaling observer reset is namespace-local and never emits a fabricated vendor webhook", async () => {
  const events: string[] = []
  const first = new LiveKitAPI({ namespace: "first", onEvent: (event) => events.push(event.event) })
  const second = new LiveKitAPI({ namespace: "second" })
  let reset = 0
  const unsubscribe = first.observe((event) => {
    if (event.event === "emulator_reset") reset++
  })
  first.join("room", { identity: "first" })
  second.join("room", { identity: "second" })
  await first.reset()
  expect(reset).toBe(1)
  expect(events).not.toContain("emulator_reset")
  expect(first.state.participants.list()).toHaveLength(0)
  expect(second.state.participants.list()).toHaveLength(1)
  unsubscribe()
})
