import { describe, expect, test } from "bun:test"
import {
  admin,
  create,
  list,
  type Mock,
  mock,
  type Note,
  ns,
  send,
  T0,
} from "./controls.fixture.js"
import {
  ADMIN_CONTROL_PAGES,
  ADMIN_DOCS_URL,
  ADMIN_KEY_HEADER,
  ADMIN_ROUTE_REFERENCE,
  CONTROL_HEADER_REFERENCE,
  CONTROL_HEADERS,
  ControlError,
  controlHeaders,
  createRuntime,
  DroppedConnectionError,
  FAULT_HEADER,
  jsonRes,
  type MockControls,
  parseControlHeaders,
  parseFaultHeader,
  type ServiceInstance,
  SNAPSHOT_FORMAT,
  SNAPSHOT_HEADER,
  STANDARD_ADMIN_ROUTES,
  STANDARD_FAULT_PRESETS,
} from "./src/index.js"

describe("one control document, three carriers", () => {
  const controls: MockControls = {
    clock: { now: "2030-01-01T00:00:00Z", frozen: true, autoAdvance: "1s" },
    virtualTime: true,
    latency: { delay: "40ms" },
    faults: [{ operationId: "notes.list", status: 503, count: 1 }],
  }

  test("at boot", async () => {
    const runtime = mock({ adminControls: controls })
    expect((await send(runtime, "GET", "/v1/notes")).status).toBe(503)
    const note = (await (await create(runtime, "a")).json()) as Note
    // Two requests stepped the clock one second each, and each spent 40ms of virtual latency.
    expect(note.createdAt).toBe(new Date(T0 + 2 * 1000 + 2 * 40).toISOString())
  })

  test("over the admin API, and it reads back as the same document", async () => {
    const runtime = mock()
    const applied = await admin(runtime, "PUT", "/controls", controls)
    expect(applied.status).toBe(200)
    expect(applied.body).toMatchObject({
      namespace: "default",
      seed: 0,
      virtualTime: true,
      clock: { now: T0, iso: "2030-01-01T00:00:00.000Z", frozen: true, autoAdvanceMs: 1000 },
      latency: { delayMs: 40, jitterMs: 0, operations: {} },
      faults: [{ id: "fault_1", operationId: "notes.list", status: 503, remaining: 1 }],
      snapshots: [],
    })
    expect((await admin(runtime, "GET", "/controls")).body).toEqual(applied.body)
    expect(runtime.controls()).toEqual(applied.body as never)
  })

  test("in process", () => {
    const runtime = mock()
    const state = runtime.configure(controls)
    expect(state.clock).toMatchObject({ now: T0, frozen: true, autoAdvanceMs: 1000 })
    // The namespace's own clock moved. The base clock every namespace follows did not.
    expect(runtime.namespaceClock().state()).toMatchObject({ now: T0, frozen: true })
    expect(runtime.clock.state().frozen).toBe(false)
    expect(runtime.latency.get("default").delayMs).toBe(40)
  })

  test("a bad document is rejected whole, at boot and over HTTP", async () => {
    expect(() => mock({ adminControls: { clock: { now: "yesterday-ish" } } })).toThrow(ControlError)
    expect(() => mock({ adminControls: { faults: [{ status: 99 }] } })).toThrow("fault.status")
    expect(() => mock({ adminControls: { faults: [{ preset: "nope" }] } })).toThrow(
      "no fault preset",
    )
    expect(() => mock({ adminControls: { tempo: 1 } as never })).toThrow('unknown control "tempo"')
    const runtime = mock()
    const bad = await admin(runtime, "PUT", "/controls", {
      latency: "40ms",
      faults: [{ status: 503 }, { statuss: 500 }],
    })
    expect(bad.status).toBe(400)
    expect(bad.body).toEqual({
      error: { type: "mockingbird_admin", message: 'fault: unknown field "statuss"' },
    })
    // Nothing from the rejected document stuck: not the rules, and not the latency before them.
    expect((await admin<{ faults: unknown[] }>(runtime, "GET", "/faults")).body.faults).toEqual([])
    expect(runtime.controls().latency).toMatchObject({ delayMs: 0 })
  })

  test("DELETE /controls returns to boot and keeps the records", async () => {
    const runtime = mock({ adminControls: { latency: "5ms" } })
    await create(runtime, "kept")
    await admin(runtime, "PUT", "/controls", { latency: "9s", faults: [{ status: 500 }] })
    const reverted = await admin(runtime, "DELETE", "/controls")
    expect(reverted.body).toMatchObject({ latency: { delayMs: 5 }, faults: [] })
    expect((await list(runtime)).map((note) => note.text)).toEqual(["kept"])
  })
})

describe("reset", () => {
  test("returns a namespace to exactly its boot state", async () => {
    const runtime = mock({
      seed: 7,
      adminControls: {
        clock: { now: T0, frozen: true },
        latency: "10ms",
        virtualTime: true,
        faults: [{ id: "boot", operationId: "notes.get", status: 418 }],
      },
    })
    const fresh = await admin(runtime, "GET", "/controls")
    const first = (await (await create(runtime, "a")).json()) as Note

    await admin(runtime, "POST", "/clock", { advance: "3d" })
    await admin(runtime, "PUT", "/latency", { delay: "2s" })
    await admin(runtime, "POST", "/faults", { status: 500 })
    await admin(runtime, "PUT", "/controls", { seed: 99, virtualTime: false })
    await admin(runtime, "POST", "/snapshots", { name: "mine" })
    await create(runtime, "b")

    expect((await admin(runtime, "POST", "/reset")).body).toEqual({
      status: "ok",
      reset: ["default"],
    })
    expect((await admin(runtime, "GET", "/controls")).body).toEqual(fresh.body)
    expect(
      (await admin<{ requests: unknown[] }>(runtime, "GET", "/requests")).body.requests,
    ).toEqual([])
    expect(await list(runtime)).toEqual([])
    // The same request after a reset is the same response: id, timestamp and random draw.
    await admin(runtime, "DELETE", "/requests")
    await admin(runtime, "POST", "/reset")
    expect(await (await create(runtime, "a")).json()).toEqual(first)
  })

  test("resets one namespace and leaves the others alone", async () => {
    const runtime = mock()
    await create(runtime, "a", ns("a"))
    await create(runtime, "b", ns("b"))
    await admin(runtime, "POST", "/faults", { status: 500, operationId: "notes.get" }, ns("b"))
    await admin(runtime, "POST", "/reset", undefined, ns("a"))
    expect(await list(runtime, ns("a"))).toEqual([])
    expect((await list(runtime, ns("b"))).map((note) => note.text)).toEqual(["b"])
    expect(
      (await admin<{ faults: unknown[] }>(runtime, "GET", "/faults", undefined, ns("b"))).body
        .faults,
    ).toHaveLength(1)
    await admin(runtime, "POST", "/reset?all=1")
    expect(await list(runtime, ns("b"))).toEqual([])
    expect(
      (await admin<{ faults: unknown[] }>(runtime, "GET", "/faults?all=1")).body.faults,
    ).toEqual([])
  })

  test("DELETE /namespaces/:name forgets a namespace", async () => {
    const runtime = mock()
    await create(runtime, "a", ns("gone"))
    expect(runtime.namespaces()).toContain("gone")
    const dropped = await admin<{ namespaces: string[] }>(runtime, "DELETE", "/namespaces/gone")
    expect(dropped.body.namespaces).not.toContain("gone")
    expect(await list(runtime, ns("gone"))).toEqual([])
  })
})

