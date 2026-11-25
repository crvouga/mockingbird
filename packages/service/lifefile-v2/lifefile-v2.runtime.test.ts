import { describe, expect, test } from "bun:test"
import { createClock } from "@crvouga/mockingbird-service"
import {
  createRuntime,
  LIFEFILE_V2_PRESETS,
  PROVISIONAL_PUSH_SHAPE,
  PUSH_SHAPE_HEADER,
  RECORDED_LATENCY_MS,
} from "./src/index.js"
import { createServer, DEFAULT_PORT, serveTarget } from "./src/server.js"
import { consumer, orderBody } from "./test/consumer.js"

const BASE = "http://lifefile.local"
const COMMON = { adminKey: undefined, seed: undefined, onLog: undefined }
const T0 = Date.parse("2026-11-24T22:57:51.000Z")

type Received = { headers: Headers; body: Record<string, unknown> }

const sink = () => {
  const received: Received[] = []
  let status = 200
  const fetch = async (request: Request) => {
    received.push({
      headers: request.headers,
      body: (await request.json()) as Record<string, unknown>,
    })
    return new Response(null, { status })
  }
  return {
    received,
    fetch,
    fail: (next: number) => {
      status = next
    },
  }
}

const boot = (options: Parameters<typeof createRuntime>[0] = {}) => {
  const clock = createClock()
  clock.set(T0)
  clock.freeze()
  const pushes = sink()
  const runtime = createRuntime({
    latency: "none",
    clock,
    push: {
      url: "http://receiver.local/webhooks/lifefile",
      username: "push-user",
      password: "push-pass",
      retryDelaysMs: [0],
      fetch: pushes.fetch,
    },
    ...options,
  })
  const fetch = (request: Request) => runtime.fetch(request)
  return { runtime, clock, fetch, pushes, client: consumer(BASE, fetch, { now: clock.now }) }
}

