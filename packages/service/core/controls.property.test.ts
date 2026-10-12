/**
 * The admin controls' guarantees as properties: for any control document and any script of
 * requests, a run replays, a reset returns to boot, a restore returns to its snapshot, a
 * snapshot is the same in another process, and nothing another namespace does shows up.
 *
 * Replay a failure with the seed fast-check prints: `FC_SEED=<seed> bun test controls.property`.
 */
import { describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { admin, type Mock, mock, ns, send, T0 } from "./controls.fixture.js"
import {
  CONTROL_HEADERS,
  type ControlHeaderInput,
  controlHeaders,
  type MockControls,
  normalizeFault,
  parseControlHeaders,
  parseDuration,
} from "./src/index.js"

const params = fcParameters(process.env)

// ── generators ─────────────────────────────────────────────────────

const duration = fc.oneof(
  fc.integer({ min: 0, max: 2000 }),
  fc.constantFrom("5ms", "40ms", "1s", "2m"),
)

const fault = fc
  .record({
    match: fc.constantFrom<Record<string, unknown>>(
      {},
      { operationId: "notes.create" },
      { operationId: "notes.list" },
      { method: "GET" },
      { pathPrefix: "/v1/notes/" },
      { query: { page: "*" } },
    ),
    schedule: fc.record(
      {
        after: fc.integer({ min: 0, max: 3 }),
        every: fc.integer({ min: 1, max: 3 }),
        count: fc.integer({ min: 0, max: 4 }),
        rate: fc.constantFrom(0.25, 0.5, 1),
        until: fc.constantFrom("30s", "10m"),
      },
      { requiredKeys: [] },
    ),
    action: fc.constantFrom<Record<string, unknown>>(
      { status: 503 },
      { status: 429, headers: { "retry-after": "1" }, body: { error: "slow down" } },
      { delay: "250ms", jitter: "100ms" },
      { timeout: "5s" },
      { drop: true },
      { truncate: 7 },
      { effect: "shout" },
      { status: 500, delay: 30 },
    ),
  })
  .map(({ match, schedule, action }) => ({ ...match, ...schedule, ...action }))

/** Controls under which a run is byte-for-byte reproducible: a frozen clock and virtual time. */
const document: fc.Arbitrary<MockControls> = fc.record(
  {
    seed: fc.oneof(fc.integer({ min: 0, max: 1_000_000 }), fc.constantFrom("alpha", "beta")),
    clock: fc.record({
      now: fc.integer({ min: T0, max: T0 + 1_000_000_000 }),
      frozen: fc.constant(true),
      autoAdvance: fc.integer({ min: 0, max: 5000 }),
    }),
    virtualTime: fc.constant(true),
    latency: fc.record({ delay: duration, jitter: fc.integer({ min: 0, max: 50 }) }),
    faults: fc.array(fault, { maxLength: 4 }),
  },
  { requiredKeys: ["clock", "virtualTime"] },
)

type Step =
  | { kind: "request"; method: string; path: string; body?: unknown; headers: ControlHeaderInput }
  | { kind: "admin"; method: string; path: string; body?: unknown }

const carried = fc.record(
  {
    delay: fc.constantFrom("10ms", "1s"),
    fault: fc.constantFrom<ControlHeaderInput["fault"]>(503, "drop", "rate_limited", "slow", {
      effect: "shout",
    }),
    advance: fc.constantFrom("1m", "-5s"),
    seed: fc.integer({ min: 0, max: 50 }),
    time: fc.integer({ min: T0, max: T0 + 1_000_000 }),
  },
  { requiredKeys: [] },
) as fc.Arbitrary<ControlHeaderInput>

const request: fc.Arbitrary<Step> = fc
  .tuple(
    fc.constantFrom<Pick<Step, "method" | "path"> & { body?: unknown }>(
      { method: "POST", path: "/v1/notes", body: { text: "a" } },
      { method: "POST", path: "/v1/notes", body: { text: "bb" } },
      { method: "GET", path: "/v1/notes" },
      { method: "GET", path: "/v1/notes?page=2" },
      { method: "GET", path: "/v1/notes/nope" },
      { method: "GET", path: "/v1/essay" },
      { method: "GET", path: "/not/in/the/contract" },
    ),
    carried,
  )
  .map(([call, headers]) => ({ kind: "request", ...call, headers }))

/** Admin calls that change controls. None of them reaches outside its namespace. */
const control: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant("admin" as const),
    method: fc.constant("POST"),
    path: fc.constant("/clock"),
    body: fc.record({ advance: fc.constantFrom("15m", -1000) }),
  }),
  fc.record({
    kind: fc.constant("admin" as const),
    method: fc.constant("PUT"),
    path: fc.constant("/latency"),
    body: fc.record({ delay: duration, jitter: fc.integer({ min: 0, max: 20 }) }),
  }),
  fault.map((body): Step => ({ kind: "admin", method: "POST", path: "/faults", body })),
  fc.constantFrom<Step>(
    { kind: "admin", method: "DELETE", path: "/faults" },
    { kind: "admin", method: "DELETE", path: "/latency" },
    { kind: "admin", method: "POST", path: "/faults", body: { preset: "flaky", count: 3 } },
    { kind: "admin", method: "PUT", path: "/controls", body: { seed: 11 } },
  ),
)