describe("isolation by key", () => {
  test("every control is per namespace", async () => {
    const runtime = mock({ adminControls: { clock: { now: T0, frozen: true } } })
    await admin(runtime, "POST", "/clock", { advance: "1h" }, ns("a"))
    await admin(runtime, "PUT", "/latency", { delay: "1s" }, ns("a"))
    await admin(runtime, "POST", "/faults", { status: 500 }, ns("a"))
    await admin(runtime, "PUT", "/controls", { virtualTime: true, seed: 5 }, ns("a"))
    await admin(runtime, "POST", "/snapshots", undefined, ns("a"))

    const a = (await admin(runtime, "GET", "/controls", undefined, ns("a"))).body
    const b = (await admin(runtime, "GET", "/controls", undefined, ns("b"))).body
    expect(a).toMatchObject({
      clock: { now: T0 + 3_600_000 },
      latency: { delayMs: 1000 },
      virtualTime: true,
      seed: 5,
    })
    expect(b).toMatchObject({
      namespace: "b",
      clock: { now: T0, frozen: true },
      latency: { delayMs: 0 },
      virtualTime: false,
      seed: 0,
      faults: [],
      snapshots: [],
    })
    expect((await create(runtime, "x", ns("a"))).status).toBe(500)
    expect((await create(runtime, "x", ns("b"))).status).toBe(200)
  })

  test("ids are per namespace, so parallel workers never collide or interleave", async () => {
    const runtime = mock()
    for (const name of ["a", "b"]) {
      const fault = await admin<{ id: string }>(
        runtime,
        "POST",
        "/faults",
        { status: 500, count: 0 },
        ns(name),
      )
      const snapshot = await admin<{ id: string }>(
        runtime,
        "POST",
        "/snapshots",
        undefined,
        ns(name),
      )
      expect([fault.body.id, snapshot.body.id]).toEqual(["fault_1", "snap_1"])
    }
    // b's snapshot is not reachable from a.
    await admin(runtime, "DELETE", "/snapshots/snap_1", undefined, ns("b"))
    expect(
      (await admin(runtime, "POST", "/snapshots/snap_1/restore", undefined, ns("a"))).status,
    ).toBe(200)
    expect(
      (await admin(runtime, "POST", "/snapshots/snap_1/restore", undefined, ns("b"))).status,
    ).toBe(404)
  })

  test("DELETE /faults clears the caller's rules, not another namespace's", async () => {
    const runtime = mock()
    await admin(runtime, "POST", "/faults", { status: 500 }, ns("a"))
    await admin(runtime, "POST", "/faults", { status: 500 }, ns("b"))
    await admin(runtime, "DELETE", "/faults", undefined, ns("a"))
    expect((await create(runtime, "x", ns("a"))).status).toBe(200)
    expect((await create(runtime, "x", ns("b"))).status).toBe(500)
  })

  test("the same seed gives every namespace the same run, whatever the others do", async () => {
    const solo = mock({ seed: "replay" })
    const alone = [await create(solo, "1", ns("w")), await create(solo, "2", ns("w"))]
    const busy = mock({ seed: "replay" })
    await create(busy, "noise", ns("other"))
    const first = await create(busy, "1", ns("w"))
    await create(busy, "noise", ns("other"))
    await create(busy, "noise")
    const second = await create(busy, "2", ns("w"))
    const lucky = async (responses: Response[]) =>
      Promise.all(responses.map(async (response) => ((await response.json()) as Note).lucky))
    expect(await lucky([first, second])).toEqual(await lucky(alone))
  })

  test("a named namespace follows the base clock until it is moved on its own", async () => {
    const runtime = mock({ adminControls: { clock: { now: T0, frozen: true } } })
    await admin(runtime, "POST", "/clock", { advance: "1m" }, ns("pinned"))
    runtime.clock.advance(1000)
    expect(runtime.namespaceClock("follower").now()).toBe(T0 + 1000)
    expect(runtime.namespaceClock("pinned").now()).toBe(T0 + 61_000)
    await admin(runtime, "POST", "/clock", { now: T0 + 5, frozen: true }, ns("pinned"))
    runtime.clock.advance(1000)
    expect(runtime.namespaceClock("pinned").now()).toBe(T0 + 5)
    expect(runtime.clock.now()).toBe(T0 + 2000)
  })

  test("boot controls can differ per namespace, and credentials can pick one", async () => {
    const runtime = mock({
      credential: (request) => request.headers.get("authorization") ?? undefined,
      adminControls: {
        latency: "5ms",
        credentials: { "Bearer tenant-a": "tenant-a" },
        namespaces: {
          "tenant-a": {
            latency: "50ms",
            faults: [{ status: 429 }],
            clock: { now: T0, frozen: true },
          },
        },
      },
    })
    expect(runtime.controls("default")).toMatchObject({ latency: { delayMs: 5 }, faults: [] })
    expect(runtime.controls("tenant-a")).toMatchObject({
      latency: { delayMs: 50 },
      clock: { now: T0, frozen: true },
      faults: [{ id: "fault_1", status: 429, namespace: "tenant-a" }],
    })
    expect((await create(runtime, "x", { authorization: "Bearer tenant-a" })).status).toBe(429)
    expect((await create(runtime, "x")).status).toBe(200)
  })
})

