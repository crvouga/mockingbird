import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { createRuntime, PADDLE_PRESETS, type PaddleRuntimeOptions } from "./src/index.js"
import { createServer, serveTarget } from "./src/server.js"

const API = "http://paddle.mock"
const SECRET = "pdl_ntfset_mockingbird_contract_test_secret"
const COMMON = { adminKey: undefined, seed: undefined, onLog: undefined }

const harness = (options: PaddleRuntimeOptions = {}) => {
  const deliveries: { headers: Headers; body: string }[] = []
  const runtime = createRuntime({
    webhooks: {
      url: "http://backend.local/webhooks/paddle",
      secret: SECRET,
      fetch: async (request) => {
        deliveries.push({ headers: request.headers, body: await request.text() })
        return Response.json({ ok: true })
      },
    },
    ...options,
  })
  const call = (
    path: string,
    init: { method?: string; body?: unknown; key?: string; headers?: Record<string, string> } = {},
  ) =>
    runtime.fetch(
      new Request(`${API}${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: {
          "content-type": "application/json",
          ...(init.key === ""
            ? {}
            : { authorization: `Bearer ${init.key ?? "pdl_sdbx_apikey_test"}` }),
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    )
  const json = async <T>(path: string, init?: Parameters<typeof call>[1]) =>
    (await (await call(path, init)).json()) as T
  return { runtime, call, json, deliveries }
}

type Envelope<T> = { data: T; meta: { request_id: string } }
type ErrorEnvelope = { error: { type: string; code: string; detail: string; errors?: unknown[] } }

describe("the service contract", () => {
  test("health, auth errors, not found and the x-mockingbird header", async () => {
    const { call, json } = harness()
    expect((await call("/health", { key: "" })).status).toBe(200)
    const missing = await call("/customers", { key: "" })
    expect(missing.status).toBe(403)
    expect(((await missing.json()) as ErrorEnvelope).error.code).toBe("authentication_missing")
    const malformed = await call("/customers", { headers: { authorization: "Token abc" } })
    expect(malformed.status).toBe(403)
    expect(((await malformed.json()) as ErrorEnvelope).error.code).toBe("authentication_malformed")
    const unknown = await call("/customers/ctm_00000000000000000000000000")
    expect(unknown.status).toBe(404)
    expect(((await unknown.json()) as ErrorEnvelope).error).toMatchObject({
      type: "request_error",
      code: "not_found",
      detail: "Entity ctm_00000000000000000000000000 not found",
      documentation_url: "https://developer.paddle.com/errors/shared/not_found",
    })
    expect(unknown.headers.get("x-mockingbird")).toMatch(/^paddle@.+; ns=default$/)
    const invalid = await json<ErrorEnvelope>("/customers", { body: { name: "No email" } })
    expect(invalid.error.code).toBe("invalid_field")
    expect(invalid.error.errors).toEqual([{ field: "email", message: "email: required field" }])
  })

  test("namespaces by header, by /ns/ prefix and by API key are isolated", async () => {
    const { call, json } = harness()
    await call("/__admin/credentials", {
      method: "PUT",
      body: { credentials: { pdl_sdbx_apikey_worker_a: "a" } },
    })
    const created = await json<Envelope<{ id: string }>>("/customers", {
      body: { email: "a@example.com" },
      key: "pdl_sdbx_apikey_worker_a",
    })
    expect(
      (await call(`/customers/${created.data.id}`, { key: "pdl_sdbx_apikey_worker_a" })).status,
    ).toBe(200)
    expect(
      (await call(`/customers/${created.data.id}`, { key: "pdl_sdbx_apikey_worker_b" })).status,
    ).toBe(404)
    expect(
      (await call(`/customers/${created.data.id}`, { headers: { "x-mockingbird-namespace": "a" } }))
        .status,
    ).toBe(200)
    expect((await call(`/ns/a/customers/${created.data.id}`)).status).toBe(200)
    const page = await json<{ meta: { pagination: { next: string } } }>(
      "/ns/a/customers?per_page=1",
    )
    expect(page.meta.pagination.next).toMatch(
      /^http:\/\/paddle\.mock\/ns\/a\/customers\?per_page=1&after=ctm_/,
    )
  })

  test("the journal keeps ids and operations, never names, emails or bodies", async () => {
    const { call, json } = harness()
    const created = await json<Envelope<{ id: string }>>("/customers", {
      body: {
        email: "jane.doe@example.com",
        name: "Jane Doe",
        custom_data: { plan: "secret-plan" },
      },
    })
    const journal = await (await call("/__admin/requests")).text()
    expect(journal).toContain("CreateCustomer")
    expect(journal).toContain(created.data.id)
    expect(journal).not.toContain("Jane")
    expect(journal).not.toContain("jane.doe")
    expect(journal).not.toContain("secret-plan")
  })

  test("every catalog preset is registered and behaves as described", async () => {
    expect(Object.keys(PADDLE_PRESETS)).toEqual(
      expect.arrayContaining([
        "invalid_token",
        "rate_limited",
        "transactions_500",
        "bad_gateway_html",
        "network_drop",
        "webhook_duplicate",
        "webhook_reorder",
        "webhook_drop",
      ]),
    )
    const { runtime, call } = harness()
    runtime.applyPreset("rate_limited", "default", { count: 1 })
    const limited = await call("/customers")
    expect(limited.status).toBe(429)
    expect(limited.headers.get("retry-after")).toBe("2")
    expect(((await limited.json()) as ErrorEnvelope).error.code).toBe("too_many_requests")
    runtime.applyPreset("invalid_token", "default", { count: 1 })
    expect(((await (await call("/customers")).json()) as ErrorEnvelope).error.code).toBe(
      "invalid_token",
    )
    runtime.applyPreset("bad_gateway_html", "default", { count: 1 })
    const html = await call("/customers")
    expect(html.status).toBe(502)
    expect(html.headers.get("content-type")).toContain("text/html")
    runtime.applyPreset("network_drop", "default", { count: 1 })
    await expect(call("/transactions", { body: { items: [] } })).rejects.toThrow(TypeError)
    expect((await call("/customers")).status).toBe(200)
  })
})

describe("checkout, billing and webhooks", () => {
  test("a paid transaction creates the subscription; notifications are signed the Paddle way", async () => {
    const { runtime, json, deliveries } = harness()
    runtime.clock.advance(86_400_000)
    const seed = await json<{
      prices: { monthly: { id: string } }
      customer: { id: string }
      address: { id: string }
    }>("/__admin/seed", { method: "POST" })
    const created = await json<
      Envelope<{ id: string; status: string; details: { totals: { grand_total: string } } }>
    >("/transactions", {
      body: {
        items: [{ price_id: seed.prices.monthly.id, quantity: 3 }],
        customer_id: seed.customer.id,
        address_id: seed.address.id,
      },
    })
    expect(created.data.status).toBe("ready")
    expect(created.data.details.totals.grand_total).toBe("8700")
    const paid = await json<{
      transaction: { status: string; subscription_id: string }
      subscription: { id: string; status: string }
    }>(`/__admin/transactions/${created.data.id}/pay`, {
      method: "POST",
      body: { card: { last4: "1111" } },
    })
    expect(paid.transaction.status).toBe("completed")
    expect(paid.subscription.status).toBe("active")
    expect(paid.transaction.subscription_id).toBe(paid.subscription.id)
    await runtime.webhooks.idle()
    const types = deliveries.map((d) => (JSON.parse(d.body) as { event_type: string }).event_type)
    expect(types).toEqual(
      expect.arrayContaining([
        "transaction.created",
        "transaction.paid",
        "transaction.completed",
        "subscription.created",
        "subscription.activated",
      ]),
    )
    const delivery = deliveries.find(
      (d) => d.body.includes('"subscription.created"') && d.body.includes(created.data.id),
    ) as {
      headers: Headers
      body: string
    }
    const signature = delivery.headers.get("Paddle-Signature") as string
    const [ts, h1] = signature.split(";").map((part) => part.split("=")[1] as string)
    expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(60)
    expect(h1).toBe(createHmac("sha256", SECRET).update(`${ts}:${delivery.body}`).digest("hex"))
    const body = JSON.parse(delivery.body) as {
      event_id: string
      notification_id: string
      data: { transaction_id: string }
    }
    expect(body.event_id).toMatch(/^evt_01[a-z0-9]{24}$/)
    expect(body.notification_id).toMatch(/^ntf_01[a-z0-9]{24}$/)
    expect(body.data.transaction_id).toBe(created.data.id)
  })

  test("renewals, scheduled cancels and failed payments move the subscription along", async () => {
    const { call, json } = harness()
    const seed = await json<{ subscriptions: { active: { id: string; next_billed_at: string } } }>(
      "/__admin/seed",
      {
        method: "POST",
      },
    )
    const id = seed.subscriptions.active.id
    const renewed = await json<{
      subscription: { next_billed_at: string; current_billing_period: { starts_at: string } }
      transaction: { origin: string; status: string }
    }>(`/__admin/subscriptions/${id}/renew`, { method: "POST" })
    expect(renewed.transaction).toMatchObject({
      origin: "subscription_recurring",
      status: "completed",
    })
    expect(renewed.subscription.current_billing_period.starts_at).toBe(
      seed.subscriptions.active.next_billed_at,
    )
    const failed = await json<{
      subscription: { status: string }
      transaction: { id: string; status: string }
    }>(`/__admin/subscriptions/${id}/payment-failed`, { method: "POST" })
    expect(failed.subscription.status).toBe("past_due")
    expect(failed.transaction.status).toBe("past_due")
    const recovered = await json<{ subscription: { status: string } }>(
      `/__admin/transactions/${failed.transaction.id}/pay`,
      {
        method: "POST",
      },
    )
    expect(recovered.subscription.status).toBe("active")
    const scheduled = await json<
      Envelope<{ status: string; scheduled_change: { action: string; effective_at: string } }>
    >(`/subscriptions/${id}/cancel`, { body: {} })
    expect(scheduled.data.status).toBe("active")
    expect(scheduled.data.scheduled_change.action).toBe("cancel")
    const canceled = await json<{
      subscription: { status: string; canceled_at: string }
      transaction: null
    }>(`/__admin/subscriptions/${id}/renew`, { method: "POST" })
    expect(canceled.subscription.status).toBe("canceled")
    expect(canceled.transaction).toBeNull()
    expect((await call(`/__admin/subscriptions/${id}/renew`, { method: "POST" })).status).toBe(400)
    const events = await json<{ events: { event_type: string }[] }>(
      "/__admin/events?type=subscription.canceled",
    )
    expect(events.events).toHaveLength(1)
  })

  test("webhook presets: duplicate and drop", async () => {
    const { runtime, call, deliveries } = harness()
    runtime.applyPreset("webhook_duplicate", "default")
    await call("/customers", { body: { email: "dup@example.com" } })
    await runtime.webhooks.idle()
    expect(deliveries).toHaveLength(2)
    runtime.applyPreset("webhook_drop", "default")
    await call("/customers", { body: { email: "drop@example.com" } })
    await runtime.webhooks.idle()
    expect(deliveries).toHaveLength(2)
  })
})

describe("hardening", () => {
  type Seed = {
    customer: { id: string }
    address: { id: string }
    prices: { monthly: { id: string }; setup: { id: string } }
    subscriptions: { active: { id: string; next_billed_at: string } }
    transactions: { invoice: { invoice_number: string } }
  }
  type Page<T> = { data: T[]; meta: { pagination: { per_page: number; has_more: boolean } } }

  test("invoice numbers are unique and sequential across paid transactions", async () => {
    const { json } = harness()
    const seed = await json<Seed>("/__admin/seed", { method: "POST" })
    // Two checkouts are paid before the manual invoice is issued.
    expect(seed.transactions.invoice.invoice_number).toBe("MOCK-01003")
    const ready = async () =>
      (
        await json<Envelope<{ id: string }>>("/transactions", {
          body: {
            items: [{ price_id: seed.prices.setup.id, quantity: 1 }],
            customer_id: seed.customer.id,
            address_id: seed.address.id,
          },
        })
      ).data.id
    const [a, b] = [await ready(), await ready()]
    const pay = async (id: string) =>
      (
        await json<{ transaction: { invoice_number: string } }>(`/__admin/transactions/${id}/pay`, {
          method: "POST",
        })
      ).transaction.invoice_number
    const numbers = [await pay(a), await pay(b)]
    expect(new Set(numbers).size).toBe(2)
    expect(numbers.every((n) => /^MOCK-\d{5}$/.test(n))).toBe(true)
    const listed = await json<Page<{ invoice_number: string | null }>>("/transactions")
    const issued = listed.data.map((t) => t.invoice_number).filter((n) => n !== null)
    expect(new Set(issued).size).toBe(issued.length)
  })

  test("a rejected request and a preview leave no non-catalog price or product behind", async () => {
    const { json } = harness()
    await json("/__admin/seed", { method: "POST" })
    const count = async (path: string) => (await json<Page<unknown>>(path)).data.length
    const products = await count("/products")
    const prices = await count("/prices")
    const custom = {
      price: {
        description: "Bespoke onboarding",
        unit_price: { amount: "5000", currency_code: "USD" },
        product: { name: "Bespoke", tax_category: "saas" },
      },
      quantity: 1,
    }
    const rejected = await json<ErrorEnvelope>("/transactions", {
      body: { items: [custom], customer_id: "ctm_00000000000000000000000000" },
    })
    expect(rejected.error.code).toBe("invalid_field")
    expect(rejected.error.errors).toEqual([expect.objectContaining({ field: "customer_id" })])
    const preview = await json<Envelope<{ details: { totals: { total: string } } }>>(
      "/transactions/preview",
      { body: { items: [custom] } },
    )
    expect(preview.data.details.totals.total).toBe("5000")
    expect(await count("/products")).toBe(products)
    expect(await count("/prices")).toBe(prices)
    const accepted = await json<Envelope<{ status: string; items: { price: { type: string } }[] }>>(
      "/transactions",
      { body: { items: [custom] } },
    )
    expect(accepted.data.status).toBe("draft")
    expect(accepted.data.items[0]?.price.type).toBe("custom")
    expect(await count("/products")).toBe(products + 1)
    expect(await count("/prices")).toBe(prices + 1)
  })

  test("fixtures survive a reset and never produce notifications", async () => {
    const { runtime, call, json, deliveries } = harness({ fixtures: true })
    const before = await json<Page<unknown>>("/products")
    expect(before.data.length).toBeGreaterThan(0)
    expect((await call("/__admin/reset", { method: "POST" })).status).toBeLessThan(300)
    const after = await json<Page<unknown>>("/products")
    expect(after.data.length).toBe(before.data.length)
    await runtime.webhooks.idle()
    expect(deliveries).toHaveLength(0)
    const events = await json<{ events: unknown[] }>("/__admin/events?type=subscription.created")
    expect(events.events).toHaveLength(2)
    await call("/customers", { body: { email: "after-reset@example.com" } })
    await runtime.webhooks.idle()
    expect(deliveries).toHaveLength(1)
  })

  test("per_page above the maximum is clamped, as Paddle does; below 1 is invalid", async () => {
    const { call, json } = harness({ fixtures: true })
    const clamped = await json<Page<unknown>>("/customers?per_page=500")
    expect(clamped.meta.pagination.per_page).toBe(200)
    const transactions = await json<Page<unknown>>("/transactions?per_page=100")
    expect(transactions.meta.pagination.per_page).toBe(30)
    expect((await call("/customers?per_page=0")).status).toBe(400)
    expect((await call("/customers?per_page=two")).status).toBe(400)
  })

  test("an immediate item change bills only what it adds", async () => {
    const { json } = harness()
    const seed = await json<Seed>("/__admin/seed", { method: "POST" })
    const id = seed.subscriptions.active.id
    const updated = await json<Envelope<{ items: { quantity: number }[] }>>(
      `/subscriptions/${id}`,
      {
        method: "PATCH",
        body: {
          items: [{ price_id: seed.prices.monthly.id, quantity: 3 }],
          proration_billing_mode: "prorated_immediately",
        },
      },
    )
    expect(updated.data.items[0]?.quantity).toBe(3)
    const bills = await json<
      Page<{ origin: string; details: { totals: { grand_total: string } }; items: unknown[] }>
    >(`/transactions?subscription_id=${id}&origin=subscription_update`)
    expect(bills.data).toHaveLength(1)
    expect(bills.data[0]?.details.totals.grand_total).toBe("5800")
    await json(`/subscriptions/${id}`, {
      method: "PATCH",
      body: {
        items: [{ price_id: seed.prices.monthly.id, quantity: 2 }],
        proration_billing_mode: "full_immediately",
      },
    })
    const again = await json<Page<unknown>>(
      `/transactions?subscription_id=${id}&origin=subscription_update`,
    )
    expect(again.data).toHaveLength(1)
  })

  test("a renewal applies a scheduled resume to a paused subscription", async () => {
    const { call, json } = harness()
    const seed = await json<Seed>("/__admin/seed", { method: "POST" })
    const id = seed.subscriptions.active.id
    const resumeAt = "2031-01-01T00:00:00.000Z"
    const paused = await json<
      Envelope<{
        status: string
        scheduled_change: { action: string; effective_at: string; resume_at: null }
      }>
    >(`/subscriptions/${id}/pause`, {
      body: { effective_from: "immediately", resume_at: resumeAt },
    })
    expect(paused.data.status).toBe("paused")
    expect(paused.data.scheduled_change).toEqual({
      action: "resume",
      effective_at: resumeAt,
      resume_at: null,
    })
    const renewed = await json<{
      subscription: {
        status: string
        scheduled_change: unknown
        current_billing_period: { starts_at: string }
      }
      transaction: { origin: string; status: string }
    }>(`/__admin/subscriptions/${id}/renew`, { method: "POST" })
    expect(renewed.subscription.status).toBe("active")
    expect(renewed.subscription.scheduled_change).toBeNull()
    expect(renewed.subscription.current_billing_period.starts_at).toBe(resumeAt)
    expect(renewed.transaction).toMatchObject({
      origin: "subscription_update",
      status: "completed",
    })
    const events = await json<{ events: unknown[] }>("/__admin/events?type=subscription.resumed")
    expect(events.events).toHaveLength(1)
    const stillPaused = await json<Envelope<{ id: string }>>(`/subscriptions/${id}/pause`, {
      body: { effective_from: "immediately" },
    })
    expect(stillPaused.data.id).toBe(id)
    expect((await call(`/__admin/subscriptions/${id}/renew`, { method: "POST" })).status).toBe(400)
  })
})

describe("served over HTTP", () => {
  test("plain fetch against the node server, notifications to a real sink", async () => {
    const received: unknown[] = []
    const sink = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.headers.get("paddle-signature")) received.push(await request.json())
        return Response.json({ ok: true })
      },
    })
    const server = await createServer({
      webhooks: { url: `http://127.0.0.1:${sink.port}/webhooks/paddle`, secret: SECRET },
      fixtures: true,
    })
    try {
      const products = await fetch(`${server.url}/products?include=prices`, {
        headers: { authorization: "Bearer pdl_sdbx_apikey_http" },
      })
      expect(products.status).toBe(200)
      const body = (await products.json()) as {
        data: { prices: unknown[] }[]
        meta: { pagination: { next: string } }
      }
      expect(body.data.length).toBeGreaterThan(0)
      expect(body.meta.pagination.next.startsWith(server.url)).toBe(true)
      const created = await fetch(`${server.url}/customers`, {
        method: "POST",
        headers: {
          authorization: "Bearer pdl_sdbx_apikey_http",
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: "http@example.com" }),
      })
      expect(created.status).toBe(201)
      const ours = () =>
        received.some((event) => {
          const { event_type, data } = event as { event_type: string; data: { email?: string } }
          return event_type === "customer.created" && data.email === "http@example.com"
        })
      const deadline = Date.now() + 3_000
      while (!ours() && Date.now() < deadline) await Bun.sleep(20)
      expect(ours()).toBe(true)
    } finally {
      await server.close()
      sink.stop(true)
    }
  })

  test("the serve target validates its flags", async () => {
    const runtime = await serveTarget.create(
      {
        "webhook-url": "http://127.0.0.1:1/x",
        "webhook-secret": SECRET,
        "payment-link": "https://pay.example.com/checkout",
        fixtures: true,
      },
      COMMON,
    )
    const health = (await (await runtime.fetch(new Request(`${API}/health`))).json()) as {
      webhooks: string
      paymentLink: string
      fixtures: boolean
    }
    expect(health).toMatchObject({
      webhooks: "on",
      paymentLink: "https://pay.example.com/checkout",
      fixtures: true,
    })
    await expect(
      Promise.resolve().then(() => serveTarget.create({ "webhook-secret": "plain" }, COMMON)),
    ).rejects.toThrow("pdl_ntfset_")
  })
})
