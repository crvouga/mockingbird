/**
 * The promises `docs/ADMIN_CONTROLS.md` makes about how the controls behave together: what a
 * refused request leaves behind (nothing), what one namespace can do to another (nothing),
 * and what boot, reset, snapshot and restore each put back (exactly what they say).
 */
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
  ADMIN_KEY_HEADER,
  CONTROL_HEADERS,
  ControlError,
  createClock,
  createControlPlane,
  createJournal,
  createMetrics,
  FAULT_HEADER,
  type MockControls,
  SNAPSHOT_FORMAT,
  type SnapshotDocument,
} from "./src/index.js"

const controlsOf = async (runtime: Mock, namespace = "default") =>
  (await admin(runtime, "GET", "/controls", undefined, ns(namespace))).body

/** Everything a caller can see of a namespace: its controls, its records, its journal. */
const everything = async (runtime: Mock, namespace = "default") => ({
  controls: await controlsOf(runtime, namespace),
  state: (await admin(runtime, "GET", "/state/notes", undefined, ns(namespace))).body,
  journal: (await admin(runtime, "GET", "/requests", undefined, ns(namespace))).body,
})

const texts = async (runtime: Mock, namespace = "default") =>
  (await list(runtime, ns(namespace))).map((note) => note.text)

/** Which of `count` list requests a namespace's faults turn away, as a string like `X..X`. */
const pattern = async (runtime: Mock, namespace: string, count = 16) => {
  let out = ""
  for (let i = 0; i < count; i++)
    out +=
      (await send(runtime, "GET", "/v1/notes", { headers: ns(namespace) })).status === 200
        ? "."
        : "X"
  return out
}

const lucky = async (runtime: Mock, namespace = "default") =>
  ((await (await create(runtime, "x", ns(namespace))).json()) as Note).lucky

const exported = async (runtime: Mock, id: string, namespace = "default") =>
  (await admin<SnapshotDocument>(runtime, "GET", `/snapshots/${id}`, undefined, ns(namespace))).body

describe("a refused change leaves nothing behind", () => {
  const settled = async () => {
    const runtime = mock({ adminControls: { clock: { now: T0, frozen: true }, virtualTime: true } })
    await create(runtime, "kept")
    await admin(runtime, "POST", "/faults", { id: "keep", status: 500, operationId: "notes.get" })
    await admin(runtime, "PUT", "/latency", { delay: "3ms" })
    await admin(runtime, "POST", "/snapshots", { name: "base" })
    await admin(runtime, "DELETE", "/requests")
    return runtime
  }

  test("a control document with one bad rule changes no control and no record", async () => {
    const bad: unknown[] = [
      {
        seed: 99,
        clock: { now: T0 + 5, frozen: false },
        virtualTime: false,
        latency: "40ms",
        faults: [{ status: 503 }, { statuss: 500 }],
      },
      { latency: "9s", faults: [{ status: 503 }, { method: "GET" }] },
      { latency: "9s", faults: [{ preset: "rate_limited", statuss: 1 }] },
      { latency: "9s", faults: [{ preset: "nope" }] },
      { latency: "9s", faults: [{ status: 503, namespace: "*" }] },
      { snapshot: { format: SNAPSHOT_FORMAT, records: [] }, faults: [{ statuss: 1 }] },
      {
        snapshot: {
          format: SNAPSHOT_FORMAT,
          records: [],
          faults: { rules: [{ id: "x", status: 99 }] },
        },
        latency: "9s",
      },
      { snapshot: { format: SNAPSHOT_FORMAT, service: "stripe", records: [] }, seed: 4 },
    ]
    for (const document of bad) {
      const runtime = await settled()
      const before = await everything(runtime)
      const answer = await admin(runtime, "PUT", "/controls", document)
      expect([JSON.stringify(document), answer.status]).toEqual([JSON.stringify(document), 400])
      expect(await everything(runtime)).toEqual(before)
      expect(() => runtime.configure(document as never)).toThrow(ControlError)
      expect(await everything(runtime)).toEqual(before)
    }
  })

  test("a fault list with one bad rule keeps the rules that were there", async () => {
    for (const faults of [
      [{ id: "new", status: 503 }, { method: "GET" }],
      [{ preset: "rate_limited", statuss: 1 }],
      [{ status: 503 }, "nope"],
    ]) {
      const runtime = await settled()
      const before = await controlsOf(runtime)
      expect((await admin(runtime, "PUT", "/faults", { faults })).status).toBe(400)
      expect(await controlsOf(runtime)).toEqual(before)
    }
  })

  test("boot controls are checked whole when the runtime is created", () => {
    const boots: MockControls[] = [
      { faults: [{ operationId: "notes.get" }] },
      { namespaces: { a: { latency: "5ms", faults: [{ status: 503 }, { method: "GET" }] } } },
      { namespaces: { a: { faults: [{ preset: "rate_limited", statuss: 1 } as never] } } },
      { faults: [{ status: 503, namespace: "*" }] },
      { namespaces: { "not a key": {} } },
      { credentials: { key: "not a key" } },
    ]
    for (const adminControls of boots) expect(() => mock({ adminControls })).toThrow(ControlError)
  })

  test("a request with one header that cannot be honoured changes nothing", async () => {
    const good = {
      [CONTROL_HEADERS.seed]: "99",
      [CONTROL_HEADERS.time]: "2040-01-01T00:00:00Z",
      [CONTROL_HEADERS.advance]: "1h",
      [CONTROL_HEADERS.virtualTime]: "false",
    }
    const cases: [Record<string, string>, number][] = [
      [{ [CONTROL_HEADERS.delay]: "soon" }, 400],
      [{ [CONTROL_HEADERS.fault]: "no_such_preset" }, 400],
      // A reset discards snapshots and history, so neither can be asked for after one.
      [{ [CONTROL_HEADERS.reset]: "true", [CONTROL_HEADERS.restore]: "base" }, 400],
      [{ [CONTROL_HEADERS.reset]: "true", [CONTROL_HEADERS.at]: "cp_00000001" }, 400],
      [{ [CONTROL_HEADERS.restore]: "no-such-snapshot" }, 404],
      [{ [CONTROL_HEADERS.at]: "cp_nope" }, 409],
      [{ [CONTROL_HEADERS.snapshot]: "taken", [CONTROL_HEADERS.at]: "cp_nope" }, 409],
    ]
    for (const [headers, status] of cases) {
      const runtime = await settled()
      const before = await everything(runtime)
      const answer = await create(runtime, "never written", { ...good, ...headers })
      const body = (await answer.json()) as { error: { type: string } }
      expect([JSON.stringify(headers), answer.status, body.error.type]).toEqual([
        JSON.stringify(headers),
        status,
        "mockingbird_admin",
      ])
      // Only the refusal itself is new: one more journal entry, and nothing else.
      const after = await everything(runtime)
      const { requests } = after.journal as { requests: { status: number }[] }
      expect(requests.map((entry) => entry.status)).toEqual([status])
      expect({ ...after, journal: before.journal }).toEqual(before)
    }
  })

  test("a rejected fault takes no id and stores nothing", async () => {
    const runtime = mock()
    for (const rule of [
      {},
      { status: 503, delay: "fast" },
      { status: 503, namespace: "not a key!" },
      { status: 503, namespace: 7 },
    ])
      expect((await admin(runtime, "POST", "/faults", rule)).status).toBe(400)
    expect((await admin<{ id: string }>(runtime, "POST", "/faults", { status: 500 })).body.id).toBe(
      "fault_1",
    )
    expect(
      (await admin<{ faults: unknown[] }>(runtime, "GET", "/faults?all=1")).body.faults,
    ).toHaveLength(1)
  })
})