describe("snapshot and restore", () => {
  test("a snapshot is the whole namespace: records, ids, clock, random streams, faults, latency", async () => {
    const runtime = mock({ seed: 3, adminControls: { clock: { now: T0, frozen: true } } })
    await create(runtime, "seeded")
    await admin(runtime, "PUT", "/latency", { delay: "7ms", jitter: "3ms" })
    await admin(runtime, "POST", "/faults", {
      id: "half",
      operationId: "notes.create",
      status: 503,
      rate: 0.5,
    })
    const taken = await admin(runtime, "POST", "/snapshots", { name: "baseline" })
    expect(taken).toEqual({
      status: 201,
      body: { id: "baseline", namespace: "default", records: 1, at: T0, portable: true },
    })

    const run = async () => {
      const out: unknown[] = []
      for (let i = 0; i < 6; i++) {
        const response = await create(runtime, `n${i}`)
        out.push([response.status, response.status === 200 ? await response.json() : null])
      }
      out.push((await admin(runtime, "GET", "/controls")).body)
      return out
    }
    const firstRun = await run()
    await admin(runtime, "POST", "/clock", { advance: "1d" })
    await admin(runtime, "DELETE", "/faults")
    await admin(runtime, "DELETE", "/latency")

    expect((await admin(runtime, "POST", "/snapshots/baseline/restore")).body).toEqual({
      status: "ok",
      id: "baseline",
      namespace: "default",
    })
    expect((await list(runtime)).map((note) => note.text)).toEqual(["seeded"])
    // Restoring rewinds the seeded streams too, so the same requests replay identically.
    expect(await run()).toEqual(firstRun)
  })

  test("lists, exports, imports and deletes", async () => {
    const runtime = mock({ adminControls: { clock: { now: T0, frozen: true } } })
    await create(runtime, "a")
    await admin(runtime, "POST", "/snapshots")
    await admin(runtime, "POST", "/snapshots", { name: "named" })
    const listed = await admin<{ snapshots: { id: string }[] }>(runtime, "GET", "/snapshots")
    expect(listed.body.snapshots.map((each) => each.id)).toEqual(["snap_1", "named"])

    const exported = await admin(runtime, "GET", "/snapshots/named")
    // A copy: this Bun's toMatchObject writes its matchers into the object it checks.
    expect(structuredClone(exported.body)).toMatchObject({
      format: SNAPSHOT_FORMAT,
      service: "notes",
      records: [{ collection: "notes", id: expect.any(String), seq: 1, value: { text: "a" } }],
      clock: { now: T0, frozen: true },
      seed: 0,
    })

    // The document boots a different process into the same state.
    const twin = mock({ adminControls: { snapshot: exported.body as never } })
    expect((await list(twin)).map((note) => note.text)).toEqual(["a"])
    expect(twin.namespaceClock().state()).toMatchObject({ now: T0, frozen: true })
    const next = async (runtime: Mock) => (await (await create(runtime, "b")).json()) as Note
    await admin(runtime, "POST", "/snapshots/named/restore")
    expect(await next(twin)).toEqual(await next(runtime))

    const imported = await admin(runtime, "PUT", "/snapshots/copy", exported.body, ns("other"))
    expect(imported).toMatchObject({
      status: 200,
      body: { id: "copy", namespace: "other", records: 1 },
    })
    expect(await list(runtime, ns("other"))).toEqual([])
    await admin(runtime, "POST", "/snapshots/copy/restore", undefined, ns("other"))
    expect((await list(runtime, ns("other"))).map((note) => note.text)).toEqual(["a"])

    expect((await admin(runtime, "DELETE", "/snapshots/named")).status).toBe(200)
    expect((await admin(runtime, "DELETE", "/snapshots/named")).status).toBe(404)
    expect((await admin(runtime, "GET", "/snapshots/named")).status).toBe(404)
    expect((await admin(runtime, "POST", "/snapshots/named/restore")).status).toBe(404)
  })

  test("a hand-written seed file is a valid snapshot", async () => {
    const seed = {
      format: SNAPSHOT_FORMAT,
      records: [
        { collection: "notes", id: "note_one", value: { id: "note_one", text: "first" } },
        { collection: "notes", id: "note_two", value: { id: "note_two", text: "second" } },
      ],
    } as const
    const runtime = mock({ adminControls: { snapshot: seed as never } })
    expect((await list(runtime)).map((note) => note.text)).toEqual(["first", "second"])
    // New rows continue after the seeded ones instead of colliding with them.
    await create(runtime, "third")
    expect((await list(runtime)).map((note) => note.text)).toEqual(["first", "second", "third"])
    // Reset returns to the seed file, in every namespace.
    await admin(runtime, "POST", "/reset")
    expect((await list(runtime)).map((note) => note.text)).toEqual(["first", "second"])
    expect((await list(runtime, ns("w1"))).map((note) => note.text)).toEqual(["first", "second"])
  })

  test("rejects a document it cannot restore", async () => {
    const runtime = mock()
    const put = (body: unknown) =>
      admin<{ error: { message: string } }>(runtime, "PUT", "/snapshots/x", body)
    expect((await put({ records: [] })).body.error.message).toContain("snapshot.format")
    expect((await put({ format: SNAPSHOT_FORMAT, records: [{ id: "a" }] })).status).toBe(400)
    expect(
      (await put({ format: SNAPSHOT_FORMAT, service: "stripe", records: [] })).body.error.message,
    ).toBe("snapshot was taken from stripe, not notes")
    const twice = { collection: "notes", id: "a", value: {} }
    expect(
      (await put({ format: SNAPSHOT_FORMAT, records: [twice, twice] })).body.error.message,
    ).toContain("duplicate")
    expect((await admin(runtime, "POST", "/snapshots", { name: "no spaces" })).status).toBe(400)
  })

  test("in process", async () => {
    const runtime = mock()
    await create(runtime, "a")
    expect(runtime.snapshots.create({ name: "s" })).toMatchObject({ id: "s", records: 1 })
    await create(runtime, "b")
    runtime.snapshots.restore("s")
    expect((await list(runtime)).map((note) => note.text)).toEqual(["a"])
    const copied = runtime.snapshots.import(runtime.snapshots.export("s"), {
      namespace: "w",
      name: "s",
    })
    expect(copied).toMatchObject({ id: "s", namespace: "w" })
    expect(runtime.snapshots.list("w")).toHaveLength(1)
    expect(runtime.snapshots.delete("s")).toBe(true)
    expect(() => runtime.snapshots.restore("s")).toThrow("no snapshot s")
  })
})

