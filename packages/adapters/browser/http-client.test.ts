import { expect, test } from "bun:test"
import { once } from "node:events"
import { createFetchHttpClient } from "./src/http-client.js"

test("outgoing Node HTTP uses the supplied Fetch port and preserves request and streamed response", async () => {
  const client = createFetchHttpClient(async (input, init) => {
    const request = new Request(input, init)
    expect(request.url).toBe("https://fixture.test/message")
    expect(request.method).toBe("POST")
    expect(request.headers.get("authorization")).toBe("Bearer fixture")
    expect(await request.text()).toBe("payload")
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("answer"))
          controller.close()
        },
      }),
      { status: 201 },
    )
  }, "https:")
  const request = client.request({
    hostname: "fixture.test",
    path: "/message",
    method: "POST",
    headers: { authorization: "Bearer fixture" },
  })
  const response = once(request, "response")
  request.end("payload")
  const [incoming] = await response
  const chunks: Buffer[] = []
  for await (const chunk of incoming) chunks.push(chunk)
  expect(incoming.statusCode).toBe(201)
  expect(Buffer.concat(chunks).toString()).toBe("answer")
})

test("outgoing request failures and aborts reach Node error listeners", async () => {
  const client = createFetchHttpClient(async () => {
    throw new Error("network refused")
  })
  const request = client.get("https://fixture.test")
  expect((await once(request, "error"))[0].message).toBe("network refused")
  let aborted = false
  const slow = createFetchHttpClient(
    async (_input, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => {
          aborted = true
          reject(new Error("aborted"))
        }),
      ),
  )
  const pending = slow.get("https://fixture.test")
  const error = once(pending, "error")
  pending.abort()
  expect((await error)[0].code).toBe("ECONNRESET")
  expect(aborted).toBe(true)
})

test("aborting after response headers cancels the response producer", async () => {
  let cancelled = false
  const client = createFetchHttpClient(
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true
          },
        }),
      ),
  )
  const request = client.get("https://fixture.test/stream")
  const [incoming] = await once(request, "response")
  const error = once(request, "error")
  request.abort()
  await error
  await Bun.sleep(0)
  expect(incoming.destroyed).toBe(true)
  expect(cancelled).toBe(true)
})

test("a response arriving after request abort is cancelled without being emitted", async () => {
  let complete!: (response: Response) => void
  let cancelled = false
  let received = false
  const client = createFetchHttpClient(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  const request = client.get("https://fixture.test/late")
  request.on("response", () => {
    received = true
  })
  const error = once(request, "error")
  request.abort()
  await error
  complete(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true
        },
      }),
    ),
  )
  await Bun.sleep(0)
  expect(received).toBe(false)
  expect(cancelled).toBe(true)
})