describe("what a namespace is given, it can be given back", () => {
  test("GET /controls is a document PUT /controls accepts, and applying it changes nothing", async () => {
    const runtime = mock({ seed: 3 })
    await admin(runtime, "PUT", "/controls", {
      seed: "abc",
      clock: { now: T0, frozen: true, autoAdvance: "2s" },
      virtualTime: true,
      latency: { delay: "5ms", jitter: "2ms", operations: { "notes.get": "1ms" } },
      faults: [
        { status: 503, rate: 0.5, from: "1m", until: "1h" },
        { preset: "slow", count: 2 },
        { preset: "rate_limited", id: "mine" },
      ],
    })
    await admin(runtime, "POST", "/snapshots", { name: "s" })
    const read = await controlsOf(runtime)
    const again = await admin(runtime, "PUT", "/controls", read)
    expect(again.status).toBe(200)
    expect(again.body).toEqual(read)

    // And in another namespace it is the same controls, under that namespace's name.
    const { snapshots: _snapshots, ...document } = read as { snapshots: unknown }
    const copy = await admin(runtime, "PUT", "/controls", document, ns("other"))
    expect(copy.status).toBe(200)
    expect(JSON.parse(JSON.stringify(copy.body).replaceAll('"other"', '"default"'))).toEqual({
      ...document,
      snapshots: [],
    })
    expect(
      (await admin<{ faults: unknown[] }>(runtime, "GET", "/faults", undefined, ns("other"))).body
        .faults,
    ).toHaveLength(3)
  })

  test("a snapshot goes back exactly, counters and streams included", async () => {
    const runtime = mock({
      seed: 3,
      adminControls: { clock: { now: T0, frozen: true, autoAdvance: "1s" }, virtualTime: true },
    })
    await admin(runtime, "PUT", "/latency", { delay: "5ms", jitter: "9ms" })
    await admin(runtime, "POST", "/faults", { status: 503, rate: 0.5, operationId: "notes.create" })
    for (const text of ["a", "b", "c"]) await create(runtime, text)
    await admin(runtime, "POST", "/snapshots", { name: "s" })
    const before = await everything(runtime)
    const next = async () => {
      const out: unknown[] = []
      for (const text of ["d", "e", "f", "g"]) {
        const answer = await create(runtime, text)
        out.push([answer.status, await answer.text()])
      }
      return out
    }
    const first = await next()

    // Change every control there is, then restore.
    await admin(runtime, "PUT", "/controls", {
      seed: 99,
      clock: { now: T0 + 9e9, frozen: false, autoAdvance: 0 },
      virtualTime: false,
      latency: "1s",
      faults: [{ drop: true, count: 0 }],
    })
    expect((await admin(runtime, "POST", "/snapshots/s/restore")).status).toBe(200)

    const after = await everything(runtime)
    expect(after.controls).toEqual(before.controls)
    expect(after.state).toEqual(before.state)
    expect(await next()).toEqual(first)
  })

  test("a running clock is restored running, from the instant the snapshot was taken", async () => {
    let wall = T0
    const runtime = mock({ clock: createClock(() => wall) })
    await admin(runtime, "POST", "/snapshots", { name: "s" })
    wall += 60_000
    await admin(runtime, "POST", "/snapshots/s/restore")
    expect(await controlsOf(runtime)).toMatchObject({ clock: { now: T0, frozen: false } })
    wall += 1000
    expect(await controlsOf(runtime)).toMatchObject({ clock: { now: T0 + 1000, frozen: false } })
  })

  test("an exported snapshot is the same snapshot in another process", async () => {
    const boot = {
      seed: 5,
      adminControls: { clock: { now: T0, frozen: true, autoAdvance: "1s" }, virtualTime: true },
    }
    const source = mock(boot)
    await admin(source, "PUT", "/latency", { delay: "5ms", jitter: "9ms" })
    await admin(source, "POST", "/faults", { status: 503, rate: 0.5, operationId: "notes.create" })
    for (const text of ["a", "b", "c"]) await create(source, text)
    await admin(source, "POST", "/snapshots", { name: "s" })
    const document = await exported(source, "s")

    const twin = mock(boot)
    expect((await admin(twin, "PUT", "/snapshots/s", document)).status).toBe(200)
    // Importing stores it. Nothing moves until it is restored.
    expect(await texts(twin)).toEqual([])
    await admin(twin, "POST", "/snapshots/s/restore")
    expect(await exported(twin, "s")).toEqual(document)
    await admin(source, "DELETE", "/requests")
    await admin(twin, "DELETE", "/requests")
    for (const text of ["d", "e", "f", "g"]) {
      const [here, there] = [await create(source, text), await create(twin, text)]
      expect([there.status, await there.text()]).toEqual([here.status, await here.text()])
    }
    const { snapshots: _a, ...mine } = (await controlsOf(source)) as { snapshots: unknown }
    const { snapshots: _b, ...theirs } = (await controlsOf(twin)) as { snapshots: unknown }
    expect(theirs).toEqual(mine)
  })

  test("a snapshot imported into another namespace lands there, rules and all", async () => {
    const runtime = mock({ adminControls: { clock: { now: T0, frozen: true } } })
    await create(runtime, "a", ns("a"))
    await admin(runtime, "POST", "/faults", { operationId: "notes.list", status: 503 }, ns("a"))
    await admin(runtime, "PUT", "/latency", { delay: "7ms" }, ns("a"))
    await admin(runtime, "POST", "/snapshots", { name: "s" }, ns("a"))
    await admin(runtime, "PUT", "/snapshots/s", await exported(runtime, "s", "a"), ns("b"))
    await admin(runtime, "POST", "/snapshots/s/restore", undefined, ns("b"))

    const faults = async (namespace: string) =>
      (
        await admin<{ faults: { id: string; namespace: string }[] }>(
          runtime,
          "GET",
          "/faults",
          undefined,
          ns(namespace),
        )
      ).body.faults
    expect(await faults("a")).toMatchObject([{ id: "fault_1", namespace: "a" }])
    expect(await faults("b")).toMatchObject([{ id: "fault_1", namespace: "b" }])
    expect((await send(runtime, "GET", "/v1/notes", { headers: ns("b") })).status).toBe(503)
    expect(await controlsOf(runtime, "b")).toMatchObject({ latency: { delayMs: 7 } })
    // The next rule there continues the numbering the snapshot had reached.
    const next = await admin<{ id: string }>(
      runtime,
      "POST",
      "/faults",
      { status: 500, count: 0 },
      ns("b"),
    )
    expect(next.body.id).toBe("fault_2")
    await admin(runtime, "DELETE", "/faults", undefined, ns("b"))
    expect(await texts(runtime, "b")).toEqual(["a"])
  })

  test("a document restores what it holds and leaves the rest alone", async () => {
    const runtime = mock({ adminControls: { clock: { now: T0, frozen: true } } })
    const seed = {
      format: SNAPSHOT_FORMAT,
      records: [{ collection: "notes", id: "n1", value: { id: "n1", text: "seeded" } }],
    }
    await admin(runtime, "PUT", "/snapshots/seed", seed)
    await admin(runtime, "POST", "/clock", { advance: "1h" })
    await admin(runtime, "POST", "/faults", { status: 500, operationId: "notes.get" })
    await admin(runtime, "PUT", "/latency", { delay: "9ms" })
    const before = await controlsOf(runtime)
    await admin(runtime, "POST", "/snapshots/seed/restore")
    expect(await texts(runtime)).toEqual(["seeded"])
    // The file said nothing about the clock, the faults or the latency.
    expect(await controlsOf(runtime)).toEqual(before)

    // Each part it does hold is put back on its own.
    await admin(runtime, "PUT", "/snapshots/clock", {
      ...seed,
      clock: { now: T0 + 7, frozen: true },
    })
    await admin(runtime, "POST", "/snapshots/clock/restore")
    expect(await controlsOf(runtime)).toMatchObject({
      clock: { now: T0 + 7 },
      latency: { delayMs: 9 },
      faults: [{ id: "fault_1" }],
    })
  })

  test("rules keep their place among the rules for every namespace", async () => {
    const order = async (via: "process" | "document") => {
      const runtime = mock()
      await admin(runtime, "POST", "/faults", { id: "first", status: 501 }, ns("a"))
      await admin(runtime, "POST", "/faults", { id: "all", status: 502, namespace: "*" }, ns("a"))
      await admin(runtime, "POST", "/faults", { id: "last", status: 503 }, ns("a"))
      await admin(runtime, "POST", "/snapshots", { name: "s" }, ns("a"))
      if (via === "document")
        await admin(runtime, "PUT", "/snapshots/s", await exported(runtime, "s", "a"), ns("a"))
      await admin(runtime, "DELETE", "/faults", undefined, ns("a"))
      await admin(runtime, "POST", "/snapshots/s/restore", undefined, ns("a"))
      const ids = (
        await admin<{ faults: { id: string }[] }>(runtime, "GET", "/faults", undefined, ns("a"))
      ).body.faults.map((fault) => fault.id)
      await admin(runtime, "DELETE", "/faults/first", undefined, ns("a"))
      return [ids, (await send(runtime, "GET", "/v1/notes", { headers: ns("a") })).status]
    }
    expect(await order("process")).toEqual([["first", "all", "last"], 502])
    expect(await order("document")).toEqual([["first", "all", "last"], 502])
  })

  test("a restore adds to history instead of rewriting it", async () => {
    const runtime = mock()
    const made = await create(runtime, "first")
    const checkpoint = made.headers.get("x-mockingbird-checkpoint") as string
    await admin(runtime, "POST", "/snapshots", { name: "s" })
    await create(runtime, "second")
    const before = (await admin<{ checkpoints: unknown[] }>(runtime, "GET", "/timeline")).body
      .checkpoints.length
    await admin(runtime, "POST", "/snapshots/s/restore")
    expect(
      (await admin<{ checkpoints: unknown[] }>(runtime, "GET", "/timeline")).body.checkpoints
        .length,
    ).toBe(before + 1)
    expect(
      (await list(runtime, { [CONTROL_HEADERS.at]: checkpoint })).map((note) => note.text),
    ).toEqual(["first"])
  })

  test("a snapshot asked for in a header is taken only when there is a response to carry it", async () => {
    const runtime = mock()
    const dropped = await create(runtime, "x", {
      [CONTROL_HEADERS.snapshot]: "s",
      [CONTROL_HEADERS.fault]: "drop",
    }).catch((error: Error) => error.message)
    expect(dropped).toContain("connection dropped")
    expect(
      (await admin<{ snapshots: unknown[] }>(runtime, "GET", "/snapshots")).body.snapshots,
    ).toEqual([])
    const faulted = await create(runtime, "x", {
      [CONTROL_HEADERS.snapshot]: "s",
      [CONTROL_HEADERS.fault]: "503",
    })
    expect([faulted.status, faulted.headers.get("x-mockingbird-snapshot")]).toEqual([503, "s"])
  })
})

