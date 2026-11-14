import { expect, test } from "bun:test"
import { eventFrame, headerString, readFrames } from "./src/eventstream.js"
import { createRuntime } from "./src/index.js"

for (const kind of ["transcribe", "polly"] as const) {
  test(`${kind} responds before input closes and cancels pending input`, async () => {
    const runtime = createRuntime()
    await runtime.fetch(
      new Request("http://speech/__admin/transcripts", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          match: { any: true },
          partials: ["fixture partial"],
          final: "fixture final",
        }),
      }),
    )
    let input!: ReadableStreamDefaultController<Uint8Array>
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        input = controller
      },
      cancel() {
        cancelled = true
      },
    })
    const headers =
      kind === "transcribe"
        ? {
            "x-amzn-transcribe-language-code": "en-US",
            "x-amzn-transcribe-sample-rate": "16000",
            "x-amzn-transcribe-media-encoding": "pcm",
          }
        : { "x-amzn-voiceid": "Ruth", "x-amzn-engine": "generative", "x-amzn-outputformat": "pcm" }
    const response = await runtime.fetch(
      new Request(
        `http://speech${kind === "transcribe" ? "/stream-transcription" : "/v1/synthesisStream"}`,
        {
          method: "POST",
          headers,
          body,
          ...{ duplex: "half" },
        },
      ),
    )
    expect(response.status).toBe(200)
    input.enqueue(
      kind === "transcribe"
        ? eventFrame("AudioEvent", new Uint8Array(3200))
        : eventFrame("TextEvent", { Text: "Hello" }),
    )
    const frames = readFrames(response.body)
    const first = await frames.next()
    expect(first.done).toBe(false)
    if (first.done) throw new Error("missing streamed response")
    expect(headerString(first.value, ":event-type")).toBe(
      kind === "transcribe" ? "TranscriptEvent" : "AudioEvent",
    )
    await frames.return(undefined)
    await response.body?.cancel()
    await Promise.resolve()
    expect(cancelled).toBe(true)
  }, 2000)
}

test("Polly CloseStreamEvent finishes an otherwise open input", async () => {
  const runtime = createRuntime()
  let input!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      input = c
    },
  })
  const response = await runtime.fetch(
    new Request("http://speech/v1/synthesisStream", {
      method: "POST",
      body,
      ...{ duplex: "half" },
      headers: {
        "x-amzn-voiceid": "Ruth",
        "x-amzn-engine": "generative",
        "x-amzn-outputformat": "pcm",
      },
    }),
  )
  input.enqueue(eventFrame("TextEvent", { Text: "Fixture" }))
  input.enqueue(eventFrame("CloseStreamEvent", {}))
  const events: string[] = []
  for await (const frame of readFrames(response.body))
    events.push(headerString(frame, ":event-type") ?? "")
  expect(events).toContain("AudioEvent")
  expect(events.at(-1)).toBe("StreamClosedEvent")
  input.close()
}, 2000)