describe("time travel", () => {
  test("set, freeze, advance, auto-advance and reset", async () => {
    const runtime = mock()
    const clock = (body: unknown) => admin<Record<string, unknown>>(runtime, "POST", "/clock", body)
    expect((await clock({ now: "2030-01-01T00:00:00Z", frozen: true })).body).toEqual({
      now: T0,
      iso: "2030-01-01T00:00:00.000Z",
      frozen: true,
      offsetMs: expect.any(Number),
      autoAdvanceMs: 0,
    })
    expect((await clock({ advance: "90m" })).body.now).toBe(T0 + 90 * 60_000)
    expect((await clock({ advance: -1000 })).body.now).toBe(T0 + 90 * 60_000 - 1000)
    // The older spellings still work.
    expect((await clock({ set: T0, freeze: true })).body.now).toBe(T0)

    expect((await clock({ autoAdvance: "250ms" })).body.autoAdvanceMs).toBe(250)
    const stamps = []
    for (const text of ["a", "b", "c"])
      stamps.push(((await (await create(runtime, text)).json()) as Note).createdAt)
    expect(stamps).toEqual([T0 + 250, T0 + 500, T0 + 750].map((ms) => new Date(ms).toISOString()))
    // Admin calls do not tick the clock.
    expect((await admin(runtime, "GET", "/clock")).body).toMatchObject({ now: T0 + 750 })

    expect((await clock({ reset: true })).body).toMatchObject({
      frozen: false,
      offsetMs: 0,
      autoAdvanceMs: 0,
    })
  })

  test("rejects what it cannot read instead of guessing", async () => {
    const runtime = mock()
    for (const body of [
      { now: "soon" },
      { advance: "a while" },
      { frozen: "yes" },
      { warp: 9 },
      [],
    ]) {
      expect((await admin(runtime, "POST", "/clock", body)).status).toBe(400)
    }
  })

  test("history: read a checkpoint, branch from it, check it out", async () => {
    const runtime = mock()
    const made = await create(runtime, "first")
    const checkpoint = made.headers.get("x-mockingbird-checkpoint") as string
    await create(runtime, "second")
    expect(
      (await list(runtime, { [CONTROL_HEADERS.at]: checkpoint })).map((note) => note.text),
    ).toEqual(["first"])
    const what = { [CONTROL_HEADERS.branch]: "what-if", [CONTROL_HEADERS.at]: checkpoint }
    await create(runtime, "alternate", what)
    expect(
      (await list(runtime, { [CONTROL_HEADERS.branch]: "what-if" })).map((note) => note.text),
    ).toEqual(["first", "alternate"])
    expect((await list(runtime)).map((note) => note.text)).toEqual(["first", "second"])
    await admin(runtime, "POST", "/branches/main/checkout", { checkpoint })
    expect((await list(runtime)).map((note) => note.text)).toEqual(["first"])
  })
})