/** Admin calls that take, restore and drop snapshots, or wipe the namespace. */
const storage: fc.Arbitrary<Step> = fc.constantFrom<Step>(
  { kind: "admin", method: "POST", path: "/snapshots", body: { name: "one" } },
  { kind: "admin", method: "POST", path: "/snapshots" },
  { kind: "admin", method: "POST", path: "/snapshots/one/restore" },
  { kind: "admin", method: "DELETE", path: "/snapshots/one" },
  { kind: "admin", method: "DELETE", path: "/controls" },
  { kind: "admin", method: "POST", path: "/reset" },
)

const steps = (kinds: fc.Arbitrary<Step>[], maxLength = 14) =>
  fc.array(fc.oneof({ arbitrary: request, weight: 3 }, ...kinds), { maxLength })
const anySteps = steps([control, storage])

// ── running a script ───────────────────────────────────────────────

/**
 * Send each step in `namespace` and write down everything that comes back. `history: false`
 * leaves out the checkpoint a write is filed under: history only grows, so after a restore
 * the same write is the same response under a later checkpoint.
 */
const play = async (
  runtime: Mock,
  namespace: string,
  script: readonly Step[],
  { history = true } = {},
) => {
  const seen: unknown[] = []
  for (const step of script) {
    if (step.kind === "admin") {
      const answer = await admin(runtime, step.method, step.path, step.body, ns(namespace))
      seen.push([answer.status, answer.body])
      continue
    }
    const settled = await send(runtime, step.method, step.path, {
      ...(step.body !== undefined ? { body: step.body } : {}),
      headers: controlHeaders({ ...step.headers, namespace }),
    }).catch((error: Error) => error)
    seen.push(
      settled instanceof Response
        ? [
            settled.status,
            Object.fromEntries(
              [...settled.headers].filter(
                ([name]) => history || name !== "x-mockingbird-checkpoint",
              ),
            ),
            await settled.text().catch((error: Error) => `cut: ${error.message}`),
          ]
        : settled.message,
    )
  }
  return seen
}

/** What a namespace is, as its admin API shows it. The journal is kept apart: nothing restores it. */
const look = async (runtime: Mock, namespace: string) => ({
  controls: (await admin(runtime, "GET", "/controls", undefined, ns(namespace))).body,
  state: (await admin(runtime, "GET", "/state/notes?limit=200", undefined, ns(namespace))).body,
})
const journal = async (runtime: Mock, namespace: string) =>
  (await admin(runtime, "GET", "/requests", undefined, ns(namespace))).body

const text = (value: unknown) => JSON.stringify(value)

// ── properties ─────────────────────────────────────────────────────