describe("boot is one state, and reset returns to it", () => {
  const baseline = async () => {
    const source = mock({
      seed: 1,
      adminControls: { clock: { now: T0, frozen: true }, virtualTime: true },
    })
    await create(source, "seeded")
    await admin(source, "PUT", "/latency", { delay: "7ms" })
    await admin(source, "POST", "/faults", { id: "carried", status: 503, operationId: "notes.get" })
    await admin(source, "POST", "/snapshots", { name: "s" })
    return exported(source, "s")
  }

  test("a boot snapshot is in place before anything else touches the namespace", async () => {
    const snapshot = await baseline()
    const runtime = mock({ adminControls: { snapshot } })
    // Controls set before the first vendor request stay set.
    await admin(runtime, "POST", "/faults", { id: "mine", status: 418, operationId: "notes.list" })
    await admin(runtime, "PUT", "/latency", { delay: "9ms" })
    await admin(runtime, "POST", "/clock", { advance: "1h" })
    expect((await send(runtime, "GET", "/v1/notes")).status).toBe(418)
    expect(await controlsOf(runtime)).toMatchObject({
      clock: { now: T0 + 3_600_000 + 9, frozen: true },
      latency: { delayMs: 9 },
      faults: [{ id: "carried" }, { id: "mine", hits: 1 }],
    })
    await admin(runtime, "DELETE", "/faults/mine")
    expect(await texts(runtime)).toEqual(["seeded"])

    // So does a control the first request carries itself.
    const fresh = mock({ adminControls: { snapshot } })
    const first = (await (
      await create(fresh, "a", { [CONTROL_HEADERS.time]: "2040-01-01T00:00:00Z" })
    ).json()) as Note
    expect(first.createdAt).toBe("2040-01-01T00:00:00.007Z")
  })

  test("a control named beside a boot snapshot wins over the one the snapshot carries", async () => {
    const snapshot = await baseline()
    const runtime = mock({
      seed: 7,
      adminControls: {
        snapshot,
        clock: { now: T0 + 50_000, frozen: true },
        latency: "1ms",
        virtualTime: false,
        faults: [{ id: "explicit", status: 500, count: 0 }],
      },
    })
    expect(await controlsOf(runtime)).toMatchObject({
      seed: 7,
      clock: { now: T0 + 50_000, frozen: true },
      latency: { delayMs: 1 },
      virtualTime: false,
      faults: [{ id: "explicit" }],
    })
    expect(await lucky(runtime)).toBe(await lucky(mock({ seed: 7 })))
    // A window given as a duration counts from the clock the namespace boots with.
    const windowed = mock({
      adminControls: {
        snapshot,
        faults: [{ status: 599, until: "5m", operationId: "notes.list" }],
      },
    })
    expect((await send(windowed, "GET", "/v1/notes")).status).toBe(599)
  })

  test("reset and DELETE /controls both return to the boot snapshot's own controls", async () => {
    const snapshot = await baseline()
    const runtime = mock({ adminControls: { snapshot } })
    const boot = await everything(runtime)
    await create(runtime, "more")
    await admin(runtime, "PUT", "/controls", {
      clock: { now: T0 + 9e6, frozen: false },
      latency: "1s",
      faults: [],
      seed: 9,
    })

    await admin(runtime, "DELETE", "/controls")
    expect(await controlsOf(runtime)).toEqual(boot.controls)
    expect(await texts(runtime)).toEqual(["seeded", "more"])

    await admin(runtime, "POST", "/reset")
    expect(await everything(runtime)).toEqual(boot)
    await admin(runtime, "POST", "/reset?all=1")
    expect(await everything(runtime)).toEqual(boot)
    expect(await everything(runtime, "other")).toEqual({
      ...boot,
      controls: {
        ...(boot.controls as object),
        namespace: "other",
        faults: [{ ...(boot.controls as { faults: object[] }).faults[0], namespace: "other" }],
      },
    })
  })

  test("a clock the caller built is the boot clock: a reset does not thaw it", async () => {
    const clock = createClock(() => T0 + 123)
    clock.freeze()
    clock.set(T0)
    const runtime = mock({ clock })
    await admin(runtime, "POST", "/clock", { advance: "1h" })
    await admin(runtime, "POST", "/reset")
    expect(await controlsOf(runtime)).toMatchObject({ clock: { now: T0, frozen: true } })
    clock.advance(5000)
    await admin(runtime, "POST", "/reset?all=1")
    expect(clock.state()).toMatchObject({ now: T0, frozen: true })
  })

  test("a rule added in process before a namespace's first use survives its boot", async () => {
    const runtime = mock({
      adminControls: { faults: [{ id: "boot", status: 500, operationId: "notes.get" }] },
    })
    runtime.faults.add({ id: "mine", namespace: "w", status: 503 })
    expect((await send(runtime, "GET", "/v1/notes", { headers: ns("w") })).status).toBe(503)
    expect((await controlsOf(runtime, "w")) as object).toMatchObject({
      faults: [{ id: "boot" }, { id: "mine" }],
    })
  })

  test("reset keeps credential mappings; DELETE /credentials clears them", async () => {
    const runtime = mock({
      credential: (request) => request.headers.get("authorization") ?? undefined,
    })
    await admin(runtime, "PUT", "/credentials", { credentials: { "Bearer a": "tenant" } })
    await create(runtime, "mine", { authorization: "Bearer a" })
    await admin(runtime, "POST", "/reset?all=1")
    await create(runtime, "again", { authorization: "Bearer a" })
    expect([await texts(runtime, "tenant"), await texts(runtime)]).toEqual([["again"], []])
    await admin(runtime, "DELETE", "/credentials")
    await create(runtime, "unmapped", { authorization: "Bearer a" })
    expect(await texts(runtime)).toEqual(["unmapped"])
  })
})

