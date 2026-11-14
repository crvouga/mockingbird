import { expect, test } from "bun:test"
import { createBrowserRuntime, UnsupportedRuntimeError } from "./src/index.js"

test("Bun and Deno share files, isolate worlds, and expose missing-file errors", async () => {
  const first = createBrowserRuntime()
  const second = createBrowserRuntime()
  await first.deno.mkdir("/app")
  expect(await first.bun.write("/app/data", "hello")).toBe(5)
  expect(await first.deno.readTextFile("/app/data")).toBe("hello")
  const entries = []
  for await (const entry of first.deno.readDir("/app")) entries.push(entry)
  expect(entries).toEqual([{ name: "data", isFile: true, isDirectory: false, isSymlink: false }])
  await first.deno.writeTextFile("/app/data", "updated")
  expect(await first.bun.file("/app/data").text()).toBe("updated")
  expect(await second.bun.file("/app/data").exists()).toBe(false)
  await expect(second.deno.readTextFile("/app/data")).rejects.toThrow()
  first.dispose()
  second.dispose()
})

test("virtual servers route requests, reject collisions and fail after shutdown without network fallback", async () => {
  const runtime = createBrowserRuntime()
  const server = runtime.bun.serve({
    port: 8080,
    fetch: async (request) => new Response(await request.text(), { status: 201 }),
  })
  expect(() => runtime.deno.serve({ port: 8080 }, () => new Response())).toThrow("Address in use")
  const response = await runtime.fetch("http://127.0.0.1:8080/", {
    method: "POST",
    body: "payload",
  })
  expect(response.status).toBe(201)
  expect(await response.text()).toBe("payload")
  server.stop()
  await server.finished
  await expect(runtime.fetch("http://localhost:8080")).rejects.toThrow("no browser-local server")
  await expect(runtime.fetch("https://example.test")).rejects.toThrow("disabled")
  runtime.dispose()
})

test("virtual server cancellation and unsupported APIs fail explicitly", async () => {
  const runtime = createBrowserRuntime({ env: { EXPLICIT: "yes" } })
  expect(runtime.deno.env.toObject()).toEqual({ EXPLICIT: "yes" })
  expect(() => Reflect.get(runtime.bun, "spawn")).toThrow(UnsupportedRuntimeError)
  const server = runtime.deno.serve({ port: 0 }, () => new Promise(() => {}))
  const controller = new AbortController()
  const pending = runtime.fetch(server.url, { signal: controller.signal })
  controller.abort(new Error("cancelled"))
  await expect(pending).rejects.toThrow("cancelled")
  runtime.dispose()
  await server.finished
  await expect(runtime.fetch(server.url)).rejects.toThrow("disposed")
})
