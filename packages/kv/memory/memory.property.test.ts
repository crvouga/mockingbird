import { expect, test } from "bun:test"
import { keyValueStoreProperties } from "@crvouga/mockingbird-kv-properties"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { MemoryKV } from "./src/index.js"

const params = fcParameters(process.env)

test("MemoryKV satisfies the KeyValueStore contract", async () => {
  await keyValueStoreProperties({ create: () => new MemoryKV(), ...params })
})

test("snapshot/restore round-trips contents and fromSnapshot is independent", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(fc.tuple(fc.string(), fc.uint8Array()), { selector: ([k]) => k }),
      fc.tuple(fc.string(), fc.uint8Array()),
      async (entries, [extraKey, extraValue]) => {
        const kv = new MemoryKV()
        for (const [k, v] of entries) await kv.set(k, v)
        const snapshot = kv.snapshot()
        const copy = MemoryKV.fromSnapshot(snapshot)
        expect(copy.snapshot()).toEqual(snapshot)
        await copy.set(extraKey, extraValue)
        expect(kv.size).toBe(entries.length)
        kv.clear()
        expect(kv.size).toBe(0)
        kv.restore(snapshot)
        expect(kv.snapshot()).toEqual(snapshot)
      },
    ),
    params,
  )
})