describe("one namespace never moves another", () => {
  test("the default namespace is a namespace like any other", async () => {
    const adminControls: MockControls = {
      seed: 7,
      clock: { now: T0, frozen: true, autoAdvance: "1s" },
      virtualTime: true,
    }
    const quiet = mock({ adminControls })
    const alone = (await (await create(quiet, "a", ns("worker-1"))).json()) as Note

    const busy = mock({ adminControls })
    for (const text of ["x", "y", "z"]) await create(busy, text)
    await admin(busy, "POST", "/clock", { advance: "3d" })
    await admin(busy, "PUT", "/controls", { seed: 99 })
    const beside = (await (await create(busy, "a", ns("worker-1"))).json()) as Note
    expect(beside).toEqual(alone)

    // And a reset of `default` does not send another namespace's time backwards.
    await create(busy, "b", ns("worker-1"))
    const before = await controlsOf(busy, "worker-1")
    await admin(busy, "POST", "/reset")
    expect(await controlsOf(busy, "worker-1")).toEqual(before)
  })

  test("a seed set in one namespace is that namespace's alone", async () => {
    const rule = { status: 503, rate: 0.5 }
    const fresh = mock({ seed: 7 })
    await admin(fresh, "POST", "/faults", rule, ns("w"))
    const expected = await pattern(fresh, "w")

    const runtime = mock({ seed: 7 })
    await create(runtime, "x", { [CONTROL_HEADERS.seed]: "99" })
    await admin(runtime, "PUT", "/controls", { seed: 5 }, ns("other"))
    await admin(runtime, "POST", "/faults", rule, ns("w"))
    expect(await pattern(runtime, "w")).toBe(expected)
    expect(await controlsOf(runtime, "w")).toMatchObject({ seed: 7 })

    // A full reset returns every namespace to the boot seed, whatever was set since.
    await admin(runtime, "POST", "/reset?all=1")
    await admin(runtime, "POST", "/faults", rule)
    const boot = mock({ seed: 7 })
    await admin(boot, "POST", "/faults", rule)
    expect(await pattern(runtime, "default")).toBe(await pattern(boot, "default"))
  })

  test("the seed a namespace reports is the seed its streams use, through every change", async () => {
    const rule = { status: 503, rate: 0.5 }
    const reference = async (seed: number) => {
      const runtime = mock({ seed })
      await admin(runtime, "POST", "/faults", rule)
      await admin(runtime, "PUT", "/latency", { jitter: "1000ms" })
      const slept: number[] = []
      const fresh = mock({ seed, slept })
      await admin(fresh, "PUT", "/latency", { jitter: "1000ms" })
      for (let i = 0; i < 6; i++) await send(fresh, "GET", "/v1/essay")
      return {
        pattern: await pattern(runtime, "default"),
        jitter: slept,
        lucky: await lucky(mock({ seed })),
      }
    }
    const [three, nine] = [await reference(3), await reference(9)]
    expect(three).not.toEqual(nine)

    // A snapshot brings its seed back with it.
    const runtime = mock({ seed: 3 })
    await admin(runtime, "POST", "/snapshots", { name: "s" })
    await admin(runtime, "PUT", "/controls", { seed: 9 })
    await admin(runtime, "POST", "/snapshots/s/restore")
    await admin(runtime, "POST", "/faults", rule)
    expect([await controlsOf(runtime), await pattern(runtime, "default")]).toMatchObject([
      { seed: 3 },
      three.pattern,
    ])

    // Clearing and setting a control again does not fall back to another seed.
    const slept: number[] = []
    const reseeded = mock({ seed: 3, slept })
    await admin(reseeded, "PUT", "/controls", { seed: 9 })
    await admin(reseeded, "DELETE", "/latency")
    await admin(reseeded, "DELETE", "/faults?all=1")
    await admin(reseeded, "PUT", "/latency", { jitter: "1000ms" })
    for (let i = 0; i < 6; i++) await send(reseeded, "GET", "/v1/essay")
    await admin(reseeded, "DELETE", "/latency")
    await admin(reseeded, "POST", "/faults", rule)
    expect([slept, await pattern(reseeded, "default")]).toEqual([nine.jitter, nine.pattern])

    // A document that names a seed starts the streams from it, like `PUT /controls {seed}`.
    const documented = mock({ seed: 3 })
    await admin(documented, "PUT", "/controls", {
      snapshot: { format: SNAPSHOT_FORMAT, records: [], seed: 9 },
    })
    expect([await controlsOf(documented), await lucky(documented)]).toMatchObject([
      { seed: 9 },
      nine.lucky,
    ])
  })

  test("the base clock moves every namespace that is not frozen; a namespace's clock moves only itself", async () => {
    const runtime = mock({ adminControls: { clock: { now: T0, frozen: true } } })
    await admin(runtime, "POST", "/clock", { advance: "1m" }, ns("ahead"))
    await admin(runtime, "POST", "/clock", { now: T0 + 5, frozen: true }, ns("pinned"))
    await admin(runtime, "POST", "/clock", { advance: "1h" })
    const now = async () =>
      Promise.all(
        ["default", "follower", "ahead", "pinned"].map(
          async (name) =>
            ((await controlsOf(runtime, name)) as { clock: { now: number } }).clock.now - T0,
        ),
      )
    expect(await now()).toEqual([3_600_000, 0, 60_000, 5])
    runtime.clock.advance(1000)
    expect(await now()).toEqual([3_601_000, 1000, 61_000, 5])
    expect(runtime.clock.now()).toBe(T0 + 1000)
  })

  test("a rule for every namespace belongs to none of them", async () => {
    const runtime = mock()
    const added = await admin<{ id: string; namespace: string }>(
      runtime,
      "POST",
      "/faults",
      { status: 503, namespace: "*", count: 3 },
      ns("a"),
    )
    expect(added.body).toMatchObject({ id: "fault_1", namespace: "*" })
    // It is one rule with one count, wherever the requests come from.
    expect([await pattern(runtime, "a", 2), await pattern(runtime, "b", 2)]).toEqual(["XX", "X."])
    await admin(runtime, "POST", "/faults", { id: "again", status: 503, namespace: "*" }, ns("a"))
    // A namespace's reset and its own clear leave it; a full reset or `?all=1` remove it.
    await admin(runtime, "POST", "/reset", undefined, ns("a"))
    await admin(runtime, "DELETE", "/faults", undefined, ns("a"))
    expect(await pattern(runtime, "a", 1)).toBe("X")
    await admin(runtime, "DELETE", "/faults?all=1", undefined, ns("b"))
    expect(await pattern(runtime, "a", 1)).toBe(".")
    await admin(runtime, "POST", "/faults", { status: 503, namespace: "*" })
    await admin(runtime, "POST", "/reset?all=1")
    expect(await pattern(runtime, "a", 1)).toBe(".")
  })
})