describe("for any controls and any requests", () => {
  test("the same run gives the same bytes, journal included", async () => {
    await fc.assert(
      fc.asyncProperty(document, anySteps, async (adminControls, script) => {
        const run = async () => {
          const runtime = mock({ adminControls })
          return text([
            await play(runtime, "w", script),
            await look(runtime, "w"),
            await journal(runtime, "w"),
          ])
        }
        expect(await run()).toBe(await run())
      }),
      params,
    )
  })

  test("a reset returns the namespace to what it was at boot", async () => {
    await fc.assert(
      fc.asyncProperty(document, anySteps, anySteps, async (adminControls, noise, script) => {
        const fresh = mock({ adminControls })
        const expected = text([await play(fresh, "w", script), await look(fresh, "w")])

        const used = mock({ adminControls })
        await play(used, "w", noise)
        await admin(used, "POST", "/reset", undefined, ns("w"))
        expect(text([await play(used, "w", script), await look(used, "w")])).toBe(expected)

        // `?all=1` does the same for every namespace at once.
        await play(used, "w", noise)
        await admin(used, "POST", "/reset?all=1")
        expect(text([await play(used, "w", script), await look(used, "w")])).toBe(expected)

        // And so does a header on the first request that follows.
        const head = script[0]
        if (head?.kind !== "request") return
        await play(used, "w", noise)
        const resetting = { ...head, headers: { ...head.headers, reset: true } }
        expect(
          text([await play(used, "w", [resetting, ...script.slice(1)]), await look(used, "w")]),
        ).toBe(expected)
      }),
      params,
    )
  })

  test("a restore returns the namespace to its snapshot, so what followed replays", async () => {
    const after = steps([control], 10)
    await fc.assert(
      fc.asyncProperty(
        document,
        anySteps,
        after,
        after,
        async (adminControls, before, script, noise) => {
          const runtime = mock({ adminControls })
          await play(runtime, "w", before)
          await admin(runtime, "POST", "/snapshots", { name: "here" }, ns("w"))
          const taken = text(await look(runtime, "w"))
          const replay = async (first: Step[] = []) =>
            text([
              await play(runtime, "w", [...first, ...script.slice(first.length)], {
                history: false,
              }),
              await look(runtime, "w"),
            ])
          const first = await replay()

          await play(runtime, "w", noise)
          expect(
            (await admin(runtime, "POST", "/snapshots/here/restore", undefined, ns("w"))).status,
          ).toBe(200)
          expect(text(await look(runtime, "w"))).toBe(taken)
          expect(await replay()).toBe(first)

          // The same through a header on the first request that follows.
          const head = script[0]
          if (head?.kind !== "request") return
          await play(runtime, "w", noise)
          expect(await replay([{ ...head, headers: { ...head.headers, restore: "here" } }])).toBe(
            first,
          )
        },
      ),
      params,
    )
  })

  test("an exported snapshot is the same namespace in another process", async () => {
    const after = steps([control], 10)
    await fc.assert(
      fc.asyncProperty(document, anySteps, after, async (adminControls, before, script) => {
        const source = mock({ adminControls })
        await play(source, "w", before)
        await admin(source, "POST", "/snapshots", { name: "here" }, ns("w"))
        const exported = (await admin(source, "GET", "/snapshots/here", undefined, ns("w"))).body
        // Dropped so the two sides list the same snapshots from here on.
        for (const each of ((await look(source, "w")).controls as { snapshots: { id: string }[] })
          .snapshots)
          await admin(source, "DELETE", `/snapshots/${each.id}`, undefined, ns("w"))

        // Booted differently on purpose: everything it needs is in the document.
        const twin = mock({ seed: 424242 })
        expect((await admin(twin, "PUT", "/snapshots/here", exported, ns("v"))).status).toBe(200)
        await admin(twin, "POST", "/snapshots/here/restore", undefined, ns("v"))
        expect((await admin(twin, "GET", "/snapshots/here", undefined, ns("v"))).body).toEqual(
          exported,
        )
        await admin(twin, "DELETE", "/snapshots/here", undefined, ns("v"))

        const rename = (value: unknown) =>
          text(value).replaceAll('ns=v"', 'ns=w"').replaceAll('"namespace":"v"', '"namespace":"w"')
        const quiet = { history: false }
        expect(rename([await play(twin, "v", script, quiet), await look(twin, "v")])).toBe(
          text([await play(source, "w", script, quiet), await look(source, "w")]),
        )
      }),
      params,
    )
  })

  test("nothing another namespace does changes this one", async () => {
    const interference = fc.array(
      fc.tuple(fc.constantFrom("default", "other"), fc.oneof(request, control, storage)),
      { maxLength: 4 },
    )
    await fc.assert(
      fc.asyncProperty(
        document,
        fc.array(
          fc.tuple(fc.oneof({ arbitrary: request, weight: 3 }, control, storage), interference),
          { maxLength: 12 },
        ),
        async (adminControls, script) => {
          const quiet = mock({ adminControls })
          const alone = text([
            await play(
              quiet,
              "w",
              script.map(([step]) => step),
            ),
            await look(quiet, "w"),
            await journal(quiet, "w"),
          ])

          const busy = mock({ adminControls })
          const beside: unknown[] = []
          for (const [step, noise] of script) {
            for (const [namespace, each] of noise) await play(busy, namespace, [each])
            beside.push(...(await play(busy, "w", [step])))
          }
          expect(text([beside, await look(busy, "w"), await journal(busy, "w")])).toBe(alone)
        },
      ),
      params,
    )
  })

  test("what GET /controls reports is a document PUT /controls accepts and reports back", async () => {
    // Applying a rule arms it afresh, so its counters are the one thing that starts over.
    const armed = (controls: unknown) => {
      const { faults, ...rest } = controls as { faults: { count?: number }[] }
      return {
        ...rest,
        faults: faults.map((rule) => ({
          ...rule,
          hits: 0,
          seen: 0,
          remaining: rule.count ?? null,
        })),
      }
    }
    await fc.assert(
      fc.asyncProperty(document, anySteps, async (adminControls, script) => {
        const runtime = mock({ adminControls })
        await play(runtime, "w", script)
        const read = (await look(runtime, "w")).controls
        const applied = await admin(runtime, "PUT", "/controls", read, ns("w"))
        expect([applied.status, applied.body]).toEqual([200, armed(read)])
        // In another namespace it is the same controls again, under that namespace's name.
        const { snapshots: _snapshots, ...portable } = read as { snapshots: unknown }
        const copied = await admin(runtime, "PUT", "/controls", portable, ns("copy"))
        expect(JSON.parse(text(copied.body).replaceAll('"copy"', '"w"'))).toEqual({
          ...armed(read),
          snapshots: [],
        })
      }),
      params,
    )
  })

  test("a document with one bad rule in it changes nothing, wherever the rule is", async () => {
    const bad = fc.constantFrom<unknown>(
      { statuss: 500 },
      { method: "GET" },
      { status: 99 },
      { status: 503, rate: 2 },
      { preset: "no-such-preset" },
      { preset: "slow", delay: "soon" },
      { status: 503, namespace: "*" },
      "not a rule",
    )
    await fc.assert(
      fc.asyncProperty(
        document,
        anySteps,
        document,
        bad,
        fc.nat(),
        async (adminControls, script, next, rule, at) => {
          const runtime = mock({ adminControls })
          await play(runtime, "w", script)
          const before = text(await look(runtime, "w"))
          const faults = [...(next.faults ?? [])]
          faults.splice(at % (faults.length + 1), 0, rule as never)
          for (const [path, body] of [
            ["/controls", { ...next, faults }],
            ["/faults", { faults }],
          ] as const) {
            expect((await admin(runtime, "PUT", path, body, ns("w"))).status).toBe(400)
            expect(text(await look(runtime, "w"))).toBe(before)
          }
        },
      ),
      params,
    )
  })
})

