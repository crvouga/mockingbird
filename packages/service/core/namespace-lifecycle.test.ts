/**
 * A mock that stays up for hours keeps only what live tests use: a namespace nobody names
 * for a while is forgotten, a dropped one releases everything it held, records and snapshots
 * stop at a cap with a clear error, and `GET /__admin/metrics` reports what is held.
 */
import { describe, expect, test } from "bun:test"
import { Database } from "@crvouga/mockingbird-service-sqlite"
import { migrateCore } from "@crvouga/mockingbird-sqlite"
import { admin, create, list, mock, ns, send } from "./controls.fixture.js"
import {
  Collection,
  ControlError,
  createRuntime,
  createWebhookHub,
  RecordLimitError,
  type ResourceReport,
  setRecordLimit,
  signers,
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

const resources = async (runtime: ReturnType<typeof mock>) =>
  (await admin<{ resources: ResourceReport }>(runtime, "GET", "/metrics?resources=1")).body
    .resources

describe("idle namespaces are forgotten", () => {
  test("a namespace no request names for longer than namespaceIdleMs is dropped", async () => {
    const wall = wallClock()
    const runtime = mock({ namespaceIdleMs: 30 * MINUTE, io: { wallNow: wall.now } })
    await create(runtime, "a", ns("old"))
    await create(runtime, "b", ns("busy"))
    wall.advance(20 * MINUTE)
    await list(runtime, ns("busy"))
    wall.advance(11 * MINUTE)
    await send(runtime, "GET", "/__admin/health")
    expect(runtime.namespaces()).not.toContain("old")
    expect(runtime.namespaces()).toContain("busy")
    expect(await list(runtime, ns("old"))).toEqual([])
    expect((await list(runtime, ns("busy"))).map((note) => note.text)).toEqual(["b"])
  })

  test("an admin call naming a namespace keeps it alive", async () => {
    const wall = wallClock()
    const runtime = mock({ namespaceIdleMs: 30 * MINUTE, io: { wallNow: wall.now } })
    await create(runtime, "a", ns("watched"))
    wall.advance(25 * MINUTE)
    await admin(runtime, "GET", "/requests", undefined, ns("watched"))
    wall.advance(25 * MINUTE)
    await send(runtime, "GET", "/__admin/health")
    expect((await list(runtime, ns("watched"))).map((note) => note.text)).toEqual(["a"])
  })

  test("the default namespace is never forgotten", async () => {
    const wall = wallClock()
    const runtime = mock({ namespaceIdleMs: MINUTE, io: { wallNow: wall.now } })
    await create(runtime, "kept")
    wall.advance(60 * MINUTE)
    await send(runtime, "GET", "/__admin/health", { headers: ns("other") })
    expect((await list(runtime)).map((note) => note.text)).toEqual(["kept"])
  })

  test("a namespace with a webhook delivery still waiting is kept until it is done", async () => {
    const wall = wallClock()
    const scheduled: (() => void)[] = []
    const hub = createWebhookHub({
      signer: signers.none(),
      endpoints: [{ url: "http://receiver.example.test/hook" }],
      retryDelaysMs: [5 * MINUTE],
      fetch: async () => new Response("ok"),
      schedule: (callback) => {
        scheduled.push(callback)
        return scheduled.length
      },
      cancel: () => {},
    })
    const runtime = mock({ namespaceIdleMs: MINUTE, webhooks: hub, io: { wallNow: wall.now } })
    await create(runtime, "a", ns("pushing"))
    hub.publish({ namespace: "pushing", type: "note.created", body: {} })
    wall.advance(10 * MINUTE)
    await send(runtime, "GET", "/__admin/health")
    expect(runtime.namespaces()).toContain("pushing")
    for (const run of scheduled.splice(0)) run()
    await hub.idle()
    await send(runtime, "GET", "/__admin/health")
    expect(runtime.namespaces()).not.toContain("pushing")
  })

  test("off by default: a namespace idle for days is still there", async () => {
    const wall = wallClock()
    const runtime = mock({ io: { wallNow: wall.now } })
    await create(runtime, "a", ns("patient"))
    wall.advance(10 * 24 * 60 * MINUTE)
    await send(runtime, "GET", "/__admin/health")
    expect((await list(runtime, ns("patient"))).map((note) => note.text)).toEqual(["a"])
  })

  test.each([-1, Number.NaN, 1.5, Number.POSITIVE_INFINITY])(
    "namespaceIdleMs %p is refused when the runtime is created",
    (value) => {
      expect(() => mock({ namespaceIdleMs: value })).toThrow(RangeError)
    },
  )
})

describe("dropping a namespace releases everything it held", () => {
  test("records, snapshots, journal, metrics and waiting webhook timers", async () => {
    const cancelled: unknown[] = []
    const hub = createWebhookHub({
      signer: signers.none(),
      endpoints: [{ url: "http://receiver.example.test/hook" }],
      retryDelaysMs: [5 * MINUTE],
      fetch: async () => new Response("ok"),
      schedule: () => "timer",
      cancel: (handle) => {
        cancelled.push(handle)
      },
    })
    const runtime = mock({ webhooks: hub })
    await create(runtime, "a", ns("w"))
    await admin(runtime, "POST", "/snapshots", { name: "base" }, ns("w"))
    hub.publish({ namespace: "w", type: "note.created", body: {} })
    expect(await resources(runtime)).toMatchObject({
      records: 1,
      snapshots: 1,
      journalEntries: 1,
      webhooksPending: 1,
    })
    expect((await admin(runtime, "DELETE", "/namespaces/w")).status).toBe(200)
    expect(cancelled).toEqual(["timer"])
    expect(await resources(runtime)).toMatchObject({
      records: 0,
      snapshots: 0,
      journalEntries: 0,
      webhooksPending: 0,
    })
    expect(hub.deliveries("w")).toEqual([])
    expect(runtime.metrics.report("w").requests).toBe(0)
  })
})

describe("per-namespace caps", () => {
  test("a write past maxRecords answers 507 and stores nothing", async () => {
    const runtime = mock({ maxRecords: 2 })
    expect((await create(runtime, "1", ns("w"))).status).toBe(200)
    expect((await create(runtime, "2", ns("w"))).status).toBe(200)
    const refused = await create(runtime, "3", ns("w"))
    expect(refused.status).toBe(507)
    const body = (await refused.json()) as { error: { type: string; message: string } }
    expect(body.error.type).toBe("mockingbird_admin")
    expect(body.error.message).toContain("maxRecords")
    expect((await list(runtime, ns("w"))).map((note) => note.text)).toEqual(["1", "2"])
    expect((await create(runtime, "elsewhere", ns("other"))).status).toBe(200)
    await admin(runtime, "POST", "/reset", undefined, ns("w"))
    expect((await create(runtime, "again", ns("w"))).status).toBe(200)
  })

  test("the record cap counts records, not writes: replacing one is always allowed", () => {
    const sqlite = new Database()
    migrateCore(sqlite)
    setRecordLimit(sqlite, "svc", 1)
    const rows = new Collection<number>(sqlite, "svc:w", "rows")
    rows.insert("a", 1)
    rows.insert("a", 2)
    rows.update("a", 3)
    expect(rows.get("a")).toBe(3)
    expect(() => rows.insert("b", 1)).toThrow(RecordLimitError)
    expect(rows.count()).toBe(1)
    expect(() => new Collection<number>(sqlite, "svc:v", "rows").insert("b", 1)).not.toThrow()
    setRecordLimit(sqlite, "svc", undefined)
    expect(() => rows.insert("b", 1)).not.toThrow()
  })

  test("a snapshot past maxSnapshots is refused with 400; reusing a name is not", async () => {
    const runtime = mock({ maxSnapshots: 2 })
    expect((await admin(runtime, "POST", "/snapshots", { name: "a" }, ns("w"))).status).toBe(201)
    expect((await admin(runtime, "POST", "/snapshots", { name: "b" }, ns("w"))).status).toBe(201)
    expect((await admin(runtime, "POST", "/snapshots", { name: "a" }, ns("w"))).status).toBe(201)
    const refused = await admin<{ error: { message: string } }>(
      runtime,
      "POST",
      "/snapshots",
      { name: "c" },
      ns("w"),
    )
    expect(refused.status).toBe(400)
    expect(refused.body.error.message).toContain("maxSnapshots")
    expect(() => runtime.snapshots.create({ name: "c", namespace: "w" })).toThrow(ControlError)
    expect((await admin(runtime, "POST", "/snapshots", { name: "c" }, ns("v"))).status).toBe(201)
  })

  test("a snapshot header past maxSnapshots is refused before the request runs", async () => {
    const runtime = mock({ maxSnapshots: 1 })
    await admin(runtime, "POST", "/snapshots", { name: "a" })
    const refused = await create(runtime, "x", { "x-mockingbird-snapshot": "b" })
    expect(refused.status).toBe(400)
    expect(await list(runtime)).toEqual([])
  })

  test.each([
    ["maxRecords", -1],
    ["maxRecords", 0.5],
    ["maxSnapshots", -1],
    ["maxSnapshots", Number.NaN],
  ])("%s %p is refused when the runtime is created", (key, value) => {
    expect(() => mock({ [key]: value })).toThrow(RangeError)
  })

  test("finished webhook deliveries are kept to the hub's `keep`, waiting ones never dropped", async () => {
    const hub = createWebhookHub({
      signer: signers.none(),
      endpoints: [{ url: "http://receiver.example.test/hook" }],
      keep: 2,
      fetch: async () => new Response("ok"),
    })
    for (let i = 0; i < 5; i++) {
      hub.publish({ namespace: "w", type: "note.created", body: { i } })
      await hub.idle()
    }
    expect(hub.deliveries("w")).toHaveLength(2)
    expect(hub.deliveries("w").every((delivery) => delivery.state === "delivered")).toBe(true)
  })
})

describe("GET /__admin/metrics reports what the mock holds", () => {
  test("live namespaces, records, journal entries, snapshots, waiting webhooks and heap", async () => {
    const runtime = mock({ io: { heapUsedBytes: () => 12_345 } })
    await create(runtime, "a", ns("a"))
    await create(runtime, "b", ns("a"))
    await create(runtime, "c", ns("b"))
    await admin(runtime, "POST", "/snapshots", { name: "s" }, ns("b"))
    expect(runtime.namespaces()).toEqual(expect.arrayContaining(["a", "b"]))
    expect(await resources(runtime)).toEqual({
      namespaces: runtime.namespaces().length,
      records: 3,
      journalEntries: 3,
      snapshots: 1,
      webhooksPending: 0,
      heapUsedBytes: 12_345,
      namespacesExpired: 0,
      idleExpiryFailures: 0,
      recordLimitRefusals: 0,
      snapshotLimitRefusals: 0,
    })
    expect(runtime.resources()).toEqual(await resources(runtime))
  })

  test("only when asked: a plain or namespace-scoped report is unchanged", async () => {
    const runtime = mock()
    await create(runtime, "a", ns("a"))
    expect((await admin(runtime, "GET", "/metrics")).body).not.toHaveProperty("resources")
    const scoped = await admin(runtime, "GET", "/metrics?resources=1", undefined, ns("a"))
    expect(scoped.body).not.toHaveProperty("resources")
  })

  test("records of another service sharing the database are not counted", async () => {
    const sqlite = new Database()
    const other = mock({ name: "other", sqlite })
    const runtime = mock({ name: "notes", sqlite })
    await create(other, "x")
    await create(runtime, "y", ns("a"))
    expect((await resources(runtime)).records).toBe(1)
  })

  test("heap is null where the host cannot say", async () => {
    const runtime = createRuntime({
      name: "bare",
      io: { heapUsedBytes: () => undefined },
      create: () => ({ fetch: async () => new Response("ok"), reset: async () => {} }),
    })
    expect(runtime.resources().heapUsedBytes).toBeNull()
  })
})