describe("a service that keeps a schedule is told when its clock moves", () => {
  test("for the namespace that moved, however it was moved, and for no other", async () => {
    const moved: string[] = []
    const told = () => [...new Set(moved.splice(0))].sort()
    const runtime = mock({
      onClockChange: (namespace) => moved.push(namespace),
      adminControls: { namespaces: { late: { clock: { now: T0 + 1 } } } },
    })
    told()
    await admin(runtime, "POST", "/clock", { advance: "1m" }, ns("a"))
    expect(told()).toEqual(["a"])
    await create(runtime, "x", { ...ns("b"), [CONTROL_HEADERS.time]: String(T0) })
    expect(told()).toEqual(["b"])
    await create(runtime, "x", { ...ns("b"), [CONTROL_HEADERS.advance]: "1h" })
    expect(told()).toEqual(["b"])
    // A wait spent in virtual time, and a step taken before a request, move the clock too.
    await admin(runtime, "PUT", "/controls", { virtualTime: true }, ns("c"))
    await create(runtime, "x", { ...ns("c"), [CONTROL_HEADERS.delay]: "5s" })
    expect(told()).toEqual(["c"])
    await admin(runtime, "POST", "/clock", { autoAdvance: "1s" }, ns("d"))
    told()
    await create(runtime, "x", ns("d"))
    expect(told()).toEqual(["d"])
    await admin(runtime, "POST", "/snapshots", { name: "s" }, ns("a"))
    await admin(runtime, "POST", "/snapshots/s/restore", undefined, ns("a"))
    expect(told()).toEqual(["a"])
    await admin(runtime, "POST", "/reset", undefined, ns("b"))
    expect(told()).toEqual(["b"])
    // A namespace booting onto a clock of its own counts; a request that moves nothing does not.
    await create(runtime, "x", ns("late"))
    expect(told()).toEqual(["late"])
    await create(runtime, "x", ns("a"))
    await admin(runtime, "GET", "/clock", undefined, ns("a"))
    // Nor does the base clock: whoever moves it in process is already there to act on it.
    runtime.clock.advance(1000)
    expect(told()).toEqual([])
  })
})

