import { expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import {
  FleetClient,
  FleetClientError,
  FleetClientResponseError,
  renderConnections,
} from "./src/fleet-client.js"
import type { EndpointManifest } from "./src/fleet-manifest.js"

const listen = (server: Server): Promise<string> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    )
  })
const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))

test("control redirects never forward synthetic admin keys across origins for every redirect status (#452)", async () => {
  let received = 0
  const destination = createServer((_req, res) => {
    received++
    res.end("{}")
  })
  const base = await listen(destination)
  let status = 301
  const source = createServer((_req, res) => {
    res.writeHead(status, { location: `${base}/?private=omitted` })
    res.end()
  })
  const origin = await listen(source)
  try {
    for (status of [301, 302, 303, 307, 308]) {
      const error = await new FleetClient(origin, { adminKey: "synthetic-admin" })
        .request("namespaces", { body: {} })
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(FleetClientResponseError)
      expect((error as FleetClientResponseError).status).toBe(status)
      expect((error as FleetClientResponseError).code).toBe("redirect")
      expect((error as FleetClientResponseError).details).toMatchObject({ origin })
      expect(String(error)).not.toContain("private")
    }
    expect(received).toBe(0)
  } finally {
    await close(source)
    await close(destination)
  }
})

test("client bounds JSON diagnostics, preserves proxy statuses, accepts empty responses, and rejects malformed success (#461)", async () => {
  const client = (response: () => Response) =>
    new FleetClient("https://control.example.test", {
      fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.redirect).toBe("manual")
        return response()
      }) as unknown as typeof fetch,
    })
  for (const body of ["<html>private diagnostic</html>", "", "invalid json"]) {
    const error = await client(() => new Response(body, { status: 502 }))
      .discover()
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FleetClientError)
    expect((error as FleetClientError).status).toBe(502)
    expect(String(error)).not.toContain("private diagnostic")
  }
  const error = await client(() =>
    Response.json(
      { error: { type: "mockingbird_admin", code: "conflict", message: "secret diagnostic" } },
      { status: 409 },
    ),
  )
    .discover()
    .catch((e: unknown) => e)
  expect((error as FleetClientError).details).toEqual({
    type: "mockingbird_admin",
    code: "conflict",
    body: "omitted",
  })
  expect(await client(() => new Response(null, { status: 204 })).request("empty")).toBeUndefined()
  await expect(client(() => new Response("{")).discover()).rejects.toMatchObject({
    code: "invalid_json",
    status: 200,
  })
})

test("declared/chunked excess cancels bodies; caller abort and deadline both interrupt reads (#461)", async () => {
  for (const declared of [false, true]) {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('"123456789"'))
      },
      cancel() {
        cancelled = true
      },
    })
    const client = new FleetClient("https://control.example.test", {
      maxResponseBytes: 5,
      fetch: (async () =>
        new Response(stream, {
          headers: declared ? { "content-length": "11" } : {},
        })) as unknown as typeof fetch,
    })
    await expect(client.discover()).rejects.toMatchObject({
      code: "response_too_large",
      status: 200,
    })
    expect(cancelled).toBe(true)
  }
  for (const callerAborts of [false, true]) {
    let cancelled = false
    const controller = new AbortController()
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })
    const client = new FleetClient("https://control.example.test", {
      timeoutMs: callerAborts ? 1000 : 10,
      fetch: (async () => new Response(stream)) as unknown as typeof fetch,
    })
    const result = client.request("", { signal: controller.signal })
    if (callerAborts) controller.abort(new Error("synthetic cancellation"))
    await expect(result).rejects.toThrow()
    expect(cancelled).toBe(true)
  }
  await expect(
    new FleetClient("https://control.example.test", { maxResponseBytes: 0 }).discover(),
  ).rejects.toThrow("byte limit")
})

test("explicit private connection components decode credentials and IPv6 without guessing absent values (#456)", () => {
  const manifest = { services: { redis: { protocol: "redis" } } } as unknown as EndpointManifest
  const privateManifest = {
    version: 1 as const,
    services: {
      redis: {
        url: "redis://localhost",
        namespaces: { alpha: "redis://user%40name:p%3Ass@[::1]:6389/12" },
      },
    },
  }
  const mapping = {
    URL: { service: "redis" },
    HOST: { service: "redis", field: "hostname" as const },
    PORT: { service: "redis", field: "port" as const },
    USER: { service: "redis", field: "username" as const },
    PASSWORD: { service: "redis", field: "password" as const },
    DB: { service: "redis", field: "database" as const },
  }
  expect(renderConnections(manifest, privateManifest, "alpha", mapping)).toEqual({
    URL: privateManifest.services.redis.namespaces.alpha,
    HOST: "::1",
    PORT: "6389",
    USER: "user@name",
    PASSWORD: "p:ss",
    DB: "12",
  })
  expect(() => renderConnections(manifest, privateManifest, "missing", mapping)).toThrow(
    "namespace mapping",
  )
  expect(() =>
    renderConnections(manifest, privateManifest, "alpha", {
      BAD: { service: "redis", field: "unknown" as "url" },
    }),
  ).toThrow("unsupported")
  const bare = {
    version: 1 as const,
    services: { redis: { url: "redis://localhost", namespaces: { alpha: "redis://localhost" } } },
  }
  expect(() =>
    renderConnections(manifest, bare, "alpha", {
      PASSWORD: { service: "redis", field: "password" },
    }),
  ).toThrow("missing connection component")
  expect(
    renderConnections(manifest, bare, "alpha", {
      PASSWORD: { service: "redis", field: "password", fallback: "" },
    }),
  ).toEqual({ PASSWORD: "" })
})