describe("faults", () => {
  const add = (runtime: Mock, rule: unknown, headers = {}) =>
    admin<Record<string, unknown>>(runtime, "POST", "/faults", rule, headers)
  const statuses = async (runtime: Mock, count: number, path = "/v1/notes") => {
    const out: number[] = []
    for (let i = 0; i < count; i++) out.push((await send(runtime, "GET", path)).status)
    return out
  }

  test("matches on operation, method, path, pattern, header and query", async () => {
    const cases: [Record<string, unknown>, string, Record<string, string>, boolean][] = [
      [{ operationId: "notes.get" }, "/v1/notes/1", {}, true],
      [{ operationId: "notes.get" }, "/v1/notes", {}, false],
      [{ method: "post" }, "/v1/notes", {}, false],
      [{ path: "/v1/notes" }, "/v1/notes", {}, true],
      [{ path: "/v1/notes" }, "/v1/notes/1", {}, false],
      [{ pathPrefix: "/v1/notes/" }, "/v1/notes/1", {}, true],
      [{ pathPattern: "^/v1/notes/\\d+$" }, "/v1/notes/42", {}, true],
      [{ pathPattern: "^/v1/notes/\\d+$" }, "/v1/notes/abc", {}, false],
      [{ requestHeaders: { "X-Tenant": "acme" } }, "/v1/notes", { "x-tenant": "acme" }, true],
      [{ requestHeaders: { "x-tenant": "acme" } }, "/v1/notes", { "x-tenant": "other" }, false],
      [{ requestHeaders: { "x-tenant": "*" } }, "/v1/notes", {}, false],
      [{ query: { page: "2" } }, "/v1/notes?page=2", {}, true],
      [{ query: { page: "2" } }, "/v1/notes?page=3", {}, false],
      [{ query: { page: "*" } }, "/v1/notes?page=9", {}, true],
    ]
    for (const [match, path, headers, hit] of cases) {
      const runtime = mock()
      expect((await add(runtime, { ...match, status: 599 })).status).toBe(201)
      const status = (await send(runtime, "GET", path, { headers })).status
      expect([JSON.stringify(match), path, status === 599]).toEqual([
        JSON.stringify(match),
        path,
        hit,
      ])
    }
  })

  test("schedules with after, every and count", async () => {
    const runtime = mock()
    await add(runtime, { status: 500, after: 2, every: 2, count: 2 })
    // Two pass, then every second one fails, twice, then the rule retires.
    expect(await statuses(runtime, 8)).toEqual([200, 200, 200, 500, 200, 500, 200, 200])
    expect((await admin(runtime, "GET", "/faults/fault_1")).body).toMatchObject({
      hits: 2,
      seen: 6,
      remaining: 0,
    })
  })

  test("a rate is drawn from the seed, so partial failure replays", async () => {
    const run = async (seed: number) => {
      const runtime = mock({ seed })
      await add(runtime, { status: 500, rate: 0.5 })
      return statuses(runtime, 24)
    }
    const first = await run(11)
    expect(await run(11)).toEqual(first)
    expect(await run(12)).not.toEqual(first)
    expect(new Set(first)).toEqual(new Set([200, 500]))
  })

  test("an outage window opens and closes with the mock clock", async () => {
    const runtime = mock({ adminControls: { clock: { now: T0, frozen: true } } })
    const added = await add(runtime, { status: 503, from: "1m", until: "5m" })
    expect(added.body).toMatchObject({ from: T0 + 60_000, until: T0 + 300_000 })
    expect(await statuses(runtime, 1)).toEqual([200])
    await admin(runtime, "POST", "/clock", { advance: "1m" })
    expect(await statuses(runtime, 2)).toEqual([503, 503])
    await admin(runtime, "POST", "/clock", { advance: "4m" })
    expect(await statuses(runtime, 1)).toEqual([200])
  })

  test("answers with a status, a body and headers, and names itself on the response", async () => {
    const runtime = mock()
    await add(runtime, {
      id: "limit",
      status: 429,
      body: { error: "slow down" },
      headers: { "retry-after": "7" },
    })
    const response = await send(runtime, "GET", "/v1/notes")
    expect([
      response.status,
      response.headers.get("retry-after"),
      response.headers.get(FAULT_HEADER),
    ]).toEqual([429, "7", "limit"])
    expect(await response.json()).toEqual({ error: "slow down" })
    const journal = await admin<{ requests: { faultId?: string }[] }>(
      runtime,
      "GET",
      "/requests?faultId=limit",
    )
    expect(journal.body.requests).toHaveLength(1)
  })

  test("drops, times out and truncates", async () => {
    const slept: number[] = []
    const runtime = mock({ slept })
    await add(runtime, { drop: true, count: 1 })
    const dropped = await send(runtime, "GET", "/v1/notes").catch((error) => error)
    expect(dropped).toBeInstanceOf(DroppedConnectionError)
    expect(dropped).toMatchObject({ code: "MOCKINGBIRD_DROP", reason: "drop" })

    await add(runtime, { timeout: "30s", count: 1 })
    const timedOut = await send(runtime, "GET", "/v1/notes").catch((error) => error)
    expect(timedOut).toMatchObject({ code: "MOCKINGBIRD_DROP", reason: "timeout" })
    expect(slept).toEqual([30_000])

    await add(runtime, { truncate: 10, count: 1 })
    const cut = await send(runtime, "GET", "/v1/essay")
    expect(cut.status).toBe(200)
    expect(cut.headers.get("content-length")).toBeNull()
    const reader = (cut.body as ReadableStream<Uint8Array>).getReader()
    expect((await reader.read()).value).toHaveLength(10)
    expect(await reader.read().catch((error) => error)).toMatchObject({ reason: "truncate" })

    const journal = await admin<{ requests: { status: number }[] }>(runtime, "GET", "/requests")
    expect(journal.body.requests.map((entry) => entry.status)).toEqual([0, 0, 200])
  })

  test("a held request gives up when the caller does", async () => {
    const runtime = createRuntime<ServiceInstance>({
      name: "notes",
      create: () => ({ fetch: async () => new Response("ok"), reset: async () => {} }),
    })
    runtime.faults.add({ id: "hang", timeoutMs: 60_000 })
    const controller = new AbortController()
    const pending = send(runtime, "GET", "/anything", { signal: controller.signal }).catch(
      (error) => error,
    )
    setTimeout(() => controller.abort(new Error("client timeout")), 5)
    expect(await pending).toMatchObject({ message: "client timeout" })
  })

  test("delays, with seeded jitter", async () => {
    const run = async () => {
      const slept: number[] = []
      const runtime = mock({ slept, seed: 4 })
      await add(runtime, { delay: "100ms", jitter: "50ms" })
      await statuses(runtime, 5)
      return slept
    }
    const first = await run()
    expect(await run()).toEqual(first)
    expect(first.every((ms) => ms >= 100 && ms <= 150)).toBe(true)
    expect(new Set(first).size).toBeGreaterThan(1)
  })

  test("an effect reaches the service, and stacks with a later rule", async () => {
    const runtime = mock()
    await add(runtime, { effect: "shout", operationId: "notes.create" })
    expect(((await (await create(runtime, "quiet")).json()) as Note).text).toBe("QUIET")
  })

  test("lists, reads, replaces and removes", async () => {
    const runtime = mock()
    await add(runtime, { status: 500 })
    await add(runtime, { id: "mine", status: 502, latencyMs: 5 })
    expect((await admin(runtime, "GET", "/faults/mine")).body).toEqual({
      id: "mine",
      namespace: "default",
      status: 502,
      delayMs: 5,
      remaining: null,
      hits: 0,
      seen: 0,
    })
    expect((await admin(runtime, "DELETE", "/faults/fault_1")).status).toBe(200)
    expect((await admin(runtime, "DELETE", "/faults/fault_1")).status).toBe(404)
    // A removed id is never handed out again while its successors exist.
    expect((await add(runtime, { status: 500 })).body.id).toBe("fault_2")

    const replaced = await admin<{ faults: { id: string }[] }>(runtime, "PUT", "/faults", {
      faults: [{ status: 503 }, { preset: "slow" }],
    })
    expect(replaced.body.faults.map((fault) => fault.id)).toEqual(["fault_1", "slow"])
    expect((await admin(runtime, "DELETE", "/faults?id=slow")).status).toBe(200)
  })

  test("rejects a rule that could never do what was meant", async () => {
    const runtime = mock()
    const bad: [unknown, string][] = [
      [{}, "a fault needs"],
      [{ operationId: "notes.get" }, "a fault needs"],
      [{ status: "503" }, "fault.status"],
      [{ status: 503, rate: 2 }, "fault.rate"],
      [{ status: 503, every: 0 }, "fault.every"],
      [{ status: 503, pathPattern: "(" }, "fault.pathPattern"],
      [{ status: 503, delay: "soon" }, "fault.delay"],
      [{ status: 503, delay: -1 }, "fault.delay"],
      [{ status: 503, headers: { a: 1 } }, "fault.headers"],
      [{ status: 503, opId: "notes.get" }, 'unknown field "opId"'],
      ["nope", "fault: expected an object"],
    ]
    for (const [rule, message] of bad) {
      const response = await admin<{ error: { message: string } }>(runtime, "POST", "/faults", rule)
      expect([response.status, response.body.error.message]).toEqual([
        400,
        expect.stringContaining(message),
      ])
    }
    expect((await admin<{ faults: unknown[] }>(runtime, "GET", "/faults")).body.faults).toEqual([])
    // A rejected rule takes no id: the first accepted one is still fault_1.
    expect((await admin<{ id: string }>(runtime, "POST", "/faults", { status: 500 })).body.id).toBe(
      "fault_1",
    )
  })

  test("a preset's rules are named after it, so applying it twice replaces them", async () => {
    const runtime = mock()
    const first = await admin<{ rules: { id: string }[] }>(runtime, "POST", "/faults", {
      preset: "slow",
    })
    expect(first.body.rules.map((rule) => rule.id)).toEqual(["slow"])
    await admin(runtime, "POST", "/faults", { preset: "slow", delay: "9s" })
    const listed = await admin<{ faults: { id: string; delayMs: number }[] }>(
      runtime,
      "GET",
      "/faults",
    )
    expect(listed.body.faults).toMatchObject([{ id: "slow", delayMs: 9000 }])
    // An id of its own keeps both.
    await admin(runtime, "POST", "/faults", { preset: "slow", id: "slower", delay: "20s" })
    expect(
      (await admin<{ faults: unknown[] }>(runtime, "GET", "/faults")).body.faults,
    ).toHaveLength(2)
  })

  test("every mock has the standard presets, and a service's own win", async () => {
    const plain = mock()
    const listed = await admin<{ presets: { name: string; description: string }[] }>(
      plain,
      "GET",
      "/faults/presets",
    )
    expect(listed.body.presets.map((preset) => preset.name)).toEqual(
      Object.keys(STANDARD_FAULT_PRESETS),
    )

    for (const [name, status] of [
      ["server_error", 500],
      ["bad_gateway", 502],
      ["unavailable", 503],
      ["gateway_timeout", 504],
      ["rate_limited", 429],
      ["unauthorized", 401],
      ["forbidden", 403],
    ] as const) {
      const runtime = mock()
      expect((await admin(runtime, "POST", `/faults/presets/${name}`, { count: 1 })).status).toBe(
        201,
      )
      expect(await statuses(runtime, 2)).toEqual([status, 200])
    }

    const own = mock({
      presets: {
        rate_limited: {
          description: "vendor shape",
          rules: [{ status: 429, body: { code: "slow_down" } }],
        },
      },
    })
    const vendor = await admin<{ presets: { name: string; description: string }[] }>(
      own,
      "GET",
      "/faults/presets",
    )
    expect(vendor.body.presets[0]).toMatchObject({
      name: "rate_limited",
      description: "vendor shape",
    })
    expect(vendor.body.presets).toHaveLength(Object.keys(STANDARD_FAULT_PRESETS).length)
    await admin(own, "POST", "/faults", { preset: "rate_limited", operationId: "notes.list" })
    expect(await (await send(own, "GET", "/v1/notes")).json()).toEqual({ code: "slow_down" })
    expect((await admin(own, "POST", "/faults", { preset: "nope" })).status).toBe(404)
    expect(
      (await admin(own, "POST", "/faults", { preset: "slow", delay: "9s" })).body,
    ).toMatchObject({
      rules: [{ id: "slow", fromPreset: "slow", delayMs: 9000 }],
    })
  })
})

