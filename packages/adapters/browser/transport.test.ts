import { expect, test } from "bun:test"
import { once } from "node:events"
import { createHttpAdapter } from "./src/http.js"
import { createVirtualNetwork } from "./src/net.js"
import { createBrowserRuntime } from "./src/runtime.js"

test("HTTP delivers SSE before end, applies backpressure and propagates cancellation", async () => {
  const world = createBrowserRuntime()
  const http = createHttpAdapter(world)
  let closed = false
  let written = false
  const server = http
    .createServer((_req, res) => {
      res.once("close", () => {
        closed = true
      })
      res.setHeader("content-type", "text/event-stream")
      res.flushHeaders()
      res.write("data: first\n\n", () => {
        written = true
      })
    })
    .listen(0)
  try {
    const response = await world.fetch(`http://localhost:${server.address()?.port}`)
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(written).toBe(false)
    if (!response.body) throw new Error("Expected streamed body")
    const reader = response.body.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(written).toBe(true)
    await reader.cancel()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(closed).toBe(true)
  } finally {
    server.close()
    world.dispose()
  }
})

test("HTTP rejects errors before headers and errors streamed bodies after headers", async () => {
  for (const started of [false, true]) {
    const world = createBrowserRuntime()
    const server = createHttpAdapter(world)
      .createServer((_req, res) => {
        if (started) res.flushHeaders()
        throw new Error("handler failed")
      })
      .listen(0)
    try {
      const response = world.fetch(`http://localhost:${server.address()?.port}`)
      if (started) await expect((await response).text()).rejects.toThrow("handler failed")
      else await expect(response).rejects.toThrow("handler failed")
    } finally {
      server.close()
      world.dispose()
    }
  }
})

test("HTTP abort after headers closes both sides and preserves cookie and no-body semantics", async () => {
  const world = createBrowserRuntime()
  let closed = false
  const server = createHttpAdapter(world)
    .createServer((req, res) => {
      res.setHeader("set-cookie", ["a=one; HttpOnly", "b=two; Secure"])
      expect(res.getHeader("set-cookie")).toEqual(["a=one; HttpOnly", "b=two; Secure"])
      if (req.url === "/empty") {
        res.statusCode = 204
        res.end("discarded")
        return
      }
      if (req.method === "HEAD") {
        res.end("discarded")
        return
      }
      req.once("aborted", () => {
        closed = true
      })
      res.flushHeaders()
    })
    .listen(0)
  const url = `http://localhost:${server.address()?.port}`
  try {
    expect(await (await world.fetch(`${url}/empty`)).text()).toBe("")
    expect(await (await world.fetch(url, { method: "HEAD" })).text()).toBe("")
    const controller = new AbortController()
    const response = await world.fetch(url, { signal: controller.signal })
    expect(response.headers.getSetCookie()).toEqual(["a=one; HttpOnly", "b=two; Secure"])
    controller.abort()
    await expect(response.text()).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(closed).toBe(true)
  } finally {
    server.close()
    world.dispose()
  }
})

test("virtual TCP isolates worlds, supports Duplex bytes, collision/refusal and disposal", async () => {
  const first = createVirtualNetwork()
  const second = createVirtualNetwork()
  const servers = [first, second].map((world, index) =>
    world
      .createServer((socket) => {
        socket.on("error", () => undefined)
        socket.on("data", (bytes) => socket.end(`${index}:${String(bytes)}`))
      })
      .listen(5000),
  )
  try {
    expect(() => first.createServer().listen(5000)).toThrow("in use")
    for (const [index, world] of [first, second].entries()) {
      const client = world.connect(5000)
      const data = once(client, "data")
      client.write("hello")
      expect(String((await data)[0])).toBe(`${index}:hello`)
      client.destroy()
    }
    const absent = first.connect(5999)
    expect((await once(absent, "error"))[0].code).toBe("ECONNREFUSED")
    const external = first.connect(443, "example.com")
    expect((await once(external, "error"))[0].code).toBe("ENETUNREACH")
    expect(first.createServer().listen(0).address()?.port).toBeGreaterThan(0)
  } finally {
    for (const server of servers) server.close()
    first.dispose()
    second.dispose()
  }
  const disposed = first.connect(5000)
  expect((await once(disposed, "error"))[0].code).toBe("ECONNREFUSED")
})

test("virtual TCP holds the writer until the peer drains", async () => {
  const world = createVirtualNetwork()
  let accepted: InstanceType<typeof world.Socket> | undefined
  const server = world
    .createServer((socket) => {
      accepted = socket
    })
    .listen(0)
  const client = world.connect(server.address()?.port)
  await once(client, "connect")
  let written = false
  client.write(Buffer.alloc(1024 * 1024), () => {
    written = true
  })
  expect(written).toBe(false)
  if (!accepted) throw new Error("Expected connected peer")
  accepted.resume()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(written).toBe(true)
  world.dispose()
})

test("world disposal terminates active HTTP streams and TCP/HTTP ports cannot collide", async () => {
  const world = createBrowserRuntime()
  const tcp = world.net.createServer().listen(6100)
  expect(() => world.bun.serve({ port: 6100, fetch: () => new Response() })).toThrow(
    "Address in use",
  )
  const http = createHttpAdapter(world)
    .createServer((_request, response) => response.flushHeaders())
    .listen(6101)
  expect(() => world.net.createServer().listen(6101)).toThrow("in use")
  const response = await world.fetch("http://localhost:6101")
  world.dispose()
  await expect(response.text()).rejects.toThrow()
  expect(tcp.listening).toBe(false)
  http.close()
})

test("explicit loopback DNS adapter honors all/family and refuses external resolution and TLS", async () => {
  const { lookup } = await import("./src/network/dns.js")
  const resolve = (host: string, options: unknown) =>
    new Promise((resolve, reject) =>
      lookup(host, options, (error, address, family) =>
        error ? reject(error) : resolve({ address, family }),
      ),
    )
  expect(await resolve("localhost", { all: true })).toEqual({
    address: [{ address: "127.0.0.1", family: 4 }],
    family: undefined,
  })
  expect(await resolve("localhost", { family: 6 })).toEqual({ address: "::1", family: 6 })
  await expect(resolve("example.com", {})).rejects.toThrow("external dns.lookup")
  await expect(resolve("localhost", { verbatim: true })).rejects.toThrow("option verbatim")
  await expect(resolve("127.0.0.1", { family: 6 })).rejects.toThrow("requested family")
  const tls = await import("./src/network/tls.js")
  expect(() => tls.connect()).toThrow("tls.connect")
})
