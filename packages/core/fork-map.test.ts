import { expect, test } from "bun:test"
import * as fc from "fast-check"
import { ForkMap } from "./src/fork-map.js"

test("forked maps retain native Map keys, insertion order, deletes and reference semantics", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          key: fc.oneof(fc.integer({ min: -100, max: 100 }), fc.string(), fc.bigInt()),
          value: fc.oneof(fc.integer(), fc.constant(undefined)),
          action: fc.constantFrom("set", "delete", "fork", "clear"),
        }),
        { maxLength: 300 },
      ),
      (actions) => {
        const maps = [
          {
            actual: new ForkMap<string | number | bigint, number | undefined>(),
            expected: new Map(),
          },
        ]
        for (const [index, action] of actions.entries()) {
          const map = maps[index % maps.length]
          if (!map) throw new Error("missing map")
          if (action.action === "set") {
            map.actual.set(action.key, action.value)
            map.expected.set(action.key, action.value)
          } else if (action.action === "delete")
            expect(map.actual.delete(action.key)).toBe(map.expected.delete(action.key))
          else if (action.action === "clear") {
            map.actual.clear()
            map.expected.clear()
          } else maps.push({ actual: map.actual.fork(), expected: new Map(map.expected) })
          for (const { actual, expected } of maps) {
            expect([...actual]).toEqual([...expected])
            expect(actual.size).toBe(expected.size)
            expect(actual.get(action.key)).toBe(expected.get(action.key))
            expect(actual.has(action.key)).toBe(expected.has(action.key))
          }
        }
      },
    ),
    { seed: 741901, numRuns: 200 },
  )
  const actual = new ForkMap<number, string>([
    [-0, "zero"],
    [Number.NaN, "nan"],
  ])
  expect([...actual]).toEqual([
    ...new Map([
      [-0, "zero"],
      [Number.NaN, "nan"],
    ]),
  ])
  expect(actual.get(Number.NaN)).toBe("nan")
  expect(Object.is(actual.keys().next().value, -0)).toBe(false)
})

test("forks isolate every directory/order page and retain row-value references", () => {
  const original = new ForkMap<number, object>()
  for (let key = 0; key < 100000; key++) original.set(key, { key })
  const left = original.fork()
  const right = original.fork()
  for (const key of [0, 31, 32, 1023, 1024, 32767, 32768, 99999]) {
    left.set(key, { changed: key })
    right.delete(key)
    expect(original.get(key)).toEqual({ key })
    expect(left.get(key)).toEqual({ changed: key })
    expect(right.has(key)).toBe(false)
  }
  expect(left.get(50000)).toBe(original.get(50000))
  expect([...right.keys()].length).toBe(99992)
  original.set(50000, { original: true })
  expect(left.get(50000)).toEqual({ key: 50000 })
  const counts: number[] = []
  const object = { value: 7 }
  new ForkMap([["a", object]]).forEach(function (this: { value: number }, value, key, map) {
    expect(this).toBe(object)
    expect(key).toBe("a")
    expect(map.get(key)).toBe(value)
    counts.push(value.value)
  }, object)
  expect(counts).toEqual([7])
})

test("live iterators match native Map through updates, clear, reinsertion and compaction", () => {
  for (const clear of [false, true]) {
    const actual = new ForkMap<number, number>()
    const expected = new Map<number, number>()
    for (let key = 0; key < 4096; key++) {
      actual.set(key, key)
      expected.set(key, key)
    }
    const a = actual.entries()
    const b = expected.entries()
    for (let i = 0; i < 500; i++) expect(a.next()).toEqual(b.next())
    for (let i = 0; i < 3500; i++) {
      actual.delete(i)
      expected.delete(i)
    }
    if (clear) {
      actual.clear()
      expected.clear()
    }
    for (let key = 6000; key < 6020; key++) {
      actual.set(key, key)
      expected.set(key, key)
    }
    actual.set(6000, 42)
    expected.set(6000, 42)
    expect([...a]).toEqual([...b])
    actual.set(9999, 1)
    expect(a.next().done).toBe(true)
  }
})

test("sparse forks bound copied entries for sequential, strided and 64-bit keys", () => {
  type Probe = { copyBucket(bucket: Map<unknown, unknown>): Map<unknown, unknown> }
  const prototype = ForkMap.prototype as unknown as Probe
  const copy = prototype.copyBucket
  let copied = 0
  prototype.copyBucket = function (bucket) {
    copied += bucket.size
    return copy.call(this, bucket)
  }
  try {
    for (const key of [
      (i: number) => i,
      (i: number) => i * 1024,
      (i: number) => BigInt(i) << 32n,
    ]) {
      let map = new ForkMap<number | bigint, number>()
      for (let i = 0; i < 100000; i++) map.set(key(i), i)
      copied = 0
      const historical = map.fork()
      for (let i = 0; i < 100; i++) {
        map = map.fork()
        map.set(key(i), -i - 1)
      }
      expect(copied).toBeLessThan(20000)
      expect(historical.get(key(31))).toBe(31)
      expect(map.get(key(31))).toBe(-32)
    }
  } finally {
    prototype.copyBucket = copy
  }
})

test("changed-bucket iteration reconstructs native Map contents across fork, clear and deletes", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.tuple(
          fc.integer({ min: -100, max: 100 }),
          fc.oneof(fc.integer(), fc.constant(undefined), fc.constant(Number.NaN)),
        ),
      ),
      fc.array(
        fc.record({
          key: fc.integer({ min: -100, max: 100 }),
          value: fc.integer(),
          op: fc.constantFrom("set", "delete", "clear"),
        }),
        { maxLength: 100 },
      ),
      (entries, actions) => {
        const before = new ForkMap(entries)
        const after = before.fork()
        for (const action of actions) {
          if (action.op === "set") after.set(action.key, action.value)
          else if (action.op === "delete") after.delete(action.key)
          else after.clear()
        }
        const recovered = new Map(before)
        for (const change of after.changes(before)) {
          if (change.deleted) recovered.delete(change.key)
          else recovered.set(change.key, change.value)
        }
        expect(recovered.size).toBe(after.size)
        for (const [key, value] of after) {
          expect(recovered.has(key)).toBe(true)
          expect(Object.is(recovered.get(key), value)).toBe(true)
        }
        expect([...after.changes(after.fork())]).toEqual([])
      },
    ),
    { seed: 741902, numRuns: 200 },
  )
})