describe("latency and virtual time", () => {
  test("a baseline delay, per-operation overrides, and seeded jitter", async () => {
    const slept: number[] = []
    const runtime = mock({ slept, seed: 9 })
    const set = await admin(runtime, "PUT", "/latency", {
      delay: "20ms",
      operations: { "notes.create": { delay: "200ms", jitter: "40ms" }, "notes.get": 5 },
    })
    expect(set.body).toEqual({
      delayMs: 20,
      jitterMs: 0,
      operations: {
        "notes.create": { delayMs: 200, jitterMs: 40 },
        "notes.get": { delayMs: 5, jitterMs: 0 },
      },
    })
    await send(runtime, "GET", "/v1/notes")
    await send(runtime, "GET", "/v1/notes/1")
    await create(runtime, "a")
    await create(runtime, "b")
    expect(slept.slice(0, 2)).toEqual([20, 5])
    expect(slept.slice(2).every((ms) => ms >= 200 && ms <= 240)).toBe(true)

    const again: number[] = []
    const twin = mock({ slept: again, seed: 9 })
    await admin(twin, "PUT", "/latency", set.body)
    await send(twin, "GET", "/v1/notes")
    await send(twin, "GET", "/v1/notes/1")
    await create(twin, "a")
    await create(twin, "b")
    expect(again).toEqual(slept)

    expect((await admin(runtime, "DELETE", "/latency")).body).toEqual({
      delayMs: 0,
      jitterMs: 0,
      operations: {},
    })
    expect((await admin(runtime, "PUT", "/latency", { delay: "-1s" })).status).toBe(400)
    expect((await admin(runtime, "PUT", "/latency", { speed: 1 })).status).toBe(400)
  })

  test("virtual time spends every wait on the mock clock and never sleeps", async () => {
    const slept: number[] = []
    const runtime = mock({
      slept,
      adminControls: { clock: { now: T0, frozen: true }, virtualTime: true, latency: "100ms" },
    })
    await admin(runtime, "POST", "/faults", { delay: "2s", operationId: "notes.create", count: 1 })
    const note = (await (await create(runtime, "a")).json()) as Note
    expect(note.createdAt).toBe(new Date(T0 + 2100).toISOString())
    await admin(runtime, "POST", "/faults", { timeout: "30s", count: 1 })
    await send(runtime, "GET", "/v1/notes").catch(() => {})
    expect(slept).toEqual([])
    expect(runtime.namespaceClock().now()).toBe(T0 + 2100 + 100 + 30_000)

    const journal = await admin<{ requests: Record<string, unknown>[] }>(
      runtime,
      "GET",
      "/requests",
    )
    // The journal records the wait exactly: nothing in it came from the wall clock.
    expect(journal.body.requests).toMatchObject([
      { status: 200, durationMs: 2100, delayMs: 2100, at: new Date(T0 + 2100).toISOString() },
      { status: 0, durationMs: 30_100, delayMs: 30_100, at: new Date(T0 + 32_200).toISOString() },
    ])
  })
})

