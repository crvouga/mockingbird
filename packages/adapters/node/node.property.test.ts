import { expect, test } from "bun:test"
import type { FetchAPI } from "@crvouga/mockingbird-core"
import fc from "fast-check"
import { serve } from "./src/index.js"

type Echo = { method: string; url: string; echoed: string }

const webUrl = fc.webUrl().filter((raw) => {
  const parsed = new URL(raw)
  return !parsed.pathname.startsWith("//") && parsed.username === "" && parsed.hash === ""
})

const bodyfulStatus = fc
  .integer({ min: 200, max: 599 })
  .filter((status) => status !== 204 && status !== 205 && status !== 304)

test("serve ∘ fetch round-trips requests over node:http", async () => {
  const api: FetchAPI = {
    fetch: async (request) => {
      const echoed = await request.text()
      return new Response(JSON.stringify({ method: request.method, url: request.url, echoed }), {
        status: Number(request.headers.get("x-status") ?? 200),
        headers: { "content-type": "application/json" },
      })
    },
  }
  const server = await serve(api)
  try {
    const address = server.address()
    const port = typeof address === "object" && address !== null ? address.port : 0
    await fc.assert(
      fc.asyncProperty(
        webUrl,
        bodyfulStatus,
        fc.constantFrom("GET", "POST"),
        async (url, status, method) => {
          const parsed = new URL(url)
          const target = new URL(parsed.href)
          target.protocol = "http:"
          target.host = `localhost:${port}`
          const init: RequestInit = { method, headers: { "x-status": String(status) } }
          if (method === "POST") {
            init.body = "payload-123"
          }
          const response = await fetch(target, init)
          expect(response.status).toBe(status)
          const payload = (await response.json()) as Echo
          expect(payload.method).toBe(method)
          expect(payload.url).toBe(target.href)
          expect(payload.echoed).toBe(method === "POST" ? "payload-123" : "")
        },
      ),
    )
  } finally {
    server.close()
    server.closeAllConnections()
  }
})
