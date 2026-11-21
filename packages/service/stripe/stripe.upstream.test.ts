import { describe, expect, test } from "bun:test"
import { createSandbox } from "@crvouga/mockingbird-preview"
import {
  createSandboxProxy,
  SANDBOX_KEY_HEADER,
  sandboxProviders,
} from "@crvouga/mockingbird-preview/sandbox-proxy"
import Stripe from "stripe"
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
    headers: { authorization: "Bearer sk_test_emulated", ...init?.headers },
  })

describe("upstream forwarding", () => {
  test("forward mode sends /v1 API calls to baseUrl + path", async () => {
    const sent: Request[] = []
    const runtime = createRuntime({
      upstream: {
        baseUrl: "https://vendor.example/stripe",
        fetch: async (request) => {
          sent.push(request)
          return Response.json({ id: "cus_vendor", object: "customer" }, { status: 200 })
        },
      },
    })
    expect((await runtime.fetch(admin("forward"))).status).toBe(200)
    expect(await (await runtime.fetch(new Request("http://mock/__admin/upstream"))).json()).toEqual(
      { mode: "forward", baseUrl: "https://vendor.example/stripe" },
    )
    const response = await runtime.fetch(
      api("/v1/customers?expand[]=default_source", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "email=ada%40example.test",
      }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: "cus_vendor", object: "customer" })
    expect(sent[0]?.url).toBe("https://vendor.example/stripe/v1/customers?expand[]=default_source")
    expect(sent[0]?.method).toBe("POST")
    expect(await sent[0]?.text()).toBe("email=ada%40example.test")
    // Nothing was created in the emulator.
    await runtime.fetch(admin("emulated"))
    const list = await (await runtime.fetch(api("/v1/customers"))).json()
    expect(list.data).toEqual([])
  })

  test("hosted pages and Stripe.js never forward (501)", async () => {
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
    for (const path of ["/c/pay/cs_test_123", "/v3", "/p/session/bps_123"]) {
      const response = await runtime.fetch(new Request(`http://mock${path}`))
      expect(response.status).toBe(501)
    }
    expect(calls).toBe(0)
    // Admin routes stay local.
    expect((await runtime.fetch(new Request("http://mock/__admin/health"))).status).toBe(200)
  })

  test("without upstream, forward mode is refused with 409", async () => {
    const runtime = createRuntime()
    expect((await runtime.fetch(admin("forward"))).status).toBe(409)
    expect((await runtime.fetch(api("/v1/customers"))).status).toBe(200)
  })
})

test("sandbox mode end to end: stripe-node → emulator → sandbox proxy → vendor, with the real key", async () => {
  const REAL_KEY = "sk_test_real-sandbox-account-fixture"
  const ACCESS = "viewer-key-fixture"
  const vendor: Request[] = []
  const proxy = createSandboxProxy({
    providers: [sandboxProviders.stripe],
    basePath: "/__sandbox",
    env: { SANDBOX_PROXY_TOKEN: ACCESS, STRIPE_SECRET_KEY: REAL_KEY },
    fetch: async (request) => {
      vendor.push(request.clone())
      return Response.json(
        { id: "cus_from_sandbox", object: "customer", email: "ada@example.test" },
        { headers: { "request-id": "req_sandbox" } },
      )
    },
  })
  const storage = new Map<string, string>()
  const sandbox = createSandbox({
    proxyUrl: "https://lab.example/__sandbox",
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => void storage.set(key, value),
      removeItem: (key) => void storage.delete(key),
    },
    fetch: proxy,
  })
  const runtime = createRuntime({ upstream: sandbox.upstream("stripe") })
  const stripe = new Stripe("sk_test_fake_browser_key", {
    host: "mock",
    protocol: "http",
    maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient((input: unknown, init?: unknown) =>
      runtime.fetch(new Request(input as string, init as RequestInit)),
    ),
  })
  const controls = sandbox.controls([
    { id: "stripe", label: "Stripe", category: "Payments", admin: async (r) => runtime.fetch(r) },
  ])

  // Emulated: stays local.
  const local = await stripe.customers.create({ email: "local@example.test" })
  expect(local.id).not.toBe("cus_from_sandbox")
  expect(vendor).toHaveLength(0)

  await expect(controls.setMode("stripe", "sandbox")).rejects.toThrow("access key")
  await controls.setAccessKey(ACCESS)
  await controls.setMode("stripe", "sandbox")
  expect((await controls.list()).services[0]?.mode).toBe("sandbox")

  const forwarded = await stripe.customers.create({ email: "ada@example.test" })
  expect(forwarded.id).toBe("cus_from_sandbox")
  expect(forwarded.lastResponse.requestId).toBe("req_sandbox")
  const outgoing = vendor[0]
  if (!outgoing) throw new Error("the vendor saw nothing")
  expect(outgoing.url).toBe("https://api.stripe.com/v1/customers")
  expect(outgoing.method).toBe("POST")
  expect(outgoing.headers.get("authorization")).toBe(`Bearer ${REAL_KEY}`)
  expect(outgoing.headers.has(SANDBOX_KEY_HEADER)).toBe(false)
  expect([...outgoing.headers.values()].join(" ")).not.toContain("sk_test_fake_browser_key")
  expect(outgoing.headers.get("stripe-version")).toBeTruthy()
  expect(await outgoing.text()).toBe("email=ada%40example.test")

  // Back to emulated: local again, nothing more reaches the vendor.
  await controls.setMode("stripe", "emulated")
  const again = await stripe.customers.create({ email: "local2@example.test" })
  expect(again.id).not.toBe("cus_from_sandbox")
  expect(vendor).toHaveLength(1)
})
