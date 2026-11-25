import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { createClock } from "@crvouga/mockingbird-service"
import { CATALOG_DATA, createRuntime, PRODUCTION_STATUSES, SANDBOX_STATUSES } from "./src/index.js"
import { SERVE_LIMITS, serveTarget } from "./src/server.js"
import { consumer, orderBody } from "./test/consumer.js"

const BASE = "http://lifefile.local"
const COMMON = { adminKey: undefined, seed: undefined, onLog: undefined }
const T0 = Date.parse("2026-11-24T22:57:51.000Z")
const PACKAGE = import.meta.dir

const boot = (options: Parameters<typeof createRuntime>[0] = {}) => {
  const clock = createClock()
  clock.set(T0)
  clock.freeze()
  const runtime = createRuntime({ latency: "none", clock, ...options })
  const fetch = (request: Request) => runtime.fetch(request)
  return { runtime, clock, fetch, client: consumer(BASE, fetch, { now: clock.now }) }
}

const admin = async (
  runtime: { fetch: (r: Request) => Promise<Response> },
  method: string,
  path: string,
  body?: unknown,
) => {
  const response = await runtime.fetch(
    new Request(`${BASE}/__admin${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  const text = await response.text()
  return {
    status: response.status,
    json: (text ? JSON.parse(text) : null) as Record<string, unknown>,
  }
}

const token = (
  base: string,
  fetch: (r: Request) => Promise<Response>,
  clientId: string,
  secret = "anything-at-all",
) =>
  fetch(
    new Request(`${base}/api/v2/auth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-vendor-id": "10001",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: secret,
      }),
    }),
  )

const textFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    if (["node_modules", "dist", ".soak"].includes(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await textFiles(path)))
    else if (/\.(ts|json|yaml|md)$/.test(entry.name)) out.push(path)
  }
  return out
}

describe("what the package publishes", () => {
  const sandboxPairs = new Set(SANDBOX_STATUSES.map((s) => `${s.id}\u0000${s.label}`))
  const synthetic = (status: { id: string; label: string }) =>
    sandboxPairs.has(`${status.id}\u0000${status.label}`) ||
    /^Production Status P-\d{2}$/.test(status.label)

  test("the production catalog keeps its status codes but only LifeFile-default or synthetic labels", async () => {
    expect(PRODUCTION_STATUSES).toHaveLength(55)
    expect(PRODUCTION_STATUSES.filter((s) => !synthetic(s))).toEqual([])
    const file = (await Bun.file(join(PACKAGE, "corpus", "statuses.json")).json()) as {
      production: { id: string; label: string }[]
    }
    expect(file.production.filter((s) => !synthetic(s))).toEqual([])
  })

  test("the production shipping services are synthetic: names, ids, prices and colours", () => {
    const services = CATALOG_DATA.production.shippingServices as unknown as Record<
      string,
      unknown
    >[]
    expect(services.length).toBeGreaterThan(0)
    for (const [index, service] of services.entries()) {
      expect(service.name).toBe(`Production Shipping S-${index + 1}`)
      expect(service.id).toBe(60_001 + index)
      expect(service.color ?? null).toBeNull()
      expect([0, 10, 20, 30]).toContain(service.price as number)
    }
  })

  test("no published file names a vendor server path", async () => {
    const offenders: string[] = []
    for (const path of await textFiles(PACKAGE)) {
      if (path.endsWith("hardening.test.ts")) continue
      const text = await Bun.file(path).text()
      if (/\/var\/www|\.php\b/.test(text)) offenders.push(path.slice(PACKAGE.length + 1))
    }
    expect(offenders).toEqual([])
  })
})