describe("request headers", () => {
  test("the reference lists every header, and the builder writes them", () => {
    expect(CONTROL_HEADER_REFERENCE.map((each) => each.header).sort()).toEqual(
      Object.values(CONTROL_HEADERS)
        .filter((header) => header !== ADMIN_KEY_HEADER)
        .sort(),
    )
    const runtime = mock()
    expect(
      runtime.headers({
        namespace: "w1",
        reset: true,
        restore: "baseline",
        seed: 7,
        time: new Date(T0),
        advance: "15m",
        virtualTime: true,
        delay: "250ms",
        timeout: "30s",
        fault: { status: 503 },
        snapshot: "after",
      }),
    ).toEqual({
      "x-mockingbird-namespace": "w1",
      "x-mockingbird-reset": "true",
      "x-mockingbird-restore": "baseline",
      "x-mockingbird-seed": "7",
      "x-mockingbird-time": "2030-01-01T00:00:00.000Z",
      "x-mockingbird-advance": "900000",
      "x-mockingbird-virtual-time": "true",
      "x-mockingbird-delay": "250",
      "x-mockingbird-timeout": "30000",
      "x-mockingbird-fault": '{"status":503}',
      "x-mockingbird-snapshot": "after",
    })
    expect(() => controlHeaders({ delay: "soon" })).toThrow(ControlError)
    expect(() => controlHeaders({ fault: "status=abc" })).toThrow(ControlError)
    expect(parseControlHeaders(new Headers({ accept: "*/*" }))).toBeUndefined()
  })

  test("the fault header takes a status, a word, a preset, pairs or JSON", () => {
    expect(parseFaultHeader("503")).toEqual({ status: 503 })
    expect(parseFaultHeader("drop")).toEqual({ drop: true })
    expect(parseFaultHeader("rate_limited")).toEqual({ preset: "rate_limited" })
    expect(parseFaultHeader("status=503; delay=2s; header.Retry-After=5")).toEqual({
      status: 503,
      delay: "2s",
      headers: { "retry-after": "5" },
    })
    expect(parseFaultHeader("rate_limited; delay=1s")).toEqual({
      preset: "rate_limited",
      delay: "1s",
    })
    expect(parseFaultHeader('{"status":500,"body":{"a":1}}')).toEqual({
      status: 500,
      body: { a: 1 },
    })
    for (const bad of ["", "{", "[]", "status=abc", "speed=9", "503; nonsense"]) {
      expect(() => parseFaultHeader(bad)).toThrow(ControlError)
    }
  })

  test("time, advance and seed act on the namespace before the request", async () => {
    const runtime = mock()
    const at = { ...ns("w"), [CONTROL_HEADERS.time]: "2030-01-01T00:00:00Z" }
    const first = (await (
      await create(runtime, "a", { ...at, [CONTROL_HEADERS.seed]: "5" })
    ).json()) as Note
    expect(first.createdAt).toBe("2030-01-01T00:00:00.000Z")
    // The same headers again are the same request again: the clock is pinned, the seed restarts.
    const again = (await (
      await create(runtime, "a", { ...at, [CONTROL_HEADERS.seed]: "5" })
    ).json()) as Note
    expect([again.createdAt, again.lucky]).toEqual([first.createdAt, first.lucky])
    const later = (await (
      await create(runtime, "b", { ...ns("w"), [CONTROL_HEADERS.advance]: "15m" })
    ).json()) as Note
    expect(later.createdAt).toBe("2030-01-01T00:15:00.000Z")
    // It persists, like the admin call it stands for, and stays inside its namespace.
    expect(runtime.controls("w")).toMatchObject({
      seed: 5,
      clock: { now: T0 + 900_000, frozen: true },
    })
    expect(runtime.clock.state().frozen).toBe(false)
  })

  test("reset, restore and snapshot bracket the request", async () => {
    const runtime = mock()
    await create(runtime, "seed")
    const taken = await create(runtime, "more", { [CONTROL_HEADERS.snapshot]: "two" })
    expect(taken.headers.get(SNAPSHOT_HEADER)).toBe("two")
    await create(runtime, "extra")
    // Restore runs before the request, so the new note lands on the restored state.
    await create(runtime, "after", { [CONTROL_HEADERS.restore]: "two" })
    expect((await list(runtime)).map((note) => note.text)).toEqual(["seed", "more", "after"])
    expect(
      (await list(runtime, { [CONTROL_HEADERS.reset]: "true" })).map((note) => note.text),
    ).toEqual([])
    const missing = await create(runtime, "x", { [CONTROL_HEADERS.restore]: "nope" })
    expect([missing.status, await missing.json()]).toEqual([
      404,
      { error: { type: "mockingbird_admin", message: "no snapshot nope in namespace default" } },
    ])
  })

  test("fault, delay and timeout touch one request and are not stored", async () => {
    const slept: number[] = []
    const runtime = mock({ slept })
    const faulted = await create(runtime, "x", { [CONTROL_HEADERS.fault]: "status=503; delay=2s" })
    expect([faulted.status, faulted.headers.get(FAULT_HEADER)]).toEqual([503, "request"])
    const preset = await create(runtime, "x", { [CONTROL_HEADERS.fault]: "rate_limited" })
    expect([preset.status, preset.headers.get("retry-after")]).toEqual([429, "1"])
    expect((await create(runtime, "x", { [CONTROL_HEADERS.delay]: "250ms" })).status).toBe(200)
    const hung = await create(runtime, "x", { [CONTROL_HEADERS.timeout]: "10s" }).catch(
      (error) => error,
    )
    expect(hung).toMatchObject({ reason: "timeout" })
    const shout = await create(runtime, "loud", { [CONTROL_HEADERS.fault]: '{"effect":"shout"}' })
    expect(((await shout.json()) as Note).text).toBe("LOUD")
    expect(slept).toEqual([2000, 250, 10_000])
    expect((await create(runtime, "x")).status).toBe(200)
    expect((await admin<{ faults: unknown[] }>(runtime, "GET", "/faults")).body.faults).toEqual([])

    // A stored rule is not consumed by a request that scripted its own answer.
    await admin(runtime, "POST", "/faults", { status: 500, count: 1 })
    expect((await create(runtime, "x", { [CONTROL_HEADERS.fault]: "418" })).status).toBe(418)
    expect((await create(runtime, "x")).status).toBe(500)
  })

  test("virtual time by header", async () => {
    const slept: number[] = []
    const runtime = mock({ slept })
    const headers = {
      [CONTROL_HEADERS.time]: String(T0),
      [CONTROL_HEADERS.virtualTime]: "true",
      [CONTROL_HEADERS.delay]: "5s",
    }
    const note = (await (await create(runtime, "a", headers)).json()) as Note
    expect([note.createdAt, slept]).toEqual([new Date(T0 + 5000).toISOString(), []])
  })

  test("a bad header fails the request and changes nothing", async () => {
    const runtime = mock()
    const cases: [Record<string, string>, string][] = [
      [{ [CONTROL_HEADERS.time]: "soon" }, "x-mockingbird-time: expected epoch ms or ISO-8601"],
      [{ [CONTROL_HEADERS.advance]: "far" }, "x-mockingbird-advance"],
      [{ [CONTROL_HEADERS.delay]: "-5" }, "x-mockingbird-delay: must not be negative"],
      [{ [CONTROL_HEADERS.reset]: "maybe" }, "x-mockingbird-reset: expected true or false"],
      [{ [CONTROL_HEADERS.fault]: "nope_preset" }, 'no fault preset "nope_preset"'],
      [{ [CONTROL_HEADERS.fault]: '{"status":42}' }, "fault.status"],
      [{ [CONTROL_HEADERS.fault]: '{"delay":0}' }, "a fault needs"],
      [{ [CONTROL_HEADERS.fault]: '{"status":503,"rate":0.5}' }, "rate has no meaning here"],
      [
        { [CONTROL_HEADERS.fault]: '{"status":503,"operationId":"x"}' },
        "operationId has no meaning",
      ],
      [{ [CONTROL_HEADERS.snapshot]: "has space" }, "x-mockingbird-snapshot"],
    ]
    for (const [headers, message] of cases) {
      // A valid control beside the bad one must not be applied either.
      const response = await create(runtime, "x", { ...headers, [CONTROL_HEADERS.seed]: "99" })
      const body = (await response.json()) as { error: { type: string; message: string } }
      expect([response.status, body.error.type, body.error.message]).toEqual([
        400,
        "mockingbird_admin",
        expect.stringContaining(message),
      ])
    }
    expect(await list(runtime)).toEqual([])
    expect(runtime.controls().seed).toBe(0)
  })

  test("with an admin key, controls in headers need it; selection does not", async () => {
    const runtime = mock({ adminKey: "secret" })
    const denied = await create(runtime, "x", { [CONTROL_HEADERS.fault]: "503" })
    expect(denied.status).toBe(401)
    expect(await list(runtime)).toEqual([])
    const allowed = await create(runtime, "x", {
      [CONTROL_HEADERS.fault]: "503",
      [ADMIN_KEY_HEADER]: "secret",
    })
    expect(allowed.status).toBe(503)
    expect((await create(runtime, "x", ns("w"))).status).toBe(200)
  })
})

