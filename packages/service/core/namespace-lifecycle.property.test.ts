/**
 * Namespace lifecycle as a property: for any script of writes, snapshots, drops and wall-clock
 * waits across a few namespaces, the namespaces still alive are exactly the ones a model of
 * idle expiry keeps, `GET /__admin/metrics` counts exactly what the model holds, and a
 * namespace that came back after being forgotten starts empty.
 *
 * Replay a failure with the seed fast-check prints: `FC_SEED=<seed> bun test namespace-lifecycle`.
 */
import { describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { admin, create, list, mock, ns } from "./controls.fixture.js"
import type { ResourceReport } from "./src/index.js"

const params = fcParameters(process.env)

const IDLE_MS = 1_000

type Step =
  | { kind: "write"; namespace: string }
  | { kind: "snapshot"; namespace: string; name: string }
  | { kind: "drop"; namespace: string }
  | { kind: "wait"; ms: number }

const namespace = fc.constantFrom("a", "b", "c")
const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant("write" as const), namespace }),
  fc.record({
    kind: fc.constant("snapshot" as const),
    namespace,
    name: fc.constantFrom("s1", "s2"),
  }),
  fc.record({ kind: fc.constant("drop" as const), namespace }),
  fc.record({ kind: fc.constant("wait" as const), ms: fc.integer({ min: 0, max: 2 * IDLE_MS }) }),
)

type Held = { records: number; snapshots: Set<string>; seen: number }

describe("namespace lifecycle", () => {
  test("live namespaces and held resources follow the idle-expiry model", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { maxLength: 30 }), async (steps) => {
        let now = 0
        const runtime = mock({ namespaceIdleMs: IDLE_MS, io: { wallNow: () => now } })
        const model = new Map<string, Held>()
        const touch = (name: string) => {
          for (const [key, held] of model)
            if (key !== name && now - held.seen > IDLE_MS) model.delete(key)
          const held = model.get(name) ?? { records: 0, snapshots: new Set<string>(), seen: now }
          held.seen = now
          model.set(name, held)
          return held
        }
        for (const each of steps) {
          if (each.kind === "wait") {
            now += each.ms
            continue
          }
          if (each.kind === "write") {
            expect((await create(runtime, "x", ns(each.namespace))).status).toBe(200)
            touch(each.namespace).records++
          } else if (each.kind === "snapshot") {
            const made = await admin(
              runtime,
              "POST",
              "/snapshots",
              { name: each.name },
              ns(each.namespace),
            )
            expect(made.status).toBe(201)
            touch(each.namespace).snapshots.add(each.name)
          } else {
            touch("default")
            expect((await admin(runtime, "DELETE", `/namespaces/${each.namespace}`)).status).toBe(
              200,
            )
            model.delete(each.namespace)
          }
        }
        touch("default")
        const report = (
          await admin<{ resources: ResourceReport }>(runtime, "GET", "/metrics?resources=1")
        ).body.resources
        const live = [...model.keys()].filter((key) => key !== "default").sort()
        expect(runtime.namespaces().filter((key) => key !== "default")).toEqual(live)
        expect(report.records).toBe([...model.values()].reduce((n, h) => n + h.records, 0))
        expect(report.snapshots).toBe([...model.values()].reduce((n, h) => n + h.snapshots.size, 0))
        for (const gone of ["a", "b", "c"].filter((key) => !model.has(key)))
          expect(await list(runtime, ns(gone))).toEqual([])
      }),
      params,
    )
  })
})