const admin = async (
  runtime: { fetch: (r: Request) => Promise<Response> },
  method: string,
  path: string,
  body?: unknown,
  namespace?: string,
) => {
  const response = await runtime.fetch(
    new Request(`${BASE}/__admin${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(namespace ? { "x-mockingbird-namespace": namespace } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  const text = await response.text()
  return {
    status: response.status,
    json: (text ? JSON.parse(text) : null) as Record<string, unknown>,
  }
}

const placed = async (client: ReturnType<typeof consumer>, uuid = crypto.randomUUID()) => {
  const created = await client.createOrder(orderBody({ uuid }))
  if (!created.ok) throw new Error(`create failed: ${JSON.stringify(created.failure)}`)
  return created.data.orderId
}

describe("service contract", () => {
  test("health answers without credentials and names the corpus; vendor routes need a bearer", async () => {
    const { runtime } = boot()
    const health = await runtime.fetch(new Request(`${BASE}/__admin/health`))
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({
      status: "ok",
      service: "lifefile-v2",
      corpus: "lifefile-v2-2026-11-24",
    })
    const vendor = await runtime.fetch(
      new Request(`${BASE}/api/v2/ping`, { headers: { "x-vendor-id": "10001" } }),
    )
    expect(vendor.status).toBe(401)
  })

  test("namespaces isolate orders: by header, by /__admin/ns/ prefix, and by client id", async () => {
    const { runtime } = boot()
    const fetch = (r: Request) => runtime.fetch(r)
    const a = consumer(`${BASE}/__admin/ns/a`, fetch, { clientId: "client-a", clientSecret: "s" })
    const id = await placed(a)
    expect((await a.order(id)).ok).toBe(true)
    const b = consumer(`${BASE}/__admin/ns/b`, fetch, { clientId: "client-b", clientSecret: "s" })
    expect((await b.order(id)).ok).toBe(false)
    await admin(runtime, "PUT", "/credentials", { credentials: { "client-c": "a" } })
    const c = consumer(BASE, fetch, { clientId: "client-c", clientSecret: "s" })
    await runtime.fetch(
      new Request(`${BASE}/api/v2/auth/token`, {
        method: "POST",
        headers: {
          "x-vendor-id": "10001",
          "content-type": "application/x-www-form-urlencoded",
          "x-mockingbird-namespace": "a",
        },
        body: "grant_type=client_credentials&client_id=client-c&client_secret=s",
      }),
    )
    expect((await c.order(id)).ok).toBe(true)
  })

  test("the journal keeps no request bodies (patient data never lands in it)", async () => {
    const { runtime, client } = boot()
    await placed(client)
    const journal = JSON.stringify(runtime.journal.list())
    expect(journal).not.toContain("Synthetic Compound")
    expect(journal).not.toContain("1990-01-01")
    expect(journal).not.toContain("lifefile-secret")
  })

  test("default latency is the recorded one; with virtual time a create costs ~1.3 s of mock clock and no wall time", async () => {
    const clock = createClock()
    clock.set(T0)
    clock.freeze()
    const runtime = createRuntime({ clock, adminControls: { virtualTime: true } })
    const client = consumer(BASE, (r) => runtime.fetch(r), { now: clock.now })
    const started = performance.now()
    const before = runtime.namespaceClock().now()
    await placed(client)
    const spent = runtime.namespaceClock().now() - before
    expect(spent).toBeGreaterThanOrEqual(RECORDED_LATENCY_MS.CreateOrder as number)
    expect(spent).toBeLessThan(3_000)
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  test("the served emulator answers plain fetch and delivers a push to a real HTTP sink", async () => {
    const received: Received[] = []
    const receiver = Bun.serve({
      port: 0,
      fetch: async (request) => {
        received.push({
          headers: request.headers,
          body: (await request.json()) as Record<string, unknown>,
        })
        return new Response("ok")
      },
    })
    const server = await createServer({
      latency: "none",
      push: { url: `http://127.0.0.1:${receiver.port}/push`, username: "u", password: "p" },
    })
    try {
      const client = consumer(server.url, (r) => fetch(r))
      const id = await placed(client)
      const advanced = await fetch(`${server.url}/__admin/orders/${id}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "pro" }),
      })
      expect(advanced.status).toBe(200)
      await server.runtime.webhooks.idle()
      for (let i = 0; i < 50 && received.length === 0; i++) await Bun.sleep(10)
      expect(received.some((r) => (r.body.status as { id: string }).id === "pro")).toBe(true)
      expect(received[0]?.headers.get("authorization")).toBe(`Basic ${btoa("u:p")}`)
    } finally {
      await server.close()
      receiver.stop(true)
    }
  })

  test("serveTarget and DEFAULT_PORT", () => {
    expect(serveTarget.name).toBe("lifefile-v2")
    expect(DEFAULT_PORT).toBe(8932)
  })

  test("serve flags: push target, catalog, seeded client, no latency", async () => {
    const runtime = (await serveTarget.create(
      {
        "push-url": "http://127.0.0.1:1/push",
        "push-username": "u",
        "push-password": "p",
        catalog: "production",
        "client-id": "stack-client",
        "client-secret": "stack-secret",
        "no-latency": true,
      },
      COMMON,
    )) as ReturnType<typeof createRuntime>
    const settings = await admin(runtime, "GET", "/settings")
    expect(settings.json).toMatchObject({
      catalog: "production",
      intake: null,
      push: { url: "http://127.0.0.1:1/push" },
    })
    const client = consumer(BASE, (r) => runtime.fetch(r), {
      clientId: "stack-client",
      clientSecret: "stack-secret",
    })
    const started = performance.now()
    expect((await client.call("GET", "/ping")).ok).toBe(true)
    expect(performance.now() - started).toBeLessThan(150)
    expect(() => serveTarget.create({ catalog: "staging" }, COMMON)).toThrow(
      "--catalog is sandbox or production",
    )
  })
})

describe("Data Push (provisional shape)", () => {
  test("a status change pushes JSON with Basic auth and the provisional-shape header", async () => {
    const { client, runtime, pushes, clock } = boot()
    const id = await placed(client)
    clock.advance(5_000)
    await client.setStatus(id, "pen")
    await runtime.webhooks.idle()
    const push = pushes.received.find((p) => (p.body.status as { id: string }).id === "pen")
    expect(push).toBeDefined()
    expect(push?.headers.get("authorization")).toBe(`Basic ${btoa("push-user:push-pass")}`)
    expect(push?.headers.get(PUSH_SHAPE_HEADER)).toBe(PROVISIONAL_PUSH_SHAPE)
    expect(push?.headers.get("content-type")).toContain("application/json")
    expect(push?.body).toMatchObject({
      event: "order.status.changed",
      orderId: id,
      referenceId: "ref-0001",
      status: { id: "pen", label: "Pending Orders" },
      changedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    })
    expect(push?.body).not.toHaveProperty("shipping")
  })

  test("admin: advance status to any code, with a push; unknown code is 404", async () => {
    const { client, runtime, pushes } = boot()
    const id = await placed(client)
    const advanced = await admin(runtime, "POST", `/orders/${id}/status`, { status: "pro" })
    expect(advanced.status).toBe(200)
    expect(await client.status(id)).toMatchObject({
      data: { id: "pro", label: "Completed Orders" },
    })
    await runtime.webhooks.idle()
    expect(pushes.received.map((p) => (p.body.status as { id: string }).id)).toContain("pro")
    expect((await admin(runtime, "POST", `/orders/${id}/status`, { status: "zzzzz" })).status).toBe(
      404,
    )
    expect((await admin(runtime, "POST", "/orders/1/status", { status: "pro" })).status).toBe(404)
    expect((await admin(runtime, "POST", `/orders/${id}/status`, {})).status).toBe(400)
  })

  test("admin: emit a push with tracking, and one without", async () => {
    const { client, runtime, pushes } = boot()
    const id = await placed(client)
    await admin(runtime, "POST", `/orders/${id}/status`, { status: "pro", push: false })
    expect(
      (
        await admin(runtime, "POST", `/orders/${id}/push`, {
          tracking: { trackingNumber: "1Z999AA10123456784", carrier: "UPS" },
        })
      ).status,
    ).toBe(200)
    expect((await admin(runtime, "POST", `/orders/${id}/push`, {})).status).toBe(200)
    await runtime.webhooks.idle()
    const [withTracking, without] = pushes.received
    expect(withTracking?.body.shipping).toEqual({
      trackingNumber: "1Z999AA10123456784",
      carrier: "UPS",
      service: null,
    })
    expect(without?.body).not.toHaveProperty("shipping")
    expect((await admin(runtime, "POST", "/orders/1/push", {})).status).toBe(404)
  })

  test.each([
    ["push_duplicate", 2],
    ["push_drop", 0],
  ] as const)("preset %s changes how many copies arrive", async (preset, copies) => {
    const { client, runtime, pushes } = boot()
    const id = await placed(client)
    await runtime.webhooks.idle()
    const before = pushes.received.length
    expect((await admin(runtime, "POST", "/faults", { preset, count: 1 })).status).toBeLessThan(300)
    await admin(runtime, "POST", `/orders/${id}/status`, { status: "pro" })
    await runtime.webhooks.idle()
    await runtime.webhooks.flush()
    expect(pushes.received.length - before).toBe(copies)
  })

  test("preset push_reorder swaps the next two pushes", async () => {
    const { client, runtime, pushes } = boot()
    const id = await placed(client)
    await runtime.webhooks.idle()
    const before = pushes.received.length
    await admin(runtime, "POST", "/faults", { preset: "push_reorder", count: 1 })
    await admin(runtime, "POST", `/orders/${id}/status`, { status: "pen" })
    await admin(runtime, "POST", `/orders/${id}/status`, { status: "pro" })
    await runtime.webhooks.idle()
    await runtime.webhooks.flush()
    const order = pushes.received.slice(before).map((p) => (p.body.status as { id: string }).id)
    expect(order).toEqual(["pro", "pen"])
  })

  test("push_bad_credentials sends a Basic header the receiver must refuse", async () => {
    const { client, runtime, pushes } = boot()
    const id = await placed(client)
    await runtime.webhooks.idle()
    await admin(runtime, "POST", `/orders/${id}/push`, { badCredentials: true })
    await runtime.webhooks.idle()
    expect(pushes.received.at(-1)?.headers.get("authorization")).toBe(
      `Basic ${btoa("invalid:invalid")}`,
    )
  })

  test("a push to a dead receiver gives up after its retries instead of queueing forever", async () => {
    const { client, runtime, pushes } = boot()
    pushes.fail(500)
    const id = await placed(client)
    await admin(runtime, "POST", `/orders/${id}/status`, { status: "pro" })
    await runtime.webhooks.idle()
    await runtime.webhooks.flush()
    expect(runtime.webhooks.pending()).toBe(0)
    expect(runtime.webhooks.deliveries().every((d) => d.state !== "pending")).toBe(true)
  })

  test("the push target can be set per namespace at runtime", async () => {
    const clock = createClock()
    const runtime = createRuntime({ latency: "none", clock })
    const configured = await admin(runtime, "PUT", "/push", {
      url: "http://elsewhere.local/push",
      username: "a",
      password: "b",
    })
    expect(configured.status).toBe(200)
    expect(runtime.webhooks.endpoints("default").map((e) => e.url)).toContain(
      "http://elsewhere.local/push",
    )
  })
})

describe("failure controls", () => {
  test("create_lost_reply: the order exists but the caller sees a dropped connection", async () => {
    const { client, runtime } = boot()
    expect((await client.call("GET", "/ping")).ok).toBe(true)
    await admin(runtime, "POST", "/faults", { preset: "create_lost_reply", count: 1 })
    const uuid = crypto.randomUUID()
    const created = await client.createOrder(orderBody({ uuid }))
    expect(created.ok).toBe(false)
    if (!created.ok)
      expect(created.failure).toMatchObject({ certainty: "unknown", category: "network" })
    const found = await client.findByRxUuid(uuid)
    expect(found.ok && found.data.total).toBe(1)
  })

  test.each([
    ["server_error", 500, "unknown"],
    ["unavailable", 503, "unknown"],
    ["rate_limited", 429, "definite"],
  ] as const)(
    "preset %s answers %i (%s) without creating an order",
    async (preset, status, certainty) => {
      const { client, runtime } = boot()
      expect(LIFEFILE_V2_PRESETS[preset]).toBeDefined()
      expect((await client.call("GET", "/ping")).ok).toBe(true)
      await admin(runtime, "POST", "/faults", { preset, count: 1 })
      const created = await client.createOrder(orderBody())
      expect(created.ok).toBe(false)
      if (!created.ok) expect(created.failure).toMatchObject({ httpStatus: status, certainty })
      expect(runtime.instance().orders()).toHaveLength(0)
    },
  )

  test("rate_limited carries Retry-After, which the consumer reads", async () => {
    const { client, runtime } = boot()
    expect((await client.call("GET", "/ping")).ok).toBe(true)
    await admin(runtime, "POST", "/faults", { preset: "rate_limited", count: 1 })
    const result = await client.call("GET", "/ping")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.retryAfterMs).toBe(60_000)
  })

  test("admin token revoke: every token dies, the consumer refreshes once and succeeds", async () => {
    const { client, runtime } = boot()
    expect((await client.call("GET", "/ping")).ok).toBe(true)
    const revoked = await admin(runtime, "POST", "/tokens/revoke", {})
    expect(revoked.status).toBe(200)
    expect((await client.call("GET", "/ping")).ok).toBe(true)
    expect(client.retries).toBe(1)
    expect(client.tokens.tokenRequests).toBe(2)
  })

  test("admin expire secret: tokens still work until they die, but no new token is issued", async () => {
    const { client, runtime, clock } = boot()
    expect((await client.call("GET", "/ping")).ok).toBe(true)
    expect(
      (await admin(runtime, "POST", "/api-users/lifefile-client/expire-secret", {})).status,
    ).toBe(200)
    expect((await client.call("GET", "/ping")).ok).toBe(true)
    clock.advance(61 * 60_000)
    const after = await client.call("GET", "/ping")
    expect(after.ok).toBe(false)
    if (!after.ok)
      expect(after.failure).toMatchObject({ category: "auth", vendorCode: "invalid_client" })
    expect((await admin(runtime, "POST", "/api-users/nobody/expire-secret", {})).status).toBe(404)
  })

  test("token_revoked preset makes API calls 401 once", async () => {
    const { client, runtime } = boot()
    await client.call("GET", "/ping")
    await admin(runtime, "POST", "/faults", { preset: "token_revoked", count: 1 })
    expect((await client.call("GET", "/ping")).ok).toBe(true)
    expect(client.retries).toBe(1)
  })

  test("the clock control moves intake and token expiry for one namespace only", async () => {
    const { runtime } = boot()
    const fetch = (r: Request) => runtime.fetch(r)
    const a = consumer(`${BASE}/__admin/ns/clock-a`, fetch)
    const id = await placed(a)
    await admin(runtime, "POST", "/clock", { advance: 1_000 }, "clock-a")
    expect(await a.status(id)).toMatchObject({ data: { id: "b3644" } })
  })

  test("settings: GET and PUT validate, unknown keys refused", async () => {
    const { runtime } = boot()
    const current = await admin(runtime, "GET", "/settings")
    expect(current.json).toMatchObject({
      catalog: "sandbox",
      fastTrackWindowMs: 2000,
      tokenTtlSeconds: 86400,
    })
    expect((await admin(runtime, "PUT", "/settings", { catalog: "production" })).status).toBe(200)
    expect((await admin(runtime, "PUT", "/settings", { catalog: "nope" })).status).toBe(400)
    expect((await admin(runtime, "PUT", "/settings", { bogus: 1 })).status).toBe(400)
    expect((await admin(runtime, "GET", "/settings")).json).toMatchObject({
      catalog: "production",
      intake: null,
    })
  })

  test("admin order list shows what the namespace holds", async () => {
    const { client, runtime } = boot()
    const id = await placed(client)
    const listed = await admin(runtime, "GET", "/orders")
    expect((listed.json.orders as { id: number }[]).map((o) => o.id)).toEqual([id])
  })
})

describe("long-running limits (M1 namespace lifecycle)", () => {
  test("deleting a namespace releases its orders, tokens and pushes", async () => {
    const { runtime } = boot()
    const fetch = (r: Request) => runtime.fetch(r)
    for (let i = 0; i < 3; i++) {
      const c = consumer(`${BASE}/__admin/ns/test-${i}`, fetch)
      await placed(c)
    }
    expect(runtime.resources().namespaces).toBeGreaterThanOrEqual(3)
    for (let i = 0; i < 3; i++) {
      expect(
        (
          await runtime.fetch(
            new Request(`${BASE}/__admin/namespaces/test-${i}`, { method: "DELETE" }),
          )
        ).status,
      ).toBeLessThan(300)
    }
    expect(runtime.resources().namespaces).toBeLessThanOrEqual(1)
  })

  test("maxRecords caps a runaway namespace with a 507", async () => {
    const { client } = boot({ maxRecords: 12 })
    let refused = 0
    for (let i = 0; i < 10; i++) {
      const created = await client.createOrder(orderBody({ uuid: crypto.randomUUID() }))
      if (!created.ok && created.failure.httpStatus === 507) refused++
    }
    expect(refused).toBeGreaterThan(0)
  })

  test("rx uuid lookups read the index, not every order", async () => {
    const { client, runtime } = boot()
    const uuid = crypto.randomUUID()
    for (let i = 0; i < 30; i++) await placed(client)
    await placed(client, uuid)
    const api = runtime.instance()
    let scans = 0
    const list = api.state.orders.list.bind(api.state.orders)
    api.state.orders.list = (...args: Parameters<typeof list>) => {
      scans++
      return list(...args)
    }
    expect((await client.findByRxUuid(uuid)).ok).toBe(true)
    expect(scans).toBe(0)
  })
})
