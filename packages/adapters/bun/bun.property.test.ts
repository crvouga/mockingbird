import { expect, test } from "bun:test"
import type { FetchAPI } from "@crvouga/mockingbird-core"
import fc from "fast-check"
import { serve } from "./src/index.js"

const webUrl = fc.webUrl().filter((raw) => {
  const parsed = new URL(raw)
  return !parsed.pathname.startsWith("//") && parsed.username === "" && parsed.hash === ""
})

const bodyfulStatus = fc
  .integer({ min: 200, max: 599 })
  .filter((status) => status !== 204 && status !== 205 && status !== 304)

test("serve ∘ fetch round-trips requests over Bun.serve", async () => {
  const api: FetchAPI = {
    fetch: async (request) =>
      new Response(request.url, { status: Number(request.headers.get("x-status") ?? 200) }),
  }
  const server = serve(api)
  try {
    await fc.assert(
      fc.asyncProperty(webUrl, bodyfulStatus, async (url, status) => {
        const parsed = new URL(url)
        const target = new URL(parsed.href)
        target.protocol = "http:"
        target.host = `localhost:${server.port}`
        const response = await fetch(target, { headers: { "x-status": String(status) } })
        expect(response.status).toBe(status)
        expect(await response.text()).toBe(target.href)
      }),
    )
  } finally {
    server.stop()
  }
})
