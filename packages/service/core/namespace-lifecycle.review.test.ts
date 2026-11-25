/**
 * The edges of namespace clean-up a long-running mock meets: a sweep that fails, in-process
 * callers, runtimes sharing a database, handlers that write more than once, requests still in
 * flight, and the counters that say what clean-up did.
 */
import { describe, expect, test } from "bun:test"
import { Database } from "@crvouga/mockingbird-service-sqlite"
import { admin, create, list, mock, ns, send } from "./controls.fixture.js"
import {
  Collection,
  createRuntime,
  createWebhookHub,
  type InstanceContext,
  signers,
  withNamespaceRollback,
} from "./src/index.js"

const MINUTE = 60_000

const wallClock = () => {
  let now = 1_000_000
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

const bare = (
  options: {
    namespaceIdleMs?: number
    maxRecords?: number
    wallNow?: () => number
    sqlite?: Database
  },
  handler: (context: InstanceContext, request: Request) => Promise<Response>,
  reset: (context: InstanceContext) => Promise<void> = async () => {},
) =>
  createRuntime({
    name: "bare",
    ...(options.namespaceIdleMs !== undefined ? { namespaceIdleMs: options.namespaceIdleMs } : {}),
    ...(options.maxRecords !== undefined ? { maxRecords: options.maxRecords } : {}),
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    io: { wallNow: options.wallNow ?? Date.now, heapUsedBytes: () => 0 },
    create: (context) => ({
      fetch: (request) => handler(context, request),
      reset: () => reset(context),
    }),
  })

describe("a failing idle sweep never reaches an unrelated request", () => {
  test("the request answers, the failure is counted, and the namespace is retried", async () => {
    const wall = wallClock()
    let failing = true
    const runtime = bare(
      { namespaceIdleMs: MINUTE, wallNow: wall.now },
      async () => new Response("ok"),
      async (context) => {
        if (failing && context.publicNamespace === "bad") throw new Error("reset blew up")
      },
    )
    await send(runtime, "GET", "/thing", { headers: ns("bad") })
    wall.advance(2 * MINUTE)
    const answered = await send(runtime, "GET", "/thing", { headers: ns("good") })
    expect(answered.status).toBe(200)
    expect(runtime.resources()).toMatchObject({ idleExpiryFailures: 1, namespacesExpired: 0 })
    expect(runtime.namespaces()).toContain("bad")
    failing = false
    wall.advance(2 * MINUTE)
    await send(runtime, "GET", "/thing", { headers: ns("good") })
    expect(runtime.namespaces()).not.toContain("bad")
    expect(runtime.resources()).toMatchObject({ idleExpiryFailures: 1, namespacesExpired: 1 })
  })
})

describe("what counts as naming a namespace", () => {
  test("runtime.instance(key) on an existing namespace keeps it alive", async () => {
    const wall = wallClock()
    const runtime = mock({ namespaceIdleMs: 30 * MINUTE, io: { wallNow: wall.now } })
    await create(runtime, "a", ns("inproc"))
    wall.advance(25 * MINUTE)
    runtime.instance("inproc")
    wall.advance(25 * MINUTE)
    await send(runtime, "GET", "/__admin/health")
    expect((await list(runtime, ns("inproc"))).map((note) => note.text)).toEqual(["a"])
  })

  test("a header naming a namespace that holds nothing is not tracked or swept", async () => {
    const wall = wallClock()
    const runtime = mock({ namespaceIdleMs: MINUTE, io: { wallNow: wall.now } })
    for (let i = 0; i < 20; i++)
      await send(runtime, "GET", "/__admin/health", { headers: ns(`ghost${i}`) })
    wall.advance(2 * MINUTE)
    await send(runtime, "GET", "/__admin/health")
    expect(runtime.resources().namespacesExpired).toBe(0)
  })
})

describe("expiry leaves a request in flight alone", () => {
  test("a namespace with a request still running is not dropped under it", async () => {
    const wall = wallClock()
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runtime = bare(
      { namespaceIdleMs: MINUTE, wallNow: wall.now },
      async (context, request) => {
        const rows = new Collection<string>(context.sqlite, context.namespace, "rows")
        if (new URL(request.url).pathname === "/slow") {
          rows.insert("before", "x")
          await gate
          return new Response(String(rows.count()))
        }
        return new Response("ok")
      },
    )
    const slow = send(runtime, "POST", "/slow", { headers: ns("slow") })
    await new Promise((resolve) => setTimeout(resolve, 0))
    wall.advance(2 * MINUTE)
    await send(runtime, "GET", "/other", { headers: ns("other") })
    expect(runtime.namespaces()).toContain("slow")
    release()
    expect(await (await slow).text()).toBe("1")
    expect(runtime.resources().namespacesExpired).toBe(0)
  })
})

describe("the record cap belongs to the runtime that set it", () => {
  test("a runtime without maxRecords on a shared database is never capped", async () => {
    const sqlite = new Database()
    const capped = mock({ name: "capped", sqlite, maxRecords: 1 })
    const free = mock({ name: "free", sqlite })
    expect((await create(capped, "1")).status).toBe(200)
    expect((await create(capped, "2")).status).toBe(507)
    expect((await create(free, "1")).status).toBe(200)
    expect((await create(free, "2")).status).toBe(200)
  })

  test("two capped runtimes on one database each keep their own cap", async () => {
    const sqlite = new Database()
    const one = mock({ name: "one", sqlite, maxRecords: 1 })
    const three = mock({ name: "three", sqlite, maxRecords: 3 })
    expect((await create(one, "1")).status).toBe(200)
    expect((await create(one, "2")).status).toBe(507)
    for (const text of ["1", "2", "3"]) expect((await create(three, text)).status).toBe(200)
    expect((await create(three, "4")).status).toBe(507)
  })
})

describe("a request refused at the record cap stores nothing", () => {
  test("a handler that writes twice keeps neither write", async () => {
    const runtime = bare({ maxRecords: 1 }, async (context) => {
      new Collection<string>(context.sqlite, context.namespace, "orders").insert("o1", "order")
      new Collection<string>(context.sqlite, context.namespace, "events").insert("e1", "event")
      return new Response("ok")
    })
    const refused = await send(runtime, "POST", "/orders", { headers: ns("w") })
    expect(refused.status).toBe(507)
    expect(runtime.resources().records).toBe(0)
    expect(runtime.resources().recordLimitRefusals).toBe(1)
  })

  test("the refusal is journalled as 507 and commits no checkpoint", async () => {
    const runtime = mock({ maxRecords: 1 })
    const accepted = await create(runtime, "1")
    const refused = await create(runtime, "2")
    expect(refused.status).toBe(507)
    expect(refused.headers.get("x-mockingbird-checkpoint")).toBeNull()
    expect(accepted.headers.get("x-mockingbird-checkpoint")).not.toBeNull()
    const journal = await admin<{ requests: unknown[] }>(runtime, "GET", "/requests?status=507")
    expect(journal.body.requests).toHaveLength(1)
    expect(runtime.resources().recordLimitRefusals).toBe(1)
  })
})

describe("clean-up is counted", () => {
  test("expired namespaces and refused snapshots show in resources", async () => {
    const wall = wallClock()
    const runtime = mock({
      namespaceIdleMs: MINUTE,
      maxSnapshots: 1,
      io: { wallNow: wall.now, heapUsedBytes: () => 0 },
    })
    await admin(runtime, "POST", "/snapshots", { name: "a" }, ns("w"))
    await admin(runtime, "POST", "/snapshots", { name: "b" }, ns("w"))
    await create(runtime, "x", ns("gone"))
    wall.advance(2 * MINUTE)
    await send(runtime, "GET", "/__admin/health", { headers: ns("w") })
    expect(runtime.resources()).toMatchObject({
      namespacesExpired: 1,
      snapshotLimitRefusals: 1,
      recordLimitRefusals: 0,
      idleExpiryFailures: 0,
    })
  })
})

describe("risk checks around clean-up", () => {
  test("a namespace idle for exactly namespaceIdleMs is kept; one millisecond more is not", async () => {
    const wall = wallClock()
    const runtime = mock({ namespaceIdleMs: MINUTE, io: { wallNow: wall.now } })
    await create(runtime, "a", ns("edge"))
    wall.advance(MINUTE)
    await send(runtime, "GET", "/__admin/health")
    expect(runtime.namespaces()).toContain("edge")
    wall.advance(1)
    await send(runtime, "GET", "/__admin/health")
    expect(runtime.namespaces()).not.toContain("edge")
  })

  test("a request naming a namespace while it is being forgotten starts it fresh and keeps its write", async () => {
    const wall = wallClock()
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let gated = false
    const runtime = bare(
      { namespaceIdleMs: MINUTE, wallNow: wall.now },
      async (context, request) => {
        const rows = new Collection<string>(context.sqlite, context.namespace, "rows")
        if (request.method === "POST") rows.insert(`r${rows.count()}`, "x")
        return new Response(String(rows.count()))
      },
      async (context) => {
        if (context.publicNamespace === "old" && !gated) {
          gated = true
          await gate
        }
        const rows = new Collection<string>(context.sqlite, context.namespace, "rows")
        for (const row of rows.list()) rows.delete(row.id)
      },
    )
    await send(runtime, "POST", "/rows", { headers: ns("old") })
    wall.advance(2 * MINUTE)
    const sweeping = send(runtime, "GET", "/rows", { headers: ns("other") })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const writing = send(runtime, "POST", "/rows", { headers: ns("old") })
    await new Promise((resolve) => setTimeout(resolve, 0))
    release()
    await sweeping
    await writing
    expect(runtime.namespaces()).toContain("old")
    expect(await (await send(runtime, "GET", "/rows", { headers: ns("old") })).text()).toBe("1")
  })

  test("a write sent in the same tick as the request that sweeps its namespace is kept", async () => {
    const wall = wallClock()
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let gated = false
    const runtime = bare(
      { namespaceIdleMs: MINUTE, wallNow: wall.now },
      async (context, request) => {
        const rows = new Collection<string>(context.sqlite, context.namespace, "rows")
        if (request.method === "POST") rows.insert(`r${rows.count()}`, "x")
        return new Response(String(rows.count()))
      },
      async (context) => {
        if (context.publicNamespace === "old" && !gated) {
          gated = true
          await gate
        }
        const rows = new Collection<string>(context.sqlite, context.namespace, "rows")
        for (const row of rows.list()) rows.delete(row.id)
      },
    )
    await send(runtime, "POST", "/rows", { headers: ns("old") })
    wall.advance(2 * MINUTE)
    const sweeping = send(runtime, "GET", "/rows", { headers: ns("other") })
    const writing = send(runtime, "POST", "/rows", { headers: ns("old") })
    await new Promise((resolve) => setTimeout(resolve, 0))
    release()
    await sweeping
    const written = await (await writing).text()
    const read = await (await send(runtime, "GET", "/rows", { headers: ns("old") })).text()
    expect(read).toBe(written)
    expect(read).toBe("1")
  })

  test("a namespace that only ever received controls is expired once idle", async () => {
    const wall = wallClock()
    const runtime = bare(
      { namespaceIdleMs: MINUTE, wallNow: wall.now },
      async () => new Response("ok"),
    )
    const set = await admin(runtime, "PUT", "/controls", { seed: 7 }, ns("controls-only"))
    expect(set.status).toBe(200)
    wall.advance(2 * MINUTE)
    await send(runtime, "GET", "/__admin/health")
    const after = await admin<{ seed: number | string }>(
      runtime,
      "GET",
      "/controls",
      undefined,
      ns("controls-only"),
    )
    expect(after.body.seed).not.toBe(7)
  })

  test("after a refusal the next accepted write is kept and the namespace is not stuck at the cap", async () => {
    const runtime = bare({ maxRecords: 2 }, async (context, request) => {
      const rows = new Collection<string>(context.sqlite, context.namespace, "rows")
      const path = new URL(request.url).pathname
      if (path === "/two") {
        rows.insert(`a${rows.count()}`, "x")
        rows.insert(`b${rows.count()}`, "x")
      }
      if (path === "/one") rows.insert(`c${rows.count()}`, "x")
      if (path === "/drop") rows.delete(rows.list()[0]?.id ?? "")
      return new Response(String(rows.count()))
    })
    await send(runtime, "POST", "/one", { headers: ns("w") })
    expect((await send(runtime, "POST", "/two", { headers: ns("w") })).status).toBe(507)
    expect(runtime.resources().records).toBe(1)
    expect((await send(runtime, "POST", "/one", { headers: ns("w") })).status).toBe(200)
    expect(runtime.resources().records).toBe(2)
  })

  test("a handler using its own withNamespaceRollback still answers 507 with nothing kept", async () => {
    const runtime = bare({ maxRecords: 1 }, async (context) => {
      await withNamespaceRollback(context.sqlite, context.namespace, async () => {
        new Collection<string>(context.sqlite, context.namespace, "a").insert("1", "x")
        new Collection<string>(context.sqlite, context.namespace, "b").insert("2", "x")
      })
      return new Response("ok")
    })
    expect((await send(runtime, "POST", "/x", { headers: ns("w") })).status).toBe(507)
    expect(runtime.resources().records).toBe(0)
  })

  test("with every option off a mock reports zero clean-up and never expires anything", async () => {
    const wall = wallClock()
    const runtime = mock({ io: { wallNow: wall.now, heapUsedBytes: () => 0 } })
    for (let i = 0; i < 5; i++) await create(runtime, `n${i}`, ns(`n${i}`))
    wall.advance(365 * 24 * 60 * MINUTE)
    await send(runtime, "GET", "/__admin/health")
    expect(runtime.resources()).toMatchObject({
      records: 5,
      namespacesExpired: 0,
      idleExpiryFailures: 0,
      recordLimitRefusals: 0,
      snapshotLimitRefusals: 0,
    })
  })

  test("trimming finished deliveries in one namespace leaves another namespace's alone", async () => {
    const hub = createWebhookHub({
      signer: signers.none(),
      endpoints: [{ url: "http://receiver.example.test/hook" }],
      keep: 2,
      fetch: async () => new Response("ok"),
    })
    for (let i = 0; i < 3; i++) {
      hub.publish({ namespace: "b", type: "note.created", body: { i } })
      await hub.idle()
    }
    for (let i = 0; i < 6; i++) {
      hub.publish({ namespace: "a", type: "note.created", body: { i } })
      await hub.idle()
    }
    expect(hub.deliveries("a")).toHaveLength(2)
    expect(hub.deliveries("b")).toHaveLength(2)
  })
})