describe("faults fire exactly when their schedule says", () => {
  test("after, every and count pick the same requests as counting by hand", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record(
          {
            after: fc.integer({ min: 0, max: 6 }),
            every: fc.integer({ min: 1, max: 5 }),
            count: fc.integer({ min: 0, max: 6 }),
          },
          { requiredKeys: [] },
        ),
        fc.integer({ min: 0, max: 30 }),
        async (schedule, requests) => {
          const runtime = mock()
          await admin(runtime, "POST", "/faults", { ...schedule, status: 599 })
          const fired: number[] = []
          for (let nth = 1; nth <= requests; nth++)
            if ((await send(runtime, "GET", "/v1/notes")).status === 599) fired.push(nth)

          const expected: number[] = []
          for (let nth = 1; nth <= requests; nth++) {
            const position = nth - (schedule.after ?? 0)
            if (position <= 0 || position % (schedule.every ?? 1) !== 0) continue
            if (schedule.count !== undefined && expected.length >= schedule.count) break
            expected.push(nth)
          }
          expect(fired).toEqual(expected)
          const listed = (
            await admin<{ hits: number; seen: number; remaining: number | null }>(
              runtime,
              "GET",
              "/faults/fault_1",
            )
          ).body
          expect(listed.hits).toBe(expected.length)
          expect(listed.remaining).toBe(
            schedule.count === undefined ? null : schedule.count - expected.length,
          )
        },
      ),
      params,
    )
  })

  test("a rate faults that share of requests, and the same ones for the same seed", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.constantFrom(0, 0.2, 0.5, 0.8, 1),
        async (seed, rate) => {
          const run = async () => {
            const runtime = mock({ seed })
            await admin(runtime, "POST", "/faults", { status: 599, rate })
            let fired = ""
            for (let i = 0; i < 200; i++)
              fired += (await send(runtime, "GET", "/v1/notes")).status === 599 ? "X" : "."
            return fired
          }
          const fired = await run()
          expect(await run()).toBe(fired)
          const share = fired.replaceAll(".", "").length / fired.length
          expect(Math.abs(share - rate)).toBeLessThan(0.15)
        },
      ),
      { ...params, numRuns: Math.min(params.numRuns ?? 20, 20) },
    )
  })

  test("a window opens and closes on the mock clock, to the millisecond", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 1, max: 5000 }),
        fc.array(fc.integer({ min: 0, max: 12_000 }), { maxLength: 12 }),
        async (from, length, offsets) => {
          const runtime = mock({ adminControls: { clock: { now: T0, frozen: true } } })
          await admin(runtime, "POST", "/faults", {
            status: 599,
            from: T0 + from,
            until: T0 + from + length,
          })
          for (const offset of offsets) {
            await admin(runtime, "POST", "/clock", { now: T0 + offset })
            const inside = offset >= from && offset < from + length
            expect([offset, (await send(runtime, "GET", "/v1/notes")).status === 599]).toEqual([
              offset,
              inside,
            ])
          }
        },
      ),
      params,
    )
  })
})

