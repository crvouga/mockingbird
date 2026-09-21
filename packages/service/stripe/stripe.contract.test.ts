import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { createRuntime, STRIPE_PRESETS } from "./src/index.js"

const API = "http://stripe.mock"
const KEY = "sk_test_contract"

const form = (body: Record<string, string>, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: {
    authorization: `Bearer ${KEY}`,
    "content-type": "application/x-www-form-urlencoded",
    ...headers,
  },
  body: new URLSearchParams(body),
})

/** In-process runtime whose webhooks land in an array instead of the network. */
const harness = () => {
  const deliveries: Request[] = []
  const runtime = createRuntime({
    webhooks: {
      endpoints: [
        { url: "http://backend.local/billing/webhooks/stripe/mso", secret: "whsec_contract" },
      ],
      fetch: async (request) => {
        deliveries.push(request)
        return Response.json({ received: true })
      },
    },
  })
  const call = (path: string, init?: RequestInit) =>
    runtime.fetch(new Request(`${API}${path}`, init))
  const admin = async (method: string, path: string, body?: unknown) =>
    runtime.fetch(
      new Request(`${API}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  return { runtime, deliveries, call, admin }
}

describe("service contract", () => {
  test("/health names the service and the loaded corpus; every response carries x-mockingbird", async () => {
    const { call } = harness()
    const health = await call("/health")
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({
      status: "ok",
      service: "stripe",
      corpus: "geviti-2026-09-20",
    })
    const vendor = await call("/v1/customers", { headers: { authorization: `Bearer ${KEY}` } })
    expect(vendor.headers.get("x-mockingbird")).toMatch(/^stripe@.+; ns=default$/)
  })

  test("namespaces by header, by /ns/ prefix and by API key all isolate state", async () => {
    const { call, admin } = harness()
    const created = await call(
      "/v1/customers",
      form({ email: "a@example.com" }, { "x-mockingbird-namespace": "a" }),
    )
    const { id } = (await created.json()) as { id: string }
    const read = (path: string, headers: Record<string, string> = {}) =>
      call(path, { headers: { authorization: `Bearer ${KEY}`, ...headers } })
    expect((await read(`/v1/customers/${id}`, { "x-mockingbird-namespace": "a" })).status).toBe(200)
    expect((await read(`/ns/a/v1/customers/${id}`)).status).toBe(200)
    expect((await read(`/v1/customers/${id}`)).status).toBe(404)
    expect((await admin("PUT", "/credentials", { credentials: { [KEY]: "a" } })).status).toBe(200)
    expect((await read(`/v1/customers/${id}`)).status).toBe(200)
  })

  test("every preset the catalog names exists and applies", async () => {
    const { admin } = harness()
    for (const name of [
      "card_declined",
      "rate_limited",
      "api_error",
      "search_lag",
      "webhook_duplicate",
      "webhook_reorder",
      "webhook_drop",
    ]) {
      expect(STRIPE_PRESETS[name]).toBeDefined()
      expect((await admin("POST", "/faults", { preset: name, count: 1 })).status).toBe(201)
    }
    const listed = (await (await admin("GET", "/faults/presets")).json()) as {
      presets: { name: string }[]
    }
    expect(listed.presets.map((preset) => preset.name)).toContain("webhook_reorder")
  })

  test("webhook signatures verify with an independent HMAC over the exact bytes, on the wall clock", async () => {
    const { call, runtime, deliveries } = harness()
    await runtime.clock.advance(400 * 86_400_000)
    await call("/v1/customers", form({ email: "signed@example.com" }))
    await runtime.webhooks.idle()
    const delivery = deliveries[0]
    expect(delivery).toBeDefined()
    const header = delivery?.headers.get("stripe-signature") ?? ""
    const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header)
    expect(match).not.toBeNull()
    const timestamp = Number(match?.[1])
    expect(Math.abs(timestamp - Date.now() / 1000)).toBeLessThan(60)
    const body = await delivery?.text()
    const expected = createHmac("sha256", "whsec_contract")
      .update(`${timestamp}.${body}`)
      .digest("hex")
    expect(match?.[2]).toBe(expected)
    expect(JSON.parse(body ?? "{}")).toMatchObject({
      object: "event",
      type: "customer.created",
      api_version: "2024-06-20",
    })
  })

  test("the journal records metadata only: no card numbers, emails or bodies", async () => {
    const { call, admin, runtime } = harness()
    const session = (await (
      await call(
        "/v1/checkout/sessions",
        form({
          mode: "payment",
          "line_items[0][price_data][currency]": "usd",
          "line_items[0][price_data][unit_amount]": "1000",
          "line_items[0][price_data][product_data][name]": "Kit",
          "line_items[0][quantity]": "1",
          success_url: "http://localhost/s",
        }),
      )
    ).json()) as { id: string }
    const paid = await call(`/c/pay/${session.id}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        card: "4242424242424242",
        exp: "12/34",
        cvc: "123",
        zip: "94107",
        action: "pay",
      }),
      redirect: "manual",
    })
    expect(paid.status).toBe(302)
    const journal = JSON.stringify(await (await admin("GET", "/requests")).json())
    expect(journal).not.toContain("4242424242424242")
    expect(journal).toContain("PostCheckoutPage")
    const stored = runtime.sqlite
      .prepare("SELECT value FROM mockingbird_records")
      .all<{ value: string }>()
      .map((row) => row.value)
      .join("\n")
    expect(stored).not.toContain("4242424242424242")
    expect(stored).not.toContain('"cvc"')
  })

  test("PUT /__admin/accounts validates and maps keys; GET /__admin lists the Stripe routes", async () => {
    const { admin, call } = harness()
    expect((await admin("PUT", "/accounts", { accounts: [{ id: "bad", keys: [] }] })).status).toBe(
      400,
    )
    const ok = await admin("PUT", "/accounts", {
      accounts: [{ id: "acct_mso", keys: [KEY, "sk_test_legacy"], apiVersion: "2024-06-20" }],
    })
    expect(ok.status).toBe(200)
    const created = (await (
      await call("/v1/customers", form({ email: "m@example.com" }))
    ).json()) as { id: string }
    const viaLegacy = await call(`/v1/customers/${created.id}`, {
      headers: { authorization: "Bearer sk_test_legacy" },
    })
    expect(viaLegacy.status).toBe(200)
    expect(viaLegacy.headers.get("stripe-version")).toBe("2024-06-20")
    const routes = ((await (await admin("GET", "/")).json()) as { routes: string[] }).routes
    for (const route of [
      "PUT /accounts",
      "PUT /webhook-endpoints",
      "PUT /refunds/:id",
      "POST /disputes",
      "POST /checkout/sessions/:id/complete",
      "PUT /credentials",
      "POST /tick",
    ])
      expect(routes).toContain(route)
  })
})