describe("what a request is told is what the journal recorded", () => {
  test("the response and the journal name the same rule", async () => {
    const runtime = mock({ adminControls: { virtualTime: true } })
    await admin(runtime, "POST", "/faults", { id: "slow", delay: "5ms" })
    await admin(runtime, "POST", "/faults", { id: "down", status: 503, operationId: "notes.list" })
    const answered = await send(runtime, "GET", "/v1/notes")
    const shaped = await send(runtime, "GET", "/v1/essay")
    const journal = (
      await admin<{ requests: { faultId?: string; delayMs?: number }[] }>(
        runtime,
        "GET",
        "/requests",
      )
    ).body.requests
    expect([answered.headers.get(FAULT_HEADER), shaped.headers.get(FAULT_HEADER)]).toEqual([
      "down",
      "slow",
    ])
    expect(journal).toMatchObject([
      { faultId: "down", delayMs: 5 },
      { faultId: "slow", delayMs: 5 },
    ])
  })

  test("the journal filters by what it records, including nothing and a dropped connection", async () => {
    const runtime = mock({ adminControls: { clock: { now: T0, frozen: true, autoAdvance: "1s" } } })
    await create(runtime, "a")
    await send(runtime, "GET", "/v1/notes")
    await create(runtime, "b", { [CONTROL_HEADERS.fault]: "drop" }).catch(() => {})
    await send(runtime, "GET", "/v1/nope")
    const count = async (query: string) =>
      (await admin<{ requests: unknown[] }>(runtime, "GET", `/requests${query}`)).body.requests
        .length
    expect(await count("")).toBe(4)
    expect(await count("?limit=0")).toBe(0)
    expect(await count("?limit=2")).toBe(2)
    expect(await count("?status=0")).toBe(1)
    expect(await count("?status=404")).toBe(1)
    expect(await count("?faultId=request")).toBe(1)
    expect(await count(`?since=${T0 + 3000}`)).toBe(2)
    expect(await count(`?since=${new Date(T0 + 3000).toISOString()}`)).toBe(2)
    for (const bad of ["?status=abc", "?limit=-1", "?since=soon"])
      expect((await admin(runtime, "GET", `/requests${bad}`)).status).toBe(400)
  })

  test("every header on one request applies in the order the guide gives", async () => {
    const runtime = mock({ seed: 3 })
    await create(runtime, "old")
    await admin(runtime, "POST", "/clock", { now: T0, frozen: true })
    await admin(runtime, "POST", "/snapshots", { name: "base" })
    await create(runtime, "newer")
    const response = await create(runtime, "written", {
      [CONTROL_HEADERS.restore]: "base",
      [CONTROL_HEADERS.seed]: "9",
      [CONTROL_HEADERS.time]: "2040-01-01T00:00:00Z",
      [CONTROL_HEADERS.advance]: "1h",
      [CONTROL_HEADERS.virtualTime]: "true",
      [CONTROL_HEADERS.delay]: "250ms",
      [CONTROL_HEADERS.fault]: '{"effect":"shout"}',
      [CONTROL_HEADERS.snapshot]: "after",
    })
    const note = (await response.json()) as Note
    // Restored first, then reseeded, pinned, advanced; the wait is spent on the mock clock.
    expect(note).toEqual({
      id: expect.any(String),
      text: "WRITTEN",
      createdAt: "2040-01-01T01:00:00.250Z",
      lucky: await lucky(mock({ seed: 9 })),
    })
    expect(await texts(runtime)).toEqual(["old", "WRITTEN"])
    expect([
      response.headers.get(FAULT_HEADER),
      response.headers.get("x-mockingbird-snapshot"),
    ]).toEqual(["request", "after"])
    // The snapshot was taken after the request: it holds the note the request wrote.
    const after = await exported(runtime, "after")
    expect(after.records.map((row) => (row.value as Note).text)).toEqual(["old", "WRITTEN"])
  })

  test("a write that names a checkpoint on main rewinds main, so it needs the admin key", async () => {
    const runtime = mock({ adminKey: "secret" })
    const key = { [ADMIN_KEY_HEADER]: "secret" }
    const first = await create(runtime, "a")
    const checkpoint = first.headers.get("x-mockingbird-checkpoint") as string
    await create(runtime, "b")
    // Reading the past is a selection: no key.
    expect(
      (await list(runtime, { [CONTROL_HEADERS.at]: checkpoint })).map((note) => note.text),
    ).toEqual(["a"])
    const refused = await create(runtime, "c", { [CONTROL_HEADERS.at]: checkpoint })
    expect(refused.status).toBe(401)
    expect((await list(runtime)).map((note) => note.text)).toEqual(["a", "b"])
    expect((await create(runtime, "c", { [CONTROL_HEADERS.at]: checkpoint, ...key })).status).toBe(
      200,
    )
    expect((await list(runtime)).map((note) => note.text)).toEqual(["a", "c"])
    // On a branch the same request leaves main alone, so it stays open.
    expect(
      (
        await create(runtime, "d", {
          [CONTROL_HEADERS.at]: checkpoint,
          [CONTROL_HEADERS.branch]: "what-if",
        })
      ).status,
    ).toBe(200)
    expect((await list(runtime)).map((note) => note.text)).toEqual(["a", "c"])
  })

  test("checking out a frozen checkpoint lands on its instant, not a tick after", async () => {
    let ticks = 0
    const clock = createClock(() => T0 + ticks++)
    const runtime = mock({ clock })
    await admin(runtime, "POST", "/clock", { now: T0 + 500_000, frozen: true })
    const made = await create(runtime, "a")
    await admin(runtime, "POST", "/clock", { frozen: false })
    await admin(runtime, "POST", "/branches/main/checkout", {
      checkpoint: made.headers.get("x-mockingbird-checkpoint"),
    })
    expect(await controlsOf(runtime)).toMatchObject({ clock: { now: T0 + 500_000, frozen: true } })
  })
})

