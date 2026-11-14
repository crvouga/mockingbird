import { expect, test } from "bun:test"
import { loadPreviewArtifact } from "./src/preview/artifacts.js"
import { attachPreviewHost, createPreviewClient } from "./src/preview/bridge.js"
import { startPreviewHarness } from "./src/preview/harness.js"
import { createPreviewHost } from "./src/preview/host.js"

test("bridge streams before completion, cancels, and isolates connections", async () => {
  let cancelled = false
  const host = createPreviewHost(() => ({
    fetch: (request) => {
      if (new URL(request.url).pathname === "/stream")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first"))
            },
            cancel() {
              cancelled = true
            },
          }),
        )
      return new Response(request.headers.get("cookie") ?? "no cookies")
    },
    dispose() {},
  }))
  const a = new MessageChannel(),
    b = new MessageChannel()
  host.connect(a.port1)
  host.connect(b.port1)
  const first = createPreviewClient(a.port2),
    second = createPreviewClient(b.port2)
  try {
    await host.ready
    const response = await first.fetch("http://localhost/stream")
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Missing response body")
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first")
    await reader.cancel()
    await Bun.sleep(10)
    expect(cancelled).toBe(true)
    first.dispose()
    expect(await (await second.fetch("http://localhost/")).text()).toBe("no cookies")
    await host.reset()
    expect(host.state()).toEqual({ generation: 2, status: "ready" })
  } finally {
    first.dispose()
    second.dispose()
    await host.dispose()
  }
})

test("bridge propagates throws, stream errors, abort and deadlines", async () => {
  const channel = new MessageChannel()
  const host = attachPreviewHost(channel.port1, (request) => {
    switch (new URL(request.url).pathname) {
      case "/throw":
        throw new Error("before headers")
      case "/error":
        return new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error("after headers"))
            },
          }),
        )
      default:
        return new Promise<Response>((_, reject) =>
          request.signal.addEventListener("abort", () => reject(request.signal.reason)),
        )
    }
  })
  const client = createPreviewClient(channel.port2, { timeoutMs: 100 })
  try {
    await expect(client.fetch("http://localhost/throw")).rejects.toThrow("before headers")
    await expect((await client.fetch("http://localhost/error")).text()).rejects.toThrow(
      "after headers",
    )
    const abort = new AbortController()
    const pending = client.fetch("http://localhost/hang", { signal: abort.signal })
    abort.abort()
    await expect(pending).rejects.toThrow()
    await expect(client.fetch("http://localhost/hang")).rejects.toThrow("deadline")
  } finally {
    client.dispose()
    host.dispose()
  }
})

test("artifact loader rejects missing, stale and incompatible artifacts", async () => {
  const bytes = new TextEncoder().encode("export default 42")
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  const artifact = { version: 1 as const, sha256, url: "https://example.test/worker.js" }
  expect(await loadPreviewArtifact(artifact, async () => new Response(bytes))).toEqual(bytes)
  await expect(loadPreviewArtifact(artifact, async () => new Response("wrong"))).rejects.toThrow(
    "identity",
  )
  await expect(
    loadPreviewArtifact(artifact, async () => new Response(null, { status: 404 })),
  ).rejects.toThrow("404")
  await expect(loadPreviewArtifact({ ...artifact, version: 2 as 1 })).rejects.toThrow("version")
})

test("Node harness calls the same worker bridge with streaming and cache-safe delivery", async () => {
  const channel = new MessageChannel()
  const host = attachPreviewHost(channel.port1, () => new Response("shared world"))
  const client = createPreviewClient(channel.port2)
  const harness = await startPreviewHarness(client.fetch, { origin: "http://localhost:3000" })
  try {
    const response = await fetch(harness.url)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.text()).toBe("shared world")
  } finally {
    await harness.close()
    client.dispose()
    host.dispose()
  }
})

test("host disposal terminates pending bodies and reset recovers from startup failure", async () => {
  const host = createPreviewHost((generation) => {
    if (generation === 1) throw new Error("startup failed")
    return { fetch: () => new Response(new ReadableStream()), dispose() {} }
  })
  await expect(host.ready).rejects.toThrow("startup failed")
  expect(host.state().status).toBe("error")
  await host.reset()
  const channel = new MessageChannel()
  host.connect(channel.port1)
  const client = createPreviewClient(channel.port2)
  try {
    const body = (await client.fetch("http://localhost/")).text()
    await host.dispose()
    await expect(body).rejects.toThrow("disconnected")
    await expect(host.reset()).rejects.toThrow("disposed")
  } finally {
    client.dispose()
    await host.dispose()
  }
})

test("bridge leaves redirects and session cookies explicit", async () => {
  const channel = new MessageChannel()
  const host = attachPreviewHost(
    channel.port1,
    (request) =>
      new Response(request.headers.get("cookie"), {
        status: 302,
        headers: [
          ["location", "/next"],
          ["set-cookie", "a=one; Path=/"],
          ["set-cookie", "b=two; Path=/"],
        ],
      }),
  )
  const client = createPreviewClient(channel.port2)
  try {
    const first = await client.fetch("http://localhost/", { headers: { cookie: "session=one" } })
    expect(first.status).toBe(302)
    expect(first.headers.get("location")).toBe("/next")
    expect(first.headers.getSetCookie()).toEqual(["a=one; Path=/", "b=two; Path=/"])
    expect(await first.text()).toBe("session=one")
    expect(await (await client.fetch("http://localhost/")).text()).toBe("")
  } finally {
    client.dispose()
    host.dispose()
  }
})

test("compressed worker artifact identity is measured after decompression", async () => {
  const bytes = new TextEncoder().encode("export default 42")
  const artifact = {
    version: 1 as const,
    url: "https://preview.test/worker.gz",
    compression: "gzip" as const,
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
  }
  expect(
    await loadPreviewArtifact(artifact, async () => new Response(Bun.gzipSync(bytes))),
  ).toEqual(bytes)
})

test("successful responses do not abort handlers and disconnect cleanup runs once", async () => {
  const channel = new MessageChannel()
  let signal: AbortSignal | undefined
  let disconnects = 0
  const host = attachPreviewHost(
    channel.port1,
    (request) => {
      signal = request.signal
      return new Response("complete")
    },
    {
      onDisconnect: () => {
        disconnects++
      },
    },
  )
  const client = createPreviewClient(channel.port2)
  try {
    expect(await (await client.fetch("http://localhost/")).text()).toBe("complete")
    expect(signal?.aborted).toBe(false)
    client.dispose()
    await Bun.sleep(10)
    host.dispose()
    expect(disconnects).toBe(1)
  } finally {
    client.dispose()
    host.dispose()
  }
})
