import { expect, test } from "bun:test"
import { eventFrame, payloadJson, readFrames } from "./src/eventstream.js"
import { createRuntime } from "./src/index.js"

test("Nova Sonic answers a turn before input closes and cancels its input reader", async () => {
  const runtime = createRuntime()
  let input!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      input = c
    },
    cancel() {
      cancelled = true
    },
  })
  const response = await runtime.fetch(
    new Request("http://bedrock/model/amazon.nova-sonic-v1:0/invoke-with-bidirectional-stream", {
      method: "POST",
      body,
      ...{ duplex: "half" },
    }),
  )
  expect(response.status).toBe(200)
  for (const event of [
    { sessionStart: {} },
    { promptStart: { promptName: "p" } },
    {
      contentStart: {
        promptName: "p",
        contentName: "t",
        type: "TEXT",
        role: "USER",
        interactive: true,
      },
    },
    { textInput: { promptName: "p", contentName: "t", content: "hello" } },
    { contentEnd: { promptName: "p", contentName: "t" } },
  ])
    input.enqueue(eventFrame("chunk", { bytes: btoa(JSON.stringify({ event })) }))
  const frames = readFrames(response.body)
  const types = new Set<string>()
  for await (const frame of frames) {
    const payload = payloadJson(frame) as { bytes: string }
    const event = JSON.parse(atob(payload.bytes)).event
    for (const key of Object.keys(event)) types.add(key)
    if (types.has("usageEvent")) break
  }
  expect(types.has("textOutput")).toBe(true)
  expect(types.has("audioOutput")).toBe(true)
  expect(types.has("usageEvent")).toBe(true)
  await response.body?.cancel()
  await Promise.resolve()
  expect(cancelled).toBe(true)
}, 2000)