describe("controls survive being written down", () => {
  test("headers built from any controls parse back to the same controls", () => {
    const input = fc.record(
      {
        reset: fc.constant(true),
        restore: fc.constantFrom("base", "snap_1"),
        seed: fc.oneof(fc.integer({ min: 0, max: 1e9 }), fc.constantFrom("alpha", "v2-beta")),
        time: fc.oneof(fc.integer({ min: 0, max: 4e12 }), fc.constantFrom("2030-01-01T00:00:00Z")),
        advance: fc.oneof(
          fc.integer({ min: -1e6, max: 1e6 }),
          fc.constantFrom("15m", "2h", "-30s"),
        ),
        virtualTime: fc.boolean(),
        delay: duration,
        timeout: duration,
        fault: fc.oneof(
          fc.constantFrom<ControlHeaderInput["fault"]>(
            503,
            "drop",
            "rate_limited",
            "status=503; delay=2s; header.retry-after=5",
          ),
          fault.map((rule) => rule as Record<string, unknown>),
        ),
        snapshot: fc.constantFrom("after", "s.1"),
      },
      { requiredKeys: [] },
    ) as fc.Arbitrary<ControlHeaderInput>
    fc.assert(
      fc.property(input, (given) => {
        const parsed = parseControlHeaders(new Headers(controlHeaders(given))) ?? {}
        const expected: Record<string, unknown> = {}
        if (given.reset) expected.reset = true
        if (given.restore !== undefined) expected.restore = given.restore
        if (given.seed !== undefined) expected.seed = given.seed
        if (given.time !== undefined)
          expected.time =
            typeof given.time === "number" ? given.time : Date.parse(String(given.time))
        if (given.advance !== undefined) expected.advance = parseDuration(given.advance)
        if (given.virtualTime !== undefined) expected.virtualTime = given.virtualTime
        if (given.delay !== undefined) expected.delay = parseDuration(given.delay)
        if (given.timeout !== undefined) expected.timeout = parseDuration(given.timeout)
        if (given.snapshot !== undefined) expected.snapshot = given.snapshot
        const { fault: carriedFault, ...rest } = parsed
        expect(rest).toEqual(expected)
        if (typeof given.fault === "object") expect(carriedFault).toEqual(given.fault)
        else expect(carriedFault !== undefined).toBe(given.fault !== undefined)
      }),
      params,
    )
  })

  test("a rule in stored form is its own stored form", () => {
    fc.assert(
      fc.property(fault, fc.integer({ min: 0, max: 4e12 }), (rule, now) => {
        const stored = normalizeFault(rule, { id: "r", namespace: "w", now, strict: true })
        expect(normalizeFault(stored, { now: now + 12_345, strict: true })).toEqual(stored)
      }),
      params,
    )
  })

  test("the namespace header is the only thing that says where a request goes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[A-Za-z0-9_.-]{1,64}$/),
        fc.string({ maxLength: 70 }),
        async (key, other) => {
          const runtime = mock()
          const made = await send(runtime, "POST", "/v1/notes", {
            body: { text: "a" },
            headers: { [CONTROL_HEADERS.namespace]: key },
          })
          expect([made.status, made.headers.get("x-mockingbird")]).toEqual([
            200,
            expect.stringContaining(`ns=${key}`),
          ])
          if (!/^[A-Za-z0-9_.-]{1,64}$/.test(other)) {
            const headers = new Headers()
            try {
              headers.set(CONTROL_HEADERS.namespace, other)
            } catch {
              return
            }
            if (
              headers.get(CONTROL_HEADERS.namespace) === "" ||
              /^[A-Za-z0-9_.-]{1,64}$/.test(headers.get(CONTROL_HEADERS.namespace) ?? "")
            )
              return
            const refused = await runtime.fetch(
              new Request("http://mock.local/v1/notes", { headers }),
            )
            expect(refused.status).toBe(400)
            expect(runtime.namespaces()).not.toContain(other)
          }
        },
      ),
      params,
    )
  })
})
