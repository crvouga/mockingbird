import { describe, expect, test } from "bun:test"
import {
  createRuntime,
  IdSequence,
  type InstanceContext,
  idBaseOf,
  normalizeIdBase,
} from "./src/index.js"

/** A one-route service that issues the next `msg_` id on every POST, the way an emulator would. */
const bootEmulator = (options: { idBase?: number | string; io?: { wallNow(): number } }) =>
  createRuntime({
    name: "ids",
    ...options,
    create(context: InstanceContext) {
      const ids = new IdSequence(context.sqlite, context.namespace, "ids")
      return {
        async reset() {},
        async fetch() {
          return Response.json({ id: ids.next("msg_") })
        },
      }
    },
  })

const issue = async (runtime: ReturnType<typeof bootEmulator>, count = 1): Promise<string[]> => {
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const response = await runtime.fetch(
      new Request("http://mock.test/messages", { method: "POST" }),
    )
    out.push(((await response.json()) as { id: string }).id)
  }
  return out
}

describe("idBase", () => {
  test("by default every boot reissues the previous boot's ids", async () => {
    expect(await issue(bootEmulator({}), 3)).toEqual(await issue(bootEmulator({}), 3))
  })

  test("a different idBase gives a boot ids no other boot issued", async () => {
    const first = await issue(bootEmulator({ idBase: 1 }), 50)
    const second = await issue(bootEmulator({ idBase: 2 }), 50)
    expect(first.filter((id) => second.includes(id))).toEqual([])
    expect(new Set(first).size).toBe(50)
    expect(first).not.toEqual(await issue(bootEmulator({}), 50))
  })

  test("the same idBase is deterministic, and a string of digits is that number", async () => {
    const a = await issue(bootEmulator({ idBase: 7 }), 5)
    expect(await issue(bootEmulator({ idBase: 7 }), 5)).toEqual(a)
    expect(await issue(bootEmulator({ idBase: "7" }), 5)).toEqual(a)
  })

  test("idBase 0 is the default ids", async () => {
    expect(await issue(bootEmulator({ idBase: 0 }), 5)).toEqual(await issue(bootEmulator({}), 5))
  })

  test("a reset keeps the boot's base", async () => {
    const runtime = bootEmulator({ idBase: 9 })
    const sibling = bootEmulator({ idBase: 9 })
    await issue(runtime, 3)
    await runtime.reset()
    expect(idBaseOf(runtime.sqlite)).toBe(9)
    // Counters live in the service's state and a reset leaves them alone, so the run goes on.
    expect(await issue(runtime, 3)).toEqual((await issue(sibling, 6)).slice(3))
  })

  test('"boot" derives the base from the wall clock, so two boots differ', async () => {
    let now = Date.parse("2030-01-01T00:00:00Z")
    const io = { wallNow: () => now }
    const first = bootEmulator({ idBase: "boot", io })
    expect(idBaseOf(first.sqlite)).toBe(now)
    now += 1
    const second = bootEmulator({ idBase: "boot", io })
    expect(idBaseOf(second.sqlite)).toBe(now)
    expect(await issue(first, 3)).not.toEqual(await issue(second, 3))
  })

  test("runtime.setIdBase applies the base to ids issued from then on", async () => {
    const runtime = bootEmulator({})
    const [plain] = await issue(runtime, 1)
    expect(runtime.setIdBase(5)).toBe(5)
    const other = bootEmulator({ idBase: 5 })
    await issue(other, 1)
    expect((await issue(runtime, 1))[0]).toBe((await issue(other, 1))[0] as string)
    expect(plain).not.toBe((await issue(other, 1))[0])
  })

  test("an unusable base is refused", () => {
    for (const bad of [-1, 1.5, "abc", "", Number.NaN, 2 ** 60]) {
      expect(() => normalizeIdBase(bad)).toThrow(/idBase/)
    }
    expect(() => bootEmulator({ idBase: -3 })).toThrow(/non-negative integer/)
    expect(normalizeIdBase(" 12 ")).toBe(12)
  })
})
