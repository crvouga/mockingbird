import { expect, test } from "bun:test"
import { HermesAPI } from "./src/index.js"

test("unimplemented peer operations remain explicit", async () => {
  const api = new HermesAPI()
  for (const [method, path] of [
    ["GET", "/v1/runs/example/events"],
    ["POST", "/v1/runs/example/approval"],
    ["POST", "/v1/runs/example/steer"],
  ] as const) {
    const response = await api.fetch(new Request(`http://hermes.local${path}`, { method }))
    expect(response.status).toBe(501)
    expect(await response.json()).toMatchObject({
      error: { type: "mockingbird_unsupported", code: "operation_not_implemented" },
    })
  }
  const missing = await api.fetch(new Request("http://hermes.local/missing"))
  expect(missing.status).toBe(404)
})
