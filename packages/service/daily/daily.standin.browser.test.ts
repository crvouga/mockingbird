import { expect, test } from "bun:test"
import { chromium } from "@playwright/test"
import { createRuntime } from "./src/index.js"

const prepare = async () => {
  const runtime = createRuntime({ settings: { apiKeys: ["fixture-daily-key"] } })
  const api = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    runtime.fetch(
      new Request(`https://daily.test${path}`, {
        method,
        headers: { authorization: "Bearer fixture-daily-key", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  await api("/v1/rooms", { name: "fixture", privacy: "private" })
  const { token } = await (
    await api("/v1/meeting-tokens", {
      properties: { room_name: "fixture", user_id: "fixture-user" },
    })
  ).json()
  return { runtime, api, token }
}

test("served Daily stand-in joins two Chromium pages, exposes media, observes peers and disposes", async () => {
  const h = await prepare()
  const browser = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  })
  try {
    const context = await browser.newContext({ permissions: ["camera", "microphone"] })
    await context.route("**/*", async (route) => {
      const req = route.request()
      if (req.url() === "https://daily.test/fixture.html")
        return route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><script src="/daily-js/stand-in.js"></script>',
        })
      if (!req.url().startsWith("https://daily.test/"))
        throw new Error("Unexpected external network request")
      const body = req.postDataBuffer()
      const response = await h.runtime.fetch(
        new Request(req.url(), {
          method: req.method(),
          headers: req.headers(),
          ...(body ? { body: new Uint8Array(body) } : {}),
        }),
      )
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      })
    })
    const a = await context.newPage()
    const b = await context.newPage()
    await Promise.all([
      a.goto("https://daily.test/fixture.html"),
      b.goto("https://daily.test/fixture.html"),
    ])
    const join = `globalThis.events=[]; globalThis.call=DailyIframe.createCallObject({pollIntervalMs:10}); for(const name of ["joining-meeting","joined-meeting","participant-joined","participant-left","participant-updated","track-started","track-stopped"])call.on(name,e=>events.push(e.action)); call.join(${JSON.stringify({ url: "https://mockingbird.daily.co/fixture", token: h.token })})`
    await a.evaluate(join)
    await b.evaluate(join)
    await a.waitForFunction("Object.keys(call.participants()).length === 2")
    expect(
      await a.evaluate<unknown>(
        "[call.meetingState(), DailyIframe.getCallInstance() === call, call.localAudio(), call.localVideo(), call.participants().local.tracks.video.track instanceof MediaStreamTrack]",
      ),
    ).toEqual(["joined-meeting", true, true, true, true])
    await b.evaluate("call.setLocalVideo(false)")
    await a.waitForFunction(
      "Object.values(call.participants()).some(p=>!p.local && p.tracks.video.state === 'off')",
    )
    expect(await b.evaluate<unknown>("call.localVideo()")).toBe(false)
    await b.evaluate("DailyIframe.destroy()")
    await a.waitForFunction("events.includes('participant-left')")
    expect(
      await b.evaluate<unknown>(
        "[DailyIframe.getCallInstance(), events.includes('track-stopped')]",
      ),
    ).toEqual([undefined, true])
    const synthetic = await (
      await h.api("/__admin/rooms/fixture/participants", { user_name: "Synthetic" })
    ).json()
    await a.waitForFunction(
      "Object.values(call.participants()).some(p=>p.user_name === 'Synthetic')",
    )
    await h.api(`/__admin/rooms/fixture/participants/${synthetic.id}`, undefined, "DELETE")
    await a.waitForFunction("Object.keys(call.participants()).length === 1")
    await a.evaluate("call.destroy()")
    expect(await (await h.api("/__admin/rooms/fixture/participants")).json()).toEqual([])
  } finally {
    await browser.close()
  }
}, 30_000)
