import { expect, test } from "bun:test"
import fc from "fast-check"
import { fromFetchHandler, toFetchHandler } from "./src/index.js"

test("toFetchHandler ∘ fromFetchHandler preserves responses", async () => {
  await fc.assert(
    fc.asyncProperty(fc.webUrl(), fc.integer({ min: 200, max: 599 }), async (url, status) => {
      const handler = async (request: Request) =>
        new Response(request.url, { status, headers: { "x-status": String(status) } })
      const roundTripped = toFetchHandler(fromFetchHandler(handler))
      const response = await roundTripped(new Request(url))
      expect(response.status).toBe(status)
      expect(await response.text()).toBe(new Request(url).url)
    }),
  )
})
