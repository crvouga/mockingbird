import { expect, test } from "bun:test"
import { createCallObject } from "./src/browser.js"
import { createRuntime } from "./src/index.js"

const harness = async (properties: Record<string, unknown> = {}) => {
  const runtime = createRuntime({ settings: { apiKeys: ["fixture-daily-key"] } })
  const fetch = (r: Request) => runtime.fetch(r)
  const api = async (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) => {
    const response = await fetch(
      new Request(`http://daily.test${path}`, {
        method,
        headers: { authorization: "Bearer fixture-daily-key", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    return response
  }
  await api("/v1/rooms", { name: "fixture", privacy: "private", properties })
  const { token } = await (
    await api("/v1/meeting-tokens", {
      properties: { room_name: "fixture", user_id: "fixture-user" },
    })
  ).json()
  const options = { baseUrl: "http://daily.test", fetch, pollIntervalMs: 60000 }
  return { runtime, api, options, token, url: "https://mockingbird.daily.co/fixture" }
}

test("call objects share durable presence and track state and observe ejection", async () => {
  const h = await harness()
  const a = createCallObject(h.options)
  const b = createCallObject(h.options)
  const events: string[] = []
  for (const event of [
    "joining-meeting",
    "joined-meeting",
    "participant-joined",
    "participant-updated",
    "participant-left",
    "left-meeting",
  ])
    a.on(event, (e) => {
      events.push(e.action)
    })
  try {
    await a.join(h)
    expect(events.slice(0, 2)).toEqual(["joining-meeting", "joined-meeting"])
    await b.join(h)
    await a.refresh()
    expect(Object.keys(a.participants())).toHaveLength(2)
    await b.setLocalVideo(false)
    await a.refresh()
    expect(Object.values(a.participants()).find((p) => !p.local)?.tracks.video.state).toBe("off")
    expect(events).toContain("participant-updated")
    const presence = await (await h.api("/v1/rooms/fixture/presence")).json()
    expect(presence.total_count).toBe(2)
    await b.leave()
    await a.refresh()
    expect(events).toContain("participant-left")
    const id = a.participants().local?.session_id
    await h.api(`/__admin/rooms/fixture/participants/${id}`, undefined, "DELETE")
    await a.refresh()
    expect(a.meetingState()).toBe("left-meeting")
  } finally {
    await a.destroy()
    await b.destroy()
  }
})

test("join refuses capacity, invalid token and missing room without adding participants", async () => {
  const h = await harness({ max_participants: 1 })
  const a = createCallObject(h.options)
  const b = createCallObject(h.options)
  const errors: string[] = []
  b.on("error", (e) => {
    errors.push(e.error?.type ?? "")
  })
  try {
    await a.join(h)
    await expect(b.join(h)).rejects.toThrow("room-full")
    await expect(b.join({ ...h, token: "invalid" })).rejects.toThrow("ejected")
    await expect(b.join({ ...h, url: "https://mockingbird.daily.co/missing" })).rejects.toThrow(
      "no-room",
    )
    expect(errors).toEqual(["room-full", "ejected", "no-room"])
    expect((await (await h.api("/__admin/rooms/fixture/participants")).json()).length).toBe(1)
  } finally {
    await a.destroy()
    await b.destroy()
  }
})

test("synthetic participants and permission rejection work without a CDN", async () => {
  const h = await harness()
  const a = createCallObject({
    ...h.options,
    getUserMedia: async () => {
      throw new Error("denied")
    },
  })
  const errors: string[] = []
  a.on("camera-error", (e) => {
    errors.push(e.action)
  })
  try {
    await a.join(h)
    expect(errors).toEqual(["camera-error"])
    await h.api("/__admin/rooms/fixture/participants", { user_name: "Synthetic", video: false })
    await a.refresh()
    expect(Object.values(a.participants()).find((p) => !p.local)?.user_name).toBe("Synthetic")
    await h.api("/v1/rooms/fixture", undefined, "DELETE")
    await a.refresh()
    expect(a.meetingState()).toBe("left-meeting")
  } finally {
    await a.destroy()
  }
})

test("emulator clock rejects expired tokens and rooms before creating presence", async () => {
  const h = await harness()
  h.runtime.clock.freeze()
  h.runtime.clock.set(2000000000000)
  const a = createCallObject(h.options)
  try {
    const { token } = await (
      await h.api("/v1/meeting-tokens", { properties: { room_name: "fixture", exp: 1999999999 } })
    ).json()
    await expect(a.join({ ...h, token })).rejects.toThrow("exp-token")
    await h.api("/v1/rooms/fixture", { properties: { exp: 1999999999 } })
    await expect(a.join(h)).rejects.toThrow("exp-room")
    expect(await (await h.api("/__admin/rooms/fixture/participants")).json()).toEqual([])
  } finally {
    await a.destroy()
  }
})

test("local media tracks are exposed, toggled, and stopped on leave", async () => {
  const h = await harness()
  let stopped = 0
  const video = {
    kind: "video",
    enabled: true,
    stop: () => {
      stopped++
    },
  } as MediaStreamTrack
  const audio = {
    kind: "audio",
    enabled: true,
    stop: () => {
      stopped++
    },
  } as MediaStreamTrack
  const stream = { getTracks: () => [video, audio] } as MediaStream
  const a = createCallObject({ ...h.options, getUserMedia: async () => stream })
  try {
    await a.join(h)
    expect(a.participants().local?.tracks.video.track).toBe(video)
    await a.setLocalVideo(false)
    expect(video.enabled).toBe(false)
    await a.leave()
    expect(stopped).toBe(2)
  } finally {
    await a.destroy()
  }
})

test("one-shot join faults are consumed and leave presence untouched", async () => {
  const h = await harness()
  const a = createCallObject(h.options)
  try {
    await h.api("/__admin/call-fault", { type: "ejected" })
    await expect(a.join(h)).rejects.toThrow("ejected")
    expect(await (await h.api("/__admin/rooms/fixture/participants")).json()).toEqual([])
    await a.join(h)
    expect(a.meetingState()).toBe("joined-meeting")
  } finally {
    await a.destroy()
  }
})

test("browser participants survive snapshots, remain isolated, and observe reset", async () => {
  const h = await harness()
  const a = createCallObject(h.options)
  const isolated = createCallObject({
    ...h.options,
    headers: { "x-mockingbird-namespace": "isolated" },
  })
  try {
    await a.join(h)
    const id = a.participants().local?.session_id
    const snapshot = h.runtime.snapshot()
    await expect(isolated.join(h)).rejects.toThrow("no-room")
    await h.api(`/__admin/rooms/fixture/participants/${id}`, { video: false }, "PATCH")
    await a.refresh()
    expect(a.participants().local?.tracks.video.state).toBe("off")
    h.runtime.restore(snapshot)
    await a.refresh()
    expect(a.participants().local?.session_id).toBe(id)
    expect(a.participants().local?.tracks.video.state).toBe("loading")
    await h.api("/__admin/reset", {})
    await a.refresh()
    expect(a.meetingState()).toBe("left-meeting")
  } finally {
    await a.destroy()
    await isolated.destroy()
  }
})

test("wrong-room tokens and room opening windows reject before admission", async () => {
  const h = await harness()
  h.runtime.clock.freeze()
  h.runtime.clock.set(2000000000000)
  const a = createCallObject(h.options)
  try {
    await h.api("/v1/rooms", { name: "other" })
    const { token } = await (
      await h.api("/v1/meeting-tokens", { properties: { room_name: "other" } })
    ).json()
    await expect(a.join({ ...h, token })).rejects.toThrow("ejected")
    await h.api("/v1/rooms/fixture", { properties: { nbf: 2000000100 } })
    await expect(a.join(h)).rejects.toThrow("nbf-room")
    expect(await (await h.api("/__admin/rooms/fixture/participants")).json()).toEqual([])
  } finally {
    await a.destroy()
  }
})
