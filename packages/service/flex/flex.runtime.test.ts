import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { Webhook } from "svix"
import { CORPUS_ROWS, createRuntime, FLEX_PRESETS } from "./src/index.js"
import { createServer, DEFAULT_PORT } from "./src/server.js"
import {
  type CatalogMapping,
  FlexApiClient,
  FlexCatalog,
  FlexOrchestrator,
  FlexPaymentRepository,
  FlexWebhookReceiver,
  payOnHostedPage,
} from "./test/consumer.js"
import mappingsFixture from "./test/corpus/flex-catalog-mappings.json" with { type: "json" }

const API = "http://flex.mock"
const SECRET = `whsec_${Buffer.from("runtime-test-signing-key-flex!!").toString("base64")}`
const PRODUCT = "fprod_01m0tgysj4ahvf8fas60c2ef2d" // marketplace, auto_substantiation

const session = (key: string) => ({
  checkout_session: {
    success_url: "https://app.acme.example/ok",
    cancel_url: "https://app.acme.example/no",
    client_reference_id: "ref-1",
    line_items: [{ price_data: { product: PRODUCT, unit_amount: 500 }, quantity: 2 }],
    metadata: { key },
  },
})

const call = (
  runtime: { fetch: (r: Request) => Promise<Response> },
  path: string,
  init: { method?: string; key?: string; body?: unknown; headers?: Record<string, string> } = {},
) =>
  runtime.fetch(
    new Request(`${API}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        "content-type": "application/json",
        ...(init.key === undefined ? {} : { authorization: `Bearer ${init.key}` }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  )

describe("service contract", () => {
  test("/health, the x-mockingbird header, and the admin route list", async () => {
    const runtime = createRuntime()
    const health = await call(runtime, "/health")
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({
      status: "ok",
      service: "flex",
      corpus: "flexCatalogMappings",
    })
    expect(health.headers.get("x-mockingbird")).toMatch(/^flex@.+; ns=default$/)
    const routes = JSON.stringify(await (await call(runtime, "/__admin")).json())
    for (const route of [
      "PUT /products/:id",
      "POST /sessions/:id/complete",
      "POST /sessions/:id/decline",
      "POST /sessions/:id/expire",
      "POST /sessions/:id/require_action",
      "PUT /sessions/:id/payment-intent",
      "POST /events",
      "PUT /settings",
    ]) {
      expect(routes).toContain(route)
    }
  })

  test("namespaces by header, by /ns/ prefix and by API key stay isolated", async () => {
    const runtime = createRuntime()
    const created = await call(runtime, "/v1/checkout/sessions", {
      key: "fsk_test_a",
      body: session("a"),
      headers: { "x-mockingbird-namespace": "a" },
    })
    const id = ((await created.json()) as { checkout_session: { checkout_session_id: string } })
      .checkout_session.checkout_session_id
    expect(
      (await call(runtime, `/ns/a/v1/checkout/sessions/${id}`, { key: "fsk_test_x" })).status,
    ).toBe(200)
    expect((await call(runtime, `/v1/checkout/sessions/${id}`, { key: "fsk_test_a" })).status).toBe(
      404,
    )
    await call(runtime, "/__admin/credentials", {
      method: "PUT",
      body: { credentials: { fsk_test_a: "a" } },
    })
    const byKey = await call(runtime, `/v1/checkout/sessions/${id}`, { key: "fsk_test_a" })
    expect(byKey.status).toBe(200)
    expect(byKey.headers.get("x-mockingbird")).toContain("ns=a")
    // A reset of one namespace leaves the other alone (and the corpus survives resets).
    await call(runtime, "/__admin/reset?namespace=a", { method: "POST" })
    expect((await call(runtime, `/v1/checkout/sessions/${id}`, { key: "fsk_test_a" })).status).toBe(
      404,
    )
    expect((await call(runtime, `/v1/products/${PRODUCT}`, { key: "fsk_test_a" })).status).toBe(200)
  })

  test("every catalog preset is registered and switchable over the admin API", async () => {
    expect(Object.keys(FLEX_PRESETS)).toEqual(
      expect.arrayContaining([
        "create_4xx",
        "create_5xx",
        "timeout",
        "invalid_shape",
        "amount_mismatch",
        "duplicate_sessions_for_client_reference",
        "refund_4xx",
        "webhook_duplicate",
        "webhook_reorder",
        "webhook_drop",
      ]),
    )
    const runtime = createRuntime()
    const listed = (await (await call(runtime, "/__admin/faults/presets")).json()) as {
      presets: { name: string }[]
    }
    expect(listed.presets.map((p) => p.name).sort()).toEqual(Object.keys(FLEX_PRESETS).sort())
    expect(
      (await call(runtime, "/__admin/faults", { body: { preset: "create_4xx", count: 1 } })).status,
    ).toBe(201)
    expect(
      (await call(runtime, "/v1/checkout/sessions", { key: "fsk_test_k", body: session("x") }))
        .status,
    ).toBe(400)
    expect(
      (await call(runtime, "/v1/checkout/sessions", { key: "fsk_test_k", body: session("x") }))
        .status,
    ).toBe(200)
  })

  test("webhooks are Svix-signed: an independent node:crypto HMAC matches; timestamps are wall clock", async () => {
    const seen: { headers: Headers; body: string }[] = []
    const runtime = createRuntime({
      webhooks: {
        url: "http://backend.local/billing/webhooks/flex",
        secret: SECRET,
        fetch: async (request) => {
          seen.push({ headers: request.headers, body: await request.text() })
          return new Response(null, { status: 200 })
        },
      },
    })
    runtime.clock.advance(30 * 86_400_000)
    await call(runtime, `/__admin/products/${PRODUCT}`, {
      method: "PUT",
      body: { visit_type: "vision" },
    })
    await runtime.webhooks.idle()
    const delivery = seen[0] as { headers: Headers; body: string }
    const id = delivery.headers.get("svix-id") as string
    const timestamp = delivery.headers.get("svix-timestamp") as string
    const expected = createHmac("sha256", Buffer.from(SECRET.slice("whsec_".length), "base64"))
      .update(`${id}.${timestamp}.${delivery.body}`)
      .digest("base64")
    expect(delivery.headers.get("svix-signature")).toBe(`v1,${expected}`)
    expect(Math.abs(Number(timestamp) - Date.now() / 1000)).toBeLessThan(5)
    expect(() =>
      new Webhook(SECRET).verify(delivery.body, Object.fromEntries(delivery.headers)),
    ).not.toThrow()
    // The payload's own event_dt follows the mock clock.
    const body = JSON.parse(delivery.body) as { event: { event_dt: number } }
    expect(body.event.event_dt).toBeGreaterThan(Date.now() / 1000 + 29 * 86_400)
  })

  test("the journal records operation ids and resource ids, never bodies", async () => {
    const runtime = createRuntime()
    await call(runtime, "/v1/customers", {
      key: "fsk_test_j",
      body: {
        customer: {
          first_name: "Ada",
          last_name: "Lovelace",
          email: "ada@example.com",
          phone: "602",
        },
      },
    })
    const journal = (await (await call(runtime, "/__admin/requests")).json()) as {
      requests: { operationId: string; ids?: Record<string, string> }[]
    }
    expect(journal.requests[0]?.operationId).toBe("CreateCustomer")
    expect(journal.requests[0]?.ids?.customerId).toMatch(/^fcus_/)
    expect(JSON.stringify(journal)).not.toMatch(/Lovelace|ada@example/)
  })

  test("the corpus holds one active test-mode product per consumer mapping", () => {
    expect(CORPUS_ROWS).toHaveLength(mappingsFixture.rows.length)
    expect(DEFAULT_PORT).toBe(8792)
  })
})

describe("served over HTTP", () => {
  test("consumer → mock over node:http → hosted page → signed webhook on a Bun.serve sink → succeeded", async () => {
    let receiver: FlexWebhookReceiver | undefined
    const statuses: number[] = []
    const sink = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (new URL(request.url).pathname !== "/billing/webhooks/flex")
          return new Response(null, { status: 404 })
        const outcome = await (receiver as FlexWebhookReceiver).handle(
          request.headers,
          await request.text(),
        )
        statuses.push(outcome.status)
        return Response.json("body" in outcome ? outcome.body : { message: outcome.error }, {
          status: outcome.status,
        })
      },
    })
    const server = await createServer({
      webhooks: { url: `http://127.0.0.1:${sink.port}/billing/webhooks/flex`, secret: SECRET },
    })
    try {
      const api = new FlexApiClient({
        baseUrl: server.url,
        apiKey: "fsk_test_http",
        fetch: (r) => fetch(r),
      })
      const mappings: CatalogMapping[] = mappingsFixture.rows.map((row) => ({
        ...row,
        purpose: row.purpose as CatalogMapping["purpose"],
        eligibility: row.eligibility as CatalogMapping["eligibility"],
        metadata: row.metadata as Record<string, string>,
      }))
      const orchestrator = new FlexOrchestrator(
        api,
        new FlexCatalog(mappings, api),
        new FlexPaymentRepository(),
      )
      receiver = new FlexWebhookReceiver(SECRET, orchestrator)
      const { attempt, result } = await orchestrator.createCheckout({
        userId: 1,
        purpose: "marketplace",
        businessReference: "order-http",
        amountCents: 4_500,
        lineItems: [
          {
            merchantProductId: "prod_RPVGXPdPvh7eLt",
            name: "Omega",
            unitAmountCents: 4_500,
            quantity: 1,
          },
        ],
        successUrl: "https://app.acme.example/shop/success?session_id={CHECKOUT_SESSION_ID}",
        cancelUrl: "https://app.acme.example/shop",
        metadata: {},
      })
      expect(result.redirectUrl.startsWith(`${server.url}/pay/`)).toBe(true)
      const started = performance.now()
      const paid = await payOnHostedPage((r) => fetch(r), result.redirectUrl, "4000051230000072")
      expect(paid.response.status).toBe(302)
      expect(paid.response.headers.get("location")).toBe(
        `https://app.acme.example/shop/success?session_id=${result.providerReference}`,
      )
      const read = () => orchestrator.repository.attempts.get(attempt.id)?.status
      while (read() !== "succeeded" && performance.now() - started < 2_000) await Bun.sleep(10)
      expect(read()).toBe("succeeded")
      expect(statuses.every((s) => s === 200)).toBe(true)

      // The served mock expires sessions on its own ticker and sends the webhook.
      await fetch(`${server.url}/__admin/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionTtlSeconds: 0.2 }),
      })
      const second = await api.createCheckoutSession(
        {
          clientReferenceId: "expire-1",
          mode: "payment",
          lineItems: [{ flexProductId: PRODUCT, unitAmountCents: 100, quantity: 1 }],
          successUrl: "https://app.acme.example/ok",
          cancelUrl: "https://app.acme.example/no",
          metadata: {},
        },
        "expire-key",
      )
      const deadline = Date.now() + 3_000
      while (
        (await api.getCheckoutSession(second.checkout_session_id)).status !== "expired" &&
        Date.now() < deadline
      ) {
        await Bun.sleep(50)
      }
      expect((await api.getCheckoutSession(second.checkout_session_id)).status).toBe("expired")

      // The timeout preset over a real socket: the client aborts, recovery adopts the session.
      await fetch(`${server.url}/__admin/faults`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preset: "timeout", count: 1, params: { delayMs: 600 } }),
      })
      const slowApi = new FlexApiClient({
        baseUrl: server.url,
        apiKey: "fsk_test_http",
        fetch: (r) => fetch(r),
        timeoutMs: 150,
      })
      const slow = new FlexOrchestrator(
        slowApi,
        new FlexCatalog(mappings, slowApi),
        new FlexPaymentRepository(),
      )
      const adopted = await slow.createCheckout({
        userId: 2,
        purpose: "marketplace",
        businessReference: "order-slow",
        amountCents: 4_500,
        lineItems: [
          {
            merchantProductId: "prod_RPVGXPdPvh7eLt",
            name: "Omega",
            unitAmountCents: 4_500,
            quantity: 1,
          },
        ],
        successUrl: "https://app.acme.example/ok",
        cancelUrl: "https://app.acme.example/no",
        metadata: {},
      })
      expect(adopted.result.status).toBe("pending")
    } finally {
      await server.close()
      sink.stop(true)
    }
  }, 20_000)
})
