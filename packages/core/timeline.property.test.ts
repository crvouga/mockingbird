import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { Timeline } from "./src/timeline.js"

describe("Timeline", () => {
  test("forks share a checkpoint and then diverge", () => {
    const timeline = new Timeline<{ value: number }>()
    const root = timeline.commit({ value: 1 })
    timeline.fork("alternate", { from: root.id })
    const alternate = timeline.commit({ value: 2 }, { branch: "alternate" })
    expect(timeline.head("main")?.value.value).toBe(1)
    expect(timeline.head("alternate")?.value.value).toBe(2)
    expect(alternate.parent).toBe(root.id)
  })

  test("model-based random walks preserve branch heads and the retention bound", () => {
    const command = fc.oneof(
      fc.record({
        kind: fc.constant("commit" as const),
        branch: fc.constantFrom("main", "a", "b"),
        value: fc.integer(),
      }),
      fc.record({ kind: fc.constant("fork" as const), branch: fc.constantFrom("a", "b") }),
    )
    fc.assert(
      fc.property(fc.array(command, { minLength: 1, maxLength: 200 }), (commands) => {
        const timeline = new Timeline<number>({ maxCheckpoints: 8 })
        const model = new Map<string, number>()
        for (const action of commands) {
          if (action.kind === "fork") {
            if (!timeline.hasBranch(action.branch) && timeline.head()) {
              timeline.fork(action.branch)
              model.set(action.branch, model.get("main") as number)
            }
          } else if (action.branch === "main" || timeline.hasBranch(action.branch)) {
            timeline.commit(action.value, { branch: action.branch })
            model.set(action.branch, action.value)
          }
          for (const [branch, value] of model) expect(timeline.head(branch)?.value).toBe(value)
          expect(timeline.checkpoints().length).toBeLessThanOrEqual(
            8 + Object.keys(timeline.branches()).length,
          )
        }
      }),
      { numRuns: 200 },
    )
  })

  test("IDs and timestamps are reproducible with an injected clock", () => {
    const run = () => {
      let now = 100
      const timeline = new Timeline<string>({ now: () => now++ })
      return [timeline.commit("a"), timeline.commit("b")].map(({ id, at, parent }) => ({
        id,
        at,
        parent,
      }))
    }
    expect(run()).toEqual(run())
  })

  test("explicit pins preserve compatibility snapshots without weakening bounded GC", () => {
    const timeline = new Timeline<number>({ maxCheckpoints: 2 })
    const pinned = timeline.commit(0)
    timeline.retain(pinned.id)
    for (let value = 1; value <= 10_000; value++) timeline.commit(value)
    expect(timeline.get(pinned.id).value).toBe(0)
    expect(timeline.size).toBe(2) // the pin consumes one configured retention slot
    expect(timeline.release(pinned.id)).toBe(true)
    timeline.commit(10_001)
    expect(timeline.size).toBe(2)
    expect(() => timeline.get(pinned.id)).toThrow()
  })

  test("large histories retain only the configured tail", () => {
    const timeline = new Timeline<number>({ maxCheckpoints: 32 })
    for (let value = 0; value < 100_000; value++) timeline.commit(value)
    expect(timeline.size).toBe(32)
    expect(timeline.head()?.value).toBe(99_999)
    expect(timeline.checkpoints().map((point) => point.value)).toEqual(
      Array.from({ length: 32 }, (_, index) => 99_968 + index),
    )
  })
})
