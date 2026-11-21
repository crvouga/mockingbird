import { describe, expect, test } from "bun:test"
import { createRuntime } from "./src/runtime.js"

const admin = (mode: string) =>
  new Request("http://mock/__admin/upstream", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  })
const api = (path: string, init?: RequestInit) =>
  new Request(`http://mock${path}`, {
    ...init,
    headers: { "x-vital-api-key": "sk_us_emulated", ...init?.headers },
  })

describe("upstream forwarding", () => {
  test("forward mode sends /v2 and /v3 API calls to baseUrl + path", async () => {
    const sent: Request[] = []
    const runtime = createRuntime({
      upstream: {
        baseUrl: "https://vendor.example/junction",
        fetch: async (request) => {
          sent.push(request)
          return Response.json({ from: "sandbox" }, { status: 200 })
        },
        rewriteAuth: (request) => {
          const out = new Request(request)
          out.headers.delete("x-vital-api-key")
          return out
        },
      },
    })
    expect((await runtime.fetch(admin("forward"))).status).toBe(200)
    const providers = await runtime.fetch(api("/v2/providers?source_type=lab"))
    expect(providers.status).toBe(200)
    expect(await providers.json()).toEqual({ from: "sandbox" })
    const order = await runtime.fetch(
      api("/v3/order", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_id: "u1" }),
      }),
    )
    expect(order.status).toBe(200)
    expect(sent.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET https://vendor.example/junction/v2/providers?source_type=lab",
      "POST https://vendor.example/junction/v3/order",
    ])
    expect(await sent[1]?.json()).toEqual({ user_id: "u1" })
    expect(sent[0]?.headers.has("x-vital-api-key")).toBe(false)
  })

  test("non-API paths never forward (501); admin routes stay local", async () => {
    let calls = 0
    const runtime = createRuntime({
      upstream: {
        baseUrl: "https://vendor.example",
        mode: "forward",
        fetch: async () => {
          calls++
          return Response.json({})
        },
      },
    })
    for (const path of ["/", "/v1/user", "/docs", "/link/abc"])
      expect((await runtime.fetch(api(path))).status).toBe(501)
    expect(calls).toBe(0)
    expect((await runtime.fetch(new Request("http://mock/__admin/health"))).status).toBe(200)
  })

  test("without upstream, forward mode is refused with 409", async () => {
    const runtime = createRuntime()
    expect((await runtime.fetch(admin("forward"))).status).toBe(409)
    expect(await (await runtime.fetch(new Request("http://mock/__admin/upstream"))).json()).toEqual(
      { mode: "emulated" },
    )
  })
})