describe("determinism", () => {
  const script = async (runtime: Mock) => {
    const seen: unknown[] = []
    const record = async (response: Promise<Response>) => {
      const settled = await response.catch((error: Error) => error)
      seen.push(
        settled instanceof Response
          ? [settled.status, Object.fromEntries(settled.headers), await settled.text()]
          : settled.message,
      )
    }
    await record(create(runtime, "a"))
    await record(create(runtime, "b", { [CONTROL_HEADERS.delay]: "75ms" }))
    await record(send(runtime, "GET", "/v1/notes"))
    await record(create(runtime, "c", { [CONTROL_HEADERS.fault]: "flaky" }))
    await record(send(runtime, "GET", "/v1/nope"))
    for (let i = 0; i < 12; i++) await record(create(runtime, `n${i}`, ns("w")))
    await record(send(runtime, "GET", "/v1/notes", { headers: ns("w") }))
    seen.push((await admin(runtime, "GET", "/requests?all=1")).body)
    seen.push((await admin(runtime, "GET", "/controls")).body)
    seen.push((await admin(runtime, "GET", "/controls", undefined, ns("w"))).body)
    seen.push((await admin(runtime, "GET", "/metrics")).body)
    return JSON.stringify(seen)
  }
  const controls: MockControls = {
    seed: "replay-me",
    clock: { now: T0, frozen: true, autoAdvance: "1s" },
    virtualTime: true,
    latency: { delay: "20ms", jitter: "30ms" },
    faults: [
      { status: 503, rate: 0.3 },
      { operationId: "notes.create", delay: "1s", jitter: "500ms", every: 3 },
    ],
    namespaces: {
      w: {
        faults: [
          { timeout: "30s", after: 4, every: 5 },
          { status: 500, rate: 0.25 },
        ],
      },
    },
  }

  test("the same controls and the same requests give the same bytes, journal included", async () => {
    const first = await script(mock({ adminControls: controls }))
    expect(await script(mock({ adminControls: controls }))).toBe(first)
    expect(await script(mock({ adminControls: { ...controls, seed: "something-else" } }))).not.toBe(
      first,
    )
  })

  test("and again after a reset, in the same process", async () => {
    const runtime = mock({ adminControls: controls })
    const first = await script(runtime)
    await admin(runtime, "POST", "/reset?all=1")
    expect(await script(runtime)).toBe(first)
  })

  test("a numeric seed is the same seed however it is spelled", () => {
    expect(mock({ seed: "7" }).controls().seed).toBe(7)
    expect(mock({ adminControls: { seed: 7 } }).controls().seed).toBe(7)
    // The explicit option wins over the document.
    expect(mock({ seed: 1, adminControls: { seed: 7 } }).controls().seed).toBe(1)
    expect(mock({ seed: 7 }).rng.next()).toBe(mock({ seed: "7" }).rng.next())
  })
})

describe("the admin API describes itself", () => {
  test("GET /__admin lists every route and header with a summary", async () => {
    const runtime = mock({ admin: () => ({ "GET /vendor": () => jsonRes(200, {}) }) })
    const index = await admin<{
      routes: string[]
      reference: { route: string; summary: string; docs?: string }[]
      headers: { header: string }[]
      guide: { title: string; docs: string }[]
      docs: string
      namespace: string
    }>(runtime, "GET", "", undefined, ns("w"))
    expect(index.body.namespace).toBe("w")
    expect(index.body.docs).toContain("/docs/admin-controls")
    for (const route of STANDARD_ADMIN_ROUTES) expect(index.body.routes).toContain(route)
    expect(index.body.reference.map((each) => each.route)).toEqual(index.body.routes)
    expect(index.body.reference.find((each) => each.route === "GET /vendor")?.summary).toBe(
      "Specific to notes.",
    )
    expect(index.body.reference.find((each) => each.route === "POST /reset")?.summary).toBe(
      ADMIN_ROUTE_REFERENCE["POST /reset"],
    )
    // Every shared route and every header links to the guide page that defines it.
    expect(index.body.reference.find((each) => each.route === "GET /vendor")?.docs).toBeUndefined()
    expect(
      index.body.reference.find((each) => each.route === "POST /snapshots/:id/restore")?.docs,
    ).toBe(`${ADMIN_DOCS_URL}/snapshot-and-restore`)
    for (const route of STANDARD_ADMIN_ROUTES)
      expect([route, index.body.reference.find((each) => each.route === route)?.docs]).toEqual([
        route,
        expect.stringContaining(`${ADMIN_DOCS_URL}/`),
      ])
    expect(index.body.headers).toEqual(
      CONTROL_HEADER_REFERENCE.map((each) => ({
        ...each,
        docs: expect.stringContaining(`${ADMIN_DOCS_URL}/`),
      })) as never,
    )
    expect(index.body.guide.map((each) => each.docs)).toEqual(
      ADMIN_CONTROL_PAGES.map((each) => `${ADMIN_DOCS_URL}/${each.page}`),
    )
  })

  test("every listed route answers, and a literal path beats a parameter", async () => {
    const runtime = mock()
    for (const route of STANDARD_ADMIN_ROUTES) {
      const [method, pattern] = route.split(" ") as [string, string]
      const path = pattern.replace(/:\w+/g, "probe")
      const response = await send(runtime, method, `/__admin${path === "/" ? "" : path}`, {
        ...(method === "GET" || method === "DELETE" ? {} : { body: {} }),
      })
      const body = await response.text()
      expect([route, body.includes("no admin route")]).toEqual([route, false])
    }
    expect((await admin(runtime, "GET", "/faults/presets")).body).toHaveProperty("presets")
  })

  test("the journal filters and metrics scope by namespace", async () => {
    const runtime = mock()
    await create(runtime, "a")
    await send(runtime, "GET", "/v1/notes")
    await create(runtime, "b", ns("w"))
    const requests = async (query: string) =>
      (
        await admin<{ requests: { method: string; path: string }[] }>(
          runtime,
          "GET",
          `/requests${query}`,
        )
      ).body.requests
    expect(await requests("?method=post")).toHaveLength(1)
    expect(await requests("?path=/v1/notes&all=1")).toHaveLength(3)
    expect(await requests("?operationId=notes.list")).toHaveLength(1)
    expect((await admin(runtime, "GET", "/metrics")).body).toMatchObject({ requests: 3 })
    expect((await admin(runtime, "GET", "/metrics?namespace=w")).body).toMatchObject({
      requests: 1,
    })
  })
})