describe("serve limits for a long-lived local stack", () => {
  test("--max-records caps the default namespace with a 507", async () => {
    const runtime = (await serveTarget.create(
      { "no-latency": true, "max-records": "20" },
      COMMON,
    )) as ReturnType<typeof createRuntime>
    const client = consumer(BASE, (r) => runtime.fetch(r))
    let refused = 0
    for (let i = 0; i < 15; i++) {
      const created = await client.createOrder(orderBody({ uuid: crypto.randomUUID() }))
      if (!created.ok && created.failure.httpStatus === 507) refused++
    }
    expect(refused).toBeGreaterThan(0)
  })

  test("serve caps snapshots by default (50) and --max-snapshots changes it", async () => {
    const runtime = (await serveTarget.create({ "no-latency": true }, COMMON)) as ReturnType<
      typeof createRuntime
    >
    for (let i = 0; i < 50; i++) {
      expect((await admin(runtime, "POST", "/snapshots", { name: `s${i}` })).status).toBe(201)
    }
    expect((await admin(runtime, "POST", "/snapshots", { name: "s50" })).status).toBe(400)
    const two = (await serveTarget.create(
      { "no-latency": true, "max-snapshots": "2" },
      COMMON,
    )) as ReturnType<typeof createRuntime>
    await admin(two, "POST", "/snapshots", { name: "a" })
    await admin(two, "POST", "/snapshots", { name: "b" })
    expect((await admin(two, "POST", "/snapshots", { name: "c" })).status).toBe(400)
  })

  test("serve skips the per-write checkpoint by default, so a write never reads the whole namespace", async () => {
    const created = async (values: Record<string, string | boolean>) => {
      const runtime = (await serveTarget.create(values, COMMON)) as ReturnType<typeof createRuntime>
      const fetch = (r: Request) => runtime.fetch(r)
      const issued = (await (
        await token(BASE, fetch, "lifefile-client", "lifefile-secret")
      ).json()) as { access_token: string }
      const response = await fetch(
        new Request(`${BASE}/api/v2/orders`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${issued.access_token}`,
            "x-vendor-id": "10001",
            "content-type": "application/json",
          },
          body: JSON.stringify(orderBody()),
        }),
      )
      expect(response.status).toBe(200)
      return response.headers.get("x-mockingbird-checkpoint")
    }
    expect(await created({ "no-latency": true })).toBeNull()
    expect(await created({ "no-latency": true, "checkpoint-mutations": true })).not.toBeNull()
  })

  test.each([
    ["max-records", "0"],
    ["max-records", "abc"],
    ["max-snapshots", "-1"],
  ])("--%s %s is refused", (flag, value) => {
    expect(() => serveTarget.create({ [flag]: value }, COMMON)).toThrow(`--${flag}`)
  })

  test("signing in again and again leaves only live tokens behind", async () => {
    const { runtime, clock } = boot()
    for (let i = 0; i < 5; i++) {
      const client = consumer(BASE, (r) => runtime.fetch(r), { now: clock.now })
      expect((await client.call("GET", "/ping")).ok).toBe(true)
      clock.advance(2 * 3_600_000)
    }
    expect(runtime.instance().state.tokens.count()).toBe(1)
  })

  test("a revoked token stays dead after later sign-ins prune the token rows", async () => {
    const { runtime, clock } = boot()
    const fetch = (r: Request) => runtime.fetch(r)
    const issued = (await (
      await token(BASE, fetch, "lifefile-client", "lifefile-secret")
    ).json()) as {
      access_token: string
    }
    const call = (method: string, path: string) =>
      fetch(
        new Request(`${BASE}/api/v2${path}`, {
          method,
          headers: { authorization: `Bearer ${issued.access_token}`, "x-vendor-id": "10001" },
        }),
      )
    expect((await call("GET", "/ping")).status).toBe(200)
    expect((await call("DELETE", "/auth/token")).status).toBeLessThan(300)
    clock.advance(60_000)
    expect((await token(BASE, fetch, "lifefile-client", "lifefile-secret")).status).toBe(200)
    expect((await call("GET", "/ping")).status).toBe(401)
  })
})

describe("enrollment", () => {
  test("serve with --client-id closes open enrollment: an unknown client is invalid_client", async () => {
    const runtime = (await serveTarget.create(
      { "no-latency": true, "client-id": "stack-client", "client-secret": "stack-secret" },
      COMMON,
    )) as ReturnType<typeof createRuntime>
    const fetch = (r: Request) => runtime.fetch(r)
    const refused = await token(BASE, fetch, "stack-clinet")
    expect(refused.status).toBe(401)
    expect(await refused.json()).toEqual({
      error: "invalid_client",
      error_description: "Invalid Credentials",
    })
    const known = consumer(BASE, fetch, { clientId: "stack-client", clientSecret: "stack-secret" })
    expect((await known.call("GET", "/ping")).ok).toBe(true)
  })

  test("--open-enrollment keeps it open beside a seeded client", async () => {
    const runtime = (await serveTarget.create(
      { "no-latency": true, "client-id": "stack-client", "open-enrollment": true },
      COMMON,
    )) as ReturnType<typeof createRuntime>
    expect((await token(BASE, (r) => runtime.fetch(r), "someone-new")).status).toBe(200)
  })

  test("serve with no client keeps open enrollment, as the banner says", async () => {
    const runtime = (await serveTarget.create({ "no-latency": true }, COMMON)) as ReturnType<
      typeof createRuntime
    >
    expect((await token(BASE, (r) => runtime.fetch(r), "someone-new")).status).toBe(200)
  })

  test("openEnrollment: false refuses unknown clients and still serves known ones", async () => {
    const { runtime, client } = boot({ settings: { openEnrollment: false } })
    expect((await token(BASE, (r) => runtime.fetch(r), "someone-new")).status).toBe(401)
    expect((await client.call("GET", "/ping")).ok).toBe(true)
  })
})

describe("rate limits", () => {
  test("requests naming unknown vendors share one window instead of one each", async () => {
    const { runtime } = boot()
    await admin(runtime, "PUT", "/settings", { rateLimits: { api: 5, token: 120 } })
    const statuses: number[] = []
    for (let i = 0; i < 7; i++) {
      const response = await runtime.fetch(
        new Request(`${BASE}/api/v2/ping`, { headers: { "x-vendor-id": String(70_000 + i) } }),
      )
      statuses.push(response.status)
    }
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true)
    expect(statuses.slice(5)).toEqual([429, 429])
  })

  test("rateLimits: null turns limiting off for a test stack", async () => {
    const { runtime, client } = boot()
    const put = await admin(runtime, "PUT", "/settings", { rateLimits: null })
    expect(put.status).toBe(200)
    for (let i = 0; i < 130; i++) {
      const signedIn = consumer(BASE, (r) => runtime.fetch(r))
      expect((await signedIn.call("GET", "/ping")).ok).toBe(true)
    }
    expect((await client.call("GET", "/ping")).ok).toBe(true)
  })
})

describe("admin settings refuse values that would break the namespace", () => {
  test.each([
    ["timeZone", { timeZone: "Not/AZone" }],
    ["rateLimits", { rateLimits: { api: 0, token: 120 } }],
    ["rateLimits", { rateLimits: { api: 10, token: -1 } }],
    ["rateLimits", { rateLimits: { api: 1.5, token: 120 } }],
    ["intake", { intake: { status: "zzzzz", afterMs: 500 } }],
    ["intake", { intake: { status: "b3644", afterMs: -1 } }],
    ["fastTrackStatus", { fastTrackStatus: "zzzzz" }],
    ["practice", { practice: { id: 1.5, name: "P" } }],
    ["practice", { practice: { id: 0, name: "P" } }],
    ["vendorId", { vendorId: 1.5 }],
    ["fastTrackWindowMs", { fastTrackWindowMs: 0.5 }],
  ])("%s %j is a 400 and leaves the namespace working", async (key, body) => {
    const { runtime, client } = boot()
    const put = await admin(runtime, "PUT", "/settings", body)
    expect(put.status).toBe(400)
    expect(JSON.stringify(put.json)).toContain(key)
    const created = await client.createOrder(orderBody())
    expect(created.ok).toBe(true)
    if (created.ok) expect((await client.order(created.data.orderId)).ok).toBe(true)
  })

  test("a valid time zone and a catalog's own intake code are accepted", async () => {
    const { runtime } = boot()
    expect(
      (
        await admin(runtime, "PUT", "/settings", {
          timeZone: "America/New_York",
          intake: { status: "b3644", afterMs: 0 },
          practice: { id: 900002, name: "Other" },
        })
      ).status,
    ).toBe(200)
  })

  test("the Data Push password never comes back from the settings routes", async () => {
    const { runtime } = boot({
      push: { url: "http://receiver.local/push", username: "push-user", password: "s3cret-pw" },
    })
    const read = await admin(runtime, "GET", "/settings")
    expect(read.json.push).toEqual({ url: "http://receiver.local/push", username: "push-user" })
    const written = await admin(runtime, "PUT", "/settings", {
      push: { url: "http://receiver.local/other", username: "u2", password: "other-pw" },
    })
    expect(written.status).toBe(200)
    expect(JSON.stringify(written.json)).not.toContain("other-pw")
    expect(JSON.stringify(read.json)).not.toContain("s3cret-pw")
  })
})

describe("fast track on the recorded latency and a real clock", () => {
  test("a del sent straight after the create reply still fast-tracks", async () => {
    const runtime = createRuntime({})
    const client = consumer(BASE, (r) => runtime.fetch(r))
    const created = await client.createOrder(orderBody())
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const first = await client.setStatus(created.data.orderId, "del")
    expect(first).toMatchObject({ ok: true, data: { current_order_status: "b3644" } })
  }, 20_000)
})

describe("risk: what the review fixes must not break", () => {
  test("serve without per-write checkpoints still snapshots and restores on request", async () => {
    const runtime = (await serveTarget.create({ "no-latency": true }, COMMON)) as ReturnType<
      typeof createRuntime
    >
    const client = consumer(BASE, (r) => runtime.fetch(r))
    const created = await client.createOrder(orderBody())
    expect(created.ok).toBe(true)
    expect((await admin(runtime, "POST", "/snapshots", { name: "one" })).status).toBe(201)
    await client.createOrder(orderBody())
    expect(runtime.instance().orders()).toHaveLength(2)
    const restored = await admin(runtime, "POST", "/snapshots/one/restore")
    expect(restored.status).toBeLessThan(300)
    expect(runtime.instance().orders()).toHaveLength(1)
  })

  test("a token in use survives the pruning a later sign-in does", async () => {
    const { runtime, clock } = boot()
    const fetch = (r: Request) => runtime.fetch(r)
    const issued = (await (
      await token(BASE, fetch, "lifefile-client", "lifefile-secret")
    ).json()) as { access_token: string }
    const ping = () =>
      fetch(
        new Request(`${BASE}/api/v2/ping`, {
          headers: { authorization: `Bearer ${issued.access_token}`, "x-vendor-id": "10001" },
        }),
      )
    for (let i = 0; i < 3; i++) {
      clock.advance(50 * 60_000)
      expect((await ping()).status).toBe(200)
      expect((await token(BASE, fetch, "lifefile-client", "lifefile-secret")).status).toBe(200)
    }
    expect((await ping()).status).toBe(200)
  })

  test("a flood of unknown vendor ids never uses up the real vendor's window", async () => {
    const { runtime, client } = boot()
    await admin(runtime, "PUT", "/settings", { rateLimits: { api: 5, token: 120 } })
    for (let i = 0; i < 20; i++) {
      await runtime.fetch(
        new Request(`${BASE}/api/v2/ping`, { headers: { "x-vendor-id": String(80_000 + i) } }),
      )
    }
    expect((await client.call("GET", "/ping")).ok).toBe(true)
  })

  test("a vendor known only from an API user keeps its own window", async () => {
    const { runtime } = boot()
    await admin(runtime, "PUT", "/settings", { rateLimits: { api: 3, token: 120 } })
    await admin(runtime, "PUT", "/api-users", {
      clientId: "other-vendor",
      secret: "s",
      vendorId: 10002,
    })
    for (let i = 0; i < 5; i++) {
      await runtime.fetch(
        new Request(`${BASE}/api/v2/ping`, { headers: { "x-vendor-id": String(90_000 + i) } }),
      )
    }
    const other = consumer(BASE, (r) => runtime.fetch(r), {
      clientId: "other-vendor",
      clientSecret: "s",
      vendorId: "10002",
    })
    expect((await other.call("GET", "/ping")).ok).toBe(true)
  })

  test("switching to the production catalog alone still works, and its codes are the real ones", async () => {
    const { runtime, client } = boot()
    expect((await admin(runtime, "PUT", "/settings", { catalog: "production" })).status).toBe(200)
    const created = await client.createOrder(orderBody({ locationId: 100101 }))
    expect(created.ok).toBe(true)
    if (created.ok) expect((await client.setStatus(created.data.orderId, "3c59d")).ok).toBe(true)
    expect(PRODUCTION_STATUSES.map((s) => s.id)).toContain("b4ffc")
    expect(new Set(PRODUCTION_STATUSES.map((s) => s.id)).size).toBe(55)
  })
})

describe("serve bounds a namespace without making every write slower", () => {
  const median = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number

  test("serve's default write cost does not grow with the namespace", async () => {
    const runtime = (await serveTarget.create({ "no-latency": true }, COMMON)) as ReturnType<
      typeof createRuntime
    >
    await admin(runtime, "PUT", "/settings", { rateLimits: null })
    const client = consumer(BASE, (r) => runtime.fetch(r))
    const timedCreate = async () => {
      const started = performance.now()
      const created = await client.createOrder(orderBody({ uuid: crypto.randomUUID() }))
      expect(created.ok).toBe(true)
      return performance.now() - started
    }
    const early: number[] = []
    for (let i = 0; i < 40; i++) early.push(await timedCreate())
    for (let i = 0; i < 1_000; i++)
      await client.createOrder(orderBody({ uuid: crypto.randomUUID() }))
    const late: number[] = []
    for (let i = 0; i < 40; i++) late.push(await timedCreate())
    expect(median(late)).toBeLessThan(Math.max(3 * median(early), 2))
  }, 120_000)

  test("a 20-row order list costs about the same at 200 and 3,000 stored orders", async () => {
    const runtime = (await serveTarget.create({ "no-latency": true }, COMMON)) as ReturnType<
      typeof createRuntime
    >
    await admin(runtime, "PUT", "/settings", { rateLimits: null })
    const client = consumer(BASE, (r) => runtime.fetch(r))
    expect((await client.createOrder(orderBody())).ok).toBe(true)
    const api = runtime.instance()
    const [template] = api.orders()
    if (!template) throw new Error("no order")
    const grow = (to: number) => {
      while (api.state.orderCount() < to) {
        const { id, sequence } = api.state.nextOrderId()
        api.state.saveOrder({ ...template, id, sequence })
      }
    }
    const timedList = async () => {
      const started = performance.now()
      const listed = await client.call<{ data: unknown[] }>("GET", "/orders?perPage=20")
      expect(listed.ok && listed.data.data.length).toBe(20)
      return performance.now() - started
    }
    const sample = async () => {
      const runs: number[] = []
      for (let i = 0; i < 15; i++) runs.push(await timedList())
      return median(runs)
    }
    grow(200)
    const small = await sample()
    grow(3_000)
    const large = await sample()
    expect(large).toBeLessThan(Math.max(3 * small, 40))
  }, 120_000)

  test("--max-orders refuses the next order with a 507 and writes nothing", async () => {
    const runtime = (await serveTarget.create(
      { "no-latency": true, "max-orders": "3" },
      COMMON,
    )) as ReturnType<typeof createRuntime>
    const client = consumer(BASE, (r) => runtime.fetch(r))
    for (let i = 0; i < 3; i++) expect((await client.createOrder(orderBody())).ok).toBe(true)
    const refused = await client.createOrder(orderBody())
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.failure.httpStatus).toBe(507)
    expect(runtime.instance().orders()).toHaveLength(3)
    await runtime.fetch(new Request(`${BASE}/__admin/reset`, { method: "POST" }))
    expect((await client.createOrder(orderBody())).ok).toBe(true)
  })

  test("serve caps orders at 25,000 by default", () => {
    expect(SERVE_LIMITS.maxOrders).toBe(25_000)
    expect(() => serveTarget.create({ "max-orders": "0" }, COMMON)).toThrow("--max-orders")
  })

  test("open enrollment stops adding API users past maxApiUsers", async () => {
    const { runtime } = boot({ maxApiUsers: 3 })
    const fetch = (r: Request) => runtime.fetch(r)
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) statuses.push((await token(BASE, fetch, `new-${i}`)).status)
    expect(statuses).toEqual([200, 200, 200, 401])
    expect((await token(BASE, fetch, "lifefile-client", "lifefile-secret")).status).toBe(200)
  })
})

describe("the API user cap counts only open enrollment", () => {
  test("seeded and admin-added users never use up maxApiUsers", async () => {
    const { runtime } = boot({
      maxApiUsers: 1,
      apiUsers: [
        { clientId: "seeded-a", secret: "secret-a" },
        { clientId: "seeded-b", secret: "secret-b" },
      ],
    })
    const fetch = (r: Request) => runtime.fetch(r)
    expect((await token(BASE, fetch, "enrolled-1")).status).toBe(200)
    expect((await token(BASE, fetch, "enrolled-2")).status).toBe(401)
    expect((await token(BASE, fetch, "seeded-a", "secret-a")).status).toBe(200)
  })
})

describe("namespace deletion", () => {
  test("deleting a namespace leaves none of its records behind", async () => {
    const { runtime } = boot()
    const fetch = (r: Request) => runtime.fetch(r)
    await consumer(BASE, fetch).call("GET", "/ping")
    const before = runtime.resources().records
    for (let i = 0; i < 5; i++) {
      const c = consumer(`${BASE}/__admin/ns/gone-${i}`, fetch)
      expect((await c.createOrder(orderBody())).ok).toBe(true)
      const deleted = await fetch(
        new Request(`${BASE}/__admin/namespaces/gone-${i}`, { method: "DELETE" }),
      )
      expect(deleted.status).toBe(200)
    }
    expect(runtime.resources().records).toBe(before)
  })

  test("a reset namespace still serves the seeded client and settings", async () => {
    const { runtime, client } = boot({ settings: { catalog: "production", intake: null } })
    expect((await client.call("GET", "/ping")).ok).toBe(true)
    await runtime.fetch(new Request(`${BASE}/__admin/reset`, { method: "POST" }))
    const fresh = consumer(BASE, (r) => runtime.fetch(r))
    expect((await fresh.call("GET", "/ping")).ok).toBe(true)
    expect((await admin(runtime, "GET", "/settings")).json).toMatchObject({ catalog: "production" })
    expect(((await admin(runtime, "GET", "/api-users")).json.apiUsers as unknown[]).length).toBe(1)
  })

  const closed = () =>
    boot({
      settings: { catalog: "production", intake: null, timeZone: "UTC", openEnrollment: false },
      apiUsers: [{ clientId: "stack-client", secret: "stack-secret" }],
    })

  const keepsBoot = async (
    runtime: ReturnType<typeof createRuntime>,
    fetch: (r: Request) => Promise<Response>,
  ) => {
    expect((await admin(runtime, "GET", "/settings")).json).toMatchObject({
      catalog: "production",
      intake: null,
      timeZone: "UTC",
      openEnrollment: false,
    })
    expect((await token(BASE, fetch, "stack-client", "stack-secret")).status).toBe(200)
    expect((await token(BASE, fetch, "unknown-client")).status).toBe(401)
  }

  test("restoring a snapshot taken right after a reset keeps the boot settings and API users", async () => {
    const { runtime, fetch } = closed()
    expect((await token(BASE, fetch, "stack-client", "stack-secret")).status).toBe(200)
    await runtime.fetch(new Request(`${BASE}/__admin/reset`, { method: "POST" }))
    expect((await admin(runtime, "POST", "/snapshots", { name: "clean" })).status).toBeLessThan(300)
    expect((await token(BASE, fetch, "stack-client", "stack-secret")).status).toBe(200)
    expect((await admin(runtime, "POST", "/snapshots/clean/restore")).status).toBeLessThan(300)
    await keepsBoot(runtime, fetch)
  })

  test("the API user list right after a reset shows the seeded client", async () => {
    const { runtime } = closed()
    expect((await admin(runtime, "GET", "/api-users")).json.apiUsers).toHaveLength(1)
    await runtime.fetch(new Request(`${BASE}/__admin/reset`, { method: "POST" }))
    const listed = (await admin(runtime, "GET", "/api-users")).json.apiUsers as {
      clientId: string
    }[]
    expect(listed.map((user) => user.clientId)).toEqual(["stack-client"])
    expect(listed[0]).not.toHaveProperty("secret")
  })

  test("checking out the first checkpoint after a reset keeps the boot settings and API users", async () => {
    const { runtime, fetch } = closed()
    expect((await token(BASE, fetch, "stack-client", "stack-secret")).status).toBe(200)
    await runtime.reset()
    expect((await token(BASE, fetch, "stack-client", "stack-secret")).status).toBe(200)
    const first = runtime.timeline().checkpoints()[0]
    expect(first).toBeDefined()
    runtime.checkout(first?.id as string)
    await keepsBoot(runtime, fetch)
  })
})

describe("a refused status write leaves due intake on time", () => {
  const refusedThenWait = async (
    write: (client: ReturnType<typeof consumer>, id: number) => Promise<unknown>,
    rateLimits?: { api: number; token: number },
  ) => {
    const received: string[] = []
    const runtime = createRuntime({
      latency: "none",
      settings: {
        intake: { status: "b3644", afterMs: 300 },
        ...(rateLimits ? { rateLimits } : {}),
      },
      push: {
        url: "http://receiver.local/webhooks/lifefile",
        username: "push-user",
        password: "push-pass",
        retryDelaysMs: [0],
        fetch: async (request: Request) => {
          const body = (await request.json()) as { status: { id: string } }
          received.push(body.status.id)
          return new Response(null, { status: 200 })
        },
      },
    })
    const client = consumer(BASE, (r) => runtime.fetch(r))
    const created = await client.createOrder(orderBody())
    if (!created.ok) throw new Error("create failed")
    const id = created.data.orderId
    const until = Date.now() + 320
    while (Date.now() < until) {}
    await write(client, id)
    await new Promise((resolve) => setTimeout(resolve, 800))
    await runtime.webhooks.idle()
    return { status: runtime.instance().state.order(id)?.statusId, received }
  }

  test("an unknown status code (404) is followed by intake with one push", async () => {
    const outcome = await refusedThenWait(async (client, id) => {
      const write = await client.setStatus(id, "no-such-code")
      expect(write.ok).toBe(false)
      if (!write.ok) expect(write.failure.httpStatus).toBe(404)
    })
    expect(outcome).toEqual({ status: "b3644", received: ["b3644"] })
  })

  test("a missing status (422) is followed by intake with one push", async () => {
    const outcome = await refusedThenWait(async (client, id) => {
      const write = await client.call("PUT", `/orders/${id}/status`, {})
      expect(write.ok).toBe(false)
      if (!write.ok) expect(write.failure.httpStatus).toBe(422)
    })
    expect(outcome).toEqual({ status: "b3644", received: ["b3644"] })
  })

  test("a rate-limited status write (429) is followed by intake with one push", async () => {
    const intoMinute = Date.now() % 60_000
    if (intoMinute > 55_000)
      await new Promise((resolve) => setTimeout(resolve, 60_100 - intoMinute))
    const outcome = await refusedThenWait(
      async (client, id) => {
        const write = await client.setStatus(id, "del")
        expect(write.ok).toBe(false)
        if (!write.ok) expect(write.failure.httpStatus).toBe(429)
      },
      { api: 1, token: 120 },
    )
    expect(outcome).toEqual({ status: "b3644", received: ["b3644"] })
  }, 15_000)

  test("an accepted status write is not overwritten by the intake that runs after it", async () => {
    const outcome = await refusedThenWait(async (client, id) => {
      expect((await client.setStatus(id, "be584")).ok).toBe(true)
    })
    expect(outcome.status).toBe("be584")
    expect(outcome.received.at(-1)).toBe("be584")
  })
})

describe("a bearer token lives only in the namespace state that issued it", () => {
  const signIn = async (fetch: (r: Request) => Promise<Response>, base = BASE) =>
    (
      (await (await token(base, fetch, "lifefile-client", "lifefile-secret")).json()) as {
        access_token: string
      }
    ).access_token

  const ping = (fetch: (r: Request) => Promise<Response>, bearer: string, namespace?: string) =>
    fetch(
      new Request(`${BASE}/api/v2/ping`, {
        headers: {
          authorization: `Bearer ${bearer}`,
          "x-vendor-id": "10001",
          ...(namespace ? { "x-mockingbird-namespace": namespace } : {}),
        },
      }),
    ).then((r) => r.status)

  const revoke = (fetch: (r: Request) => Promise<Response>, bearer: string, namespace?: string) =>
    fetch(
      new Request(`${BASE}/api/v2/auth/token`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${bearer}`,
          "x-vendor-id": "10001",
          ...(namespace ? { "x-mockingbird-namespace": namespace } : {}),
        },
      }),
    ).then((r) => r.status)

  test("a revoked token stays dead after a reset, and a new sign-in works", async () => {
    const { fetch } = boot()
    const old = await signIn(fetch)
    expect(await revoke(fetch, old)).toBe(200)
    expect(await ping(fetch, old)).toBe(401)
    await fetch(new Request(`${BASE}/__admin/reset`, { method: "POST" }))
    expect(await ping(fetch, old)).toBe(401)
    expect(await ping(fetch, await signIn(fetch))).toBe(200)
  })

  test("a revoked token stays dead after its namespace is deleted", async () => {
    const { fetch } = boot()
    const base = `${BASE}/__admin/ns/ns-delete`
    const old = await signIn(fetch, base)
    expect(await revoke(fetch, old, "ns-delete")).toBe(200)
    expect(
      (await fetch(new Request(`${BASE}/__admin/namespaces/ns-delete`, { method: "DELETE" })))
        .status,
    ).toBe(200)
    expect(await ping(fetch, old, "ns-delete")).toBe(401)
  })

  test("a token from one namespace is refused in another", async () => {
    const { fetch } = boot()
    const bearer = await signIn(fetch)
    expect(await ping(fetch, bearer)).toBe(200)
    expect(await ping(fetch, bearer, "other-ns")).toBe(401)
  })
})
