import { expect, test } from "bun:test"
import fc from "fast-check"
import {
  clearNamespace,
  compareKeys,
  json,
  type KeyValueEntry,
  type KeyValueStore,
  type ListOptions,
  namespace,
  utf8,
} from "./src/index.js"

class ReferenceKV implements KeyValueStore {
  readonly entries = new Map<string, Uint8Array>()
  async get(key: string) {
    return this.entries.get(key)
  }
  async set(key: string, value: Uint8Array) {
    this.entries.set(key, value.slice())
  }
  async delete(key: string) {
    this.entries.delete(key)
  }
  async *list(options: ListOptions = {}): AsyncIterable<KeyValueEntry> {
    const prefix = options.prefix ?? ""
    const keys = [...this.entries.keys()].filter((k) => k.startsWith(prefix)).sort(compareKeys)
    for (const key of keys) {
      const value = this.entries.get(key)
      if (value) yield { key, value }
    }
  }
}

const collect = async <T>(iterable: AsyncIterable<T>) => {
  const out: T[] = []
  for await (const item of iterable) out.push(item)
  return out
}

test("utf8 codec round-trips every string", () => {
  fc.assert(
    fc.property(fc.string({ unit: "grapheme" }), (s) => {
      expect(utf8.decode(utf8.encode(s))).toBe(s)
    }),
  )
})

test("json view round-trips JSON values", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string(), fc.jsonValue(), async (key, value) => {
      const kv = json<unknown>(new ReferenceKV())
      await kv.set(key, value)
      expect(await kv.get(key)).toEqual(value)
    }),
  )
})

test("namespaces are isolated, ordered and clearable", async () => {
  const name = fc.string({ minLength: 1 }).filter((s) => !s.includes(":"))
  await fc.assert(
    fc.asyncProperty(
      name,
      name,
      fc.uniqueArray(fc.tuple(fc.string(), fc.uint8Array()), {
        selector: ([k]) => k,
      }),
      fc.uniqueArray(fc.tuple(fc.string(), fc.uint8Array()), {
        selector: ([k]) => k,
      }),
      async (a, b, aEntries, bEntries) => {
        fc.pre(a !== b && !a.startsWith(b) && !b.startsWith(a))
        const root = new ReferenceKV()
        const kvA = namespace(root, a)
        const kvB = namespace(root, b)
        for (const [k, v] of aEntries) await kvA.set(k, v)
        for (const [k, v] of bEntries) await kvB.set(k, v)

        const listedA = await collect(kvA.list())
        expect(listedA.map((e) => e.key)).toEqual([...aEntries.map(([k]) => k)].sort(compareKeys))
        for (const [k, v] of aEntries) expect(await kvA.get(k)).toEqual(v)
        for (const [k] of aEntries) {
          if (!bEntries.some(([bk]) => bk === k)) expect(await kvB.get(k)).toBeUndefined()
        }

        expect(await clearNamespace(root, a)).toBe(aEntries.length)
        expect(await collect(kvA.list())).toEqual([])
        expect((await collect(kvB.list())).length).toBe(bEntries.length)
      },
    ),
  )
})
