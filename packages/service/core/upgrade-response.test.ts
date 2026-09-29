import { expect, test } from "bun:test"
import { annotateResponse, createRuntime } from "./src/index.js"

test("Node upgrade admission records wire status without a mutation checkpoint", async () => {
  const runtime = createRuntime({
    name: "upgrade-fixture",
    create: () => ({
      reset: async () => {},
      fetch: async () => annotateResponse(new Response(null), { wireStatus: 101 }),
    }),
  })
  const before = runtime.checkpoint()
  const response = await runtime.fetch(new Request("http://mock/attach", { method: "POST" }))
  expect(response.status).toBe(200)
  expect(runtime.timeline().head("main")?.id).toBe(before.id)
  expect(runtime.journal.list()).toMatchObject([{ status: 101 }])
})