describe("the same controls wherever the emulator is reached", () => {
  test("under another admin prefix", async () => {
    const runtime = mock({ adminPrefix: "/_control/mock", adminControls: { latency: "5ms" } })
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await send(
        runtime,
        method,
        `/_control/mock${path}`,
        body === undefined ? {} : { body },
      )
      return [response.status, await response.json()] as [number, Record<string, unknown>]
    }
    expect(await call("GET", "/controls")).toMatchObject([200, { latency: { delayMs: 5 } }])
    expect(
      (await call("POST", "/faults", { preset: "rate_limited", operationId: "notes.get" }))[0],
    ).toBe(201)
    expect((await call("POST", "/snapshots", { name: "s" }))[0]).toBe(201)
    expect((await call("POST", "/snapshots/s/restore"))[0]).toBe(200)
    expect((await call("GET", ""))[1]).toMatchObject({ adminPrefix: "/_control/mock" })
    expect((await send(runtime, "GET", "/__admin/controls")).status).toBe(404)
    // The base-URL carrier for the namespace moves with the prefix.
    expect(
      (
        await send(runtime, "POST", "/_control/mock/ns/w/v1/notes", {
          body: { text: "a" },
          headers: { [CONTROL_HEADERS.time]: String(T0) },
        })
      ).status,
    ).toBe(200)
    expect((await call("GET", "/controls?namespace=w"))[1]).toMatchObject({
      clock: { now: T0, frozen: true },
    })
  })

  test("mounted inside an application", async () => {
    const runtime = mock()
    const mounted = runtime.mount("/api/mock")
    const call = (
      method: string,
      path: string,
      headers: Record<string, string> = {},
      body?: unknown,
    ) =>
      mounted.fetch(
        new Request(`http://app.local/api/mock${path}`, {
          method,
          headers: { "content-type": "application/json", ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
    expect(
      (
        await call(
          "POST",
          "/v1/notes",
          { [CONTROL_HEADERS.namespace]: "w", [CONTROL_HEADERS.fault]: "503" },
          { text: "a" },
        )
      ).status,
    ).toBe(503)
    expect(
      (
        await call(
          "POST",
          "/v1/notes",
          { [CONTROL_HEADERS.namespace]: "w", [CONTROL_HEADERS.time]: String(T0) },
          { text: "a" },
        )
      ).status,
    ).toBe(200)
    expect(await (await call("GET", "/__admin/controls?namespace=w")).json()).toMatchObject({
      clock: { now: T0, frozen: true },
    })
  })

  test("an engine without rows of JSON answers the same routes, and says what it cannot do", async () => {
    // The SQL engines sit behind the control plane with only a checkpoint history to offer.
    const log: string[] = []
    let made = 0
    const plane = createControlPlane({
      name: "engine",
      startedAt: 0,
      wallNow: () => 0,
      clock: createClock(() => T0),
      metrics: createMetrics(),
      journal: createJournal(),
      defaultNamespace: "default",
      namespaces: () => ["default"],
      reset: async (namespace) => void log.push(`reset ${namespace}`),
      timeTravel: {
        checkpoint: (namespace, branch) => ({
          id: `cp_${++made}`,
          branch,
          parent: null,
          at: made,
          records: 4,
        }),
        branch: (name) => ({ id: "cp_1", branch: name, parent: null, at: 1 }),
        checkout: (checkpoint, { namespace }) =>
          void log.push(`checkout ${checkpoint} in ${namespace}`),
        retain: (_namespace, checkpoint) => void log.push(`retain ${checkpoint}`),
        release: (_namespace, checkpoint) => log.push(`release ${checkpoint}`) > 0,
        inspect: () => ({ branches: {}, checkpoints: [] }),
      },
      describe: () => ({}),
      routes: {},
      adminKey: undefined,
    })
    const call = async (method: string, path: string, body?: unknown, namespace = "default") => {
      const response = (await plane.handle(
        new Request(`http://engine/__admin${path}`, {
          method,
          headers: { "x-mockingbird-namespace": namespace },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )) as Response
      return [response.status, await response.json()] as [number, Record<string, unknown>]
    }
    expect(await call("POST", "/snapshots")).toEqual([
      201,
      { id: "snap_1", namespace: "default", records: 4, at: 1, portable: false },
    ])
    expect(await call("POST", "/snapshots", { name: "named" })).toMatchObject([
      201,
      { id: "named" },
    ])
    expect(await call("POST", "/snapshots", undefined, "w")).toMatchObject([
      201,
      { id: "snap_1", namespace: "w" },
    ])
    expect((await call("GET", "/snapshots"))[1]).toMatchObject({
      snapshots: [{ id: "snap_1" }, { id: "named" }],
    })
    // Not portable: reading one gives what is known about it, and nothing can be imported.
    expect(await call("GET", "/snapshots/named")).toMatchObject([
      200,
      { id: "named", portable: false },
    ])
    expect((await call("PUT", "/snapshots/x", { format: SNAPSHOT_FORMAT, records: [] }))[0]).toBe(
      400,
    )
    expect(
      (await call("PUT", "/controls", { snapshot: { format: SNAPSHOT_FORMAT, records: [] } }))[0],
    ).toBe(400)
    expect(await call("POST", "/snapshots/named/restore")).toMatchObject([200, { id: "named" }])
    expect((await call("POST", "/snapshots/named/restore", undefined, "w"))[0]).toBe(404)
    // Taking a name again replaces it and lets the old checkpoint go.
    await call("POST", "/snapshots", { name: "named" })
    expect((await call("DELETE", "/snapshots/snap_1"))[0]).toBe(200)
    expect((await call("DELETE", "/snapshots/snap_1"))[0]).toBe(404)
    expect((await call("POST", "/reset"))[0]).toBe(200)
    expect((await call("GET", "/snapshots"))[1]).toEqual({ snapshots: [] })
    expect((await call("GET", "/snapshots", undefined, "w"))[1]).toMatchObject({
      snapshots: [{ id: "snap_1" }],
    })
    expect(log).toEqual([
      "retain cp_1",
      "retain cp_2",
      "retain cp_3",
      "checkout cp_2 in default",
      "retain cp_4",
      "release cp_2",
      "release cp_1",
      "reset default",
      "release cp_4",
    ])
    // The rest of the controls are there too, with the standard presets.
    expect(
      (await call("PUT", "/controls", { latency: "5ms", faults: [{ preset: "slow" }] }))[1],
    ).toMatchObject({ latency: { delayMs: 5 }, faults: [{ id: "slow" }] })
    expect((await call("DELETE", "/namespaces/w"))[0]).toBe(200)
    expect(log.slice(-2)).toEqual(["reset w", "release cp_3"])
  })
})
