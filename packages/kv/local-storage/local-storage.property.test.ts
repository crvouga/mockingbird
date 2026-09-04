import { expect, test } from "bun:test"
import { keyValueStoreProperties } from "@crvouga/mockingbird-kv-properties"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { decodeBase64, encodeBase64, LocalStorageKV, type StorageLike } from "./src/index.js"

/** Minimal DOM `Storage` stand-in with deliberately unstable `key(i)` ordering. */
class FakeStorage implements StorageLike {
  private readonly items = new Map<string, string>()
  get length() {
    return this.items.size
  }
  key(index: number) {
    const keys = [...this.items.keys()].reverse()
    return keys[index] ?? null
  }
  getItem(key: string) {
    return this.items.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.items.set(key, value)
  }
  removeItem(key: string) {
    this.items.delete(key)
  }
}

const params = fcParameters(process.env)

test("base64 round-trips arbitrary bytes", () => {
  fc.assert(
    fc.property(fc.uint8Array(), (bytes) => {
      expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes)
    }),
    params,
  )
})

test("LocalStorageKV satisfies the KeyValueStore contract", async () => {
  await keyValueStoreProperties({
    create: () => new LocalStorageKV({ storage: new FakeStorage(), prefix: "mb:" }),
    ...params,
  })
})

test("two prefixes sharing one Storage never observe each other", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({ minLength: 1 }), fc.uint8Array(), async (key, value) => {
      const storage = new FakeStorage()
      const a = new LocalStorageKV({ storage, prefix: "a:" })
      const b = new LocalStorageKV({ storage, prefix: "b:" })
      await a.set(key, value)
      expect(await b.get(key)).toBeUndefined()
      let count = 0
      for await (const _ of b.list()) count++
      expect(count).toBe(0)
    }),
    params,
  )
})
