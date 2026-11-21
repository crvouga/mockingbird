import { afterEach, expect, test } from "bun:test"
import { createPreviewClient, type PreviewFetch, servePreviewPort } from "./src/bridge.js"
import { createPreviewHost, sharedPreviewWorkerName } from "./src/host.js"
import { listenPreview } from "./src/node.js"

const disposers: (() => unknown)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})
const pair = (handle: PreviewFetch, timeoutMs = 1000) => {
  const channel = new MessageChannel()
  const server = servePreviewPort(channel.port1, handle)
  const client = createPreviewClient(channel.port2, { timeoutMs })
  disposers.push(server.dispose, client.dispose)
  return { server, client }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 10))
test("concurrent request bytes and headers remain paired, redirects remain manual", async () => {
  const { client } = pair(async (request) => {
    if (new URL(request.url).pathname === "/redirect")
      return new Response(null, {
        status: 302,
        headers: { location: "https://forbidden.test", "set-cookie": "private=yes" },
      })
    await tick()
    return Response.json({
      text: await request.text(),
      marker: request.headers.get("x-marker"),
      cookie: request.headers.get("cookie"),
    })
  })
  const results = await Promise.all(
    ["one", "two"].map(async (text) =>
      (
        await client.fetch("http://app.test/", {
          method: "POST",
          body: text,
          headers: { "x-marker": text, cookie: "browser=secret" },
        })
      ).json(),
    ),
  )
  expect(results).toEqual([
    { text: "one", marker: "one", cookie: null },
    { text: "two", marker: "two", cookie: null },
  ])
  const redirected = await client.fetch("http://app.test/redirect")
  expect(redirected.status).toBe(302)
  expect(redirected.headers.get("set-cookie")).toBeNull()
  expect(redirected.headers.get("location")).toBe("https://forbidden.test")
})
test("stream first chunk arrives before completion; cancellation aborts remote request", async () => {
  let pulls = 0
  let cancelled = false
  let signal: AbortSignal | undefined
  const { client, server } = pair((request) => {
    signal = request.signal
    return new Response(
      new ReadableStream(
        {
          pull(controller) {
            pulls++
            controller.enqueue(new TextEncoder().encode("data: hello\n\n"))
          },
          cancel() {
            cancelled = true
          },
        },
        { highWaterMark: 0 },
      ),
    )
  })
  const response = await client.fetch("http://app.test/events")
  await tick()
  expect(pulls).toBe(0)
  if (!response.body) throw new Error("Missing response stream")
  const reader = response.body.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: hello\n\n")
  expect(pulls).toBe(1)
  await reader.cancel()
  await tick()
  expect(cancelled).toBe(true)
  expect(signal?.aborted).toBe(true)
  expect(server.active).toBe(0)
  expect(client.pending).toBe(0)
})
test("pre-header and post-header errors reject and do not become successful EOF", async () => {
  const { client } = pair((request) => {
    if (new URL(request.url).pathname === "/before") throw new Error("private server detail")
    return new Response(
      new ReadableStream(
        {
          pull(controller) {
            controller.error(new Error("private stream detail"))
          },
        },
        { highWaterMark: 0 },
      ),
    )
  })
  await expect(client.fetch("http://app.test/before")).rejects.toThrow("remote request failed")
  const response = await client.fetch("http://app.test/after")
  const error = await response.text().then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(error).toBeInstanceOf(Error)
  expect(String(error)).toContain("remote request failed")
  expect(client.pending).toBe(0)
})
test("request abort, deadline and host disposal terminate requests", async () => {
  const { client, server } = pair(() => new Promise(() => {}), 30)
  const abort = new AbortController()
  const request = client.fetch("http://app.test/", { signal: abort.signal })
  abort.abort()
  await expect(request).rejects.toThrow()
  await expect(client.fetch("http://app.test/")).rejects.toThrow("deadline exceeded")
  await tick()
  expect(server.active).toBe(0)
  const waiting = client.fetch("http://app.test/")
  server.dispose()
  await expect(waiting).rejects.toThrow("connection closed")
})
test("host clients share a generation; disconnect does not stop other clients; reset clears it", async () => {
  let stopped = 0
  const host = createPreviewHost({
    artifact: "sha256:fixture",
    boot: ({ generation }) => ({
      fetch: () => new Response(String(generation)),
      dispose: () => {
        stopped++
      },
    }),
  })
  disposers.push(host.dispose)
  const connect = () => {
    const channel = new MessageChannel()
    host.connect(channel.port1)
    const client = createPreviewClient(channel.port2)
    disposers.push(client.dispose)
    return client
  }
  const first = connect(),
    second = connect()
  expect(await (await first.fetch("http://app.test/")).text()).toBe("0")
  first.dispose()
  await tick()
  expect(host.status().clients).toBe(1)
  expect(await (await second.fetch("http://other-app.test/")).text()).toBe("0")
  await host.reset()
  expect(stopped).toBe(1)
  expect(await (await connect().fetch("http://app.test/")).text()).toBe("1")
  expect(host.status()).toMatchObject({ artifact: "sha256:fixture", generation: 1, state: "ready" })
  expect(sharedPreviewWorkerName({ application: "app", artifact: "a", generation: 1 })).not.toBe(
    sharedPreviewWorkerName({ application: "app", artifact: "b", generation: 1 }),
  )
})
test("the Node harness calls the same worker bridge and refuses cached assets", async () => {
  const { client } = pair(
    () => new Response("asset", { headers: { "cache-control": "public, immutable" } }),
  )
  const server = await listenPreview((request) => client.fetch(request))
  disposers.push(server.close)
  const response = await fetch(server.url)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(await response.text()).toBe("asset")
})
test("server validates targets even if the client omitted its allowlist", async () => {
  const channel = new MessageChannel()
  const server = servePreviewPort(channel.port1, () => new Response("unreachable"), {
    allow: (url) => url.hostname === "app.test",
  })
  const client = createPreviewClient(channel.port2)
  disposers.push(server.dispose, client.dispose)
  await expect(client.fetch("http://forbidden.test")).rejects.toThrow("remote request failed")
})

test("Node harness terminates a response on a late worker stream error and stays usable", async () => {
  const { client } = pair((request) => {
    if (new URL(request.url).pathname === "/healthy") return new Response("healthy")
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("started"))
          setTimeout(() => controller.error(new Error("late worker failure")), 20)
        },
      }),
    )
  })
  const server = await listenPreview((request) => client.fetch(request))
  disposers.push(server.close)
  const response = await fetch(server.url)
  const outcome = await response.text().then(
    () => "unexpected successful EOF",
    () => "terminated",
  )
  expect(outcome).toBe("terminated")
  expect(await (await fetch(`${server.url}/healthy`)).text()).toBe("healthy")
})
