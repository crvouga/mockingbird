import { expect, test } from "bun:test"
import {
  compareKeys,
  type KeyValueEntry,
  type KeyValueStore,
  type ListOptions,
} from "@crvouga/mockingbird-kv"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { keyValueStoreProperties } from "./src/index.js"

type Bug = "ignore-prefix" | "insertion-order" | "drop-empty-values" | "alias-buffer" | "no-delete"

class BuggyKV implements KeyValueStore {
  private readonly entries = new Map<string, Uint8Array>()
  constructor(private readonly bug: Bug | undefined) {}
  async get(key: string) {
    return this.entries.get(key)
  }
  async set(key: string, value: Uint8Array) {
    if (this.bug === "drop-empty-values" && value.byteLength === 0) return
    this.entries.set(key, this.bug === "alias-buffer" ? value : value.slice())
  }
  async delete(key: string) {
    if (this.bug === "no-delete") return
    this.entries.delete(key)
  }
  async *list(options: ListOptions = {}): AsyncIterable<KeyValueEntry> {
    const prefix = this.bug === "ignore-prefix" ? "" : (options.prefix ?? "")
    const keys = [...this.entries.keys()].filter((k) => k.startsWith(prefix))
    if (this.bug !== "insertion-order") keys.sort(compareKeys)
    for (const key of keys) {
      const value = this.entries.get(key)
      if (value) yield { key, value }
    }
  }
}

const params = fcParameters(process.env)

test("a correct store passes the suite", async () => {
  await keyValueStoreProperties({ create: () => new BuggyKV(undefined), ...params })
})

test("every injected bug is detected by the suite", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom<Bug>(
        "ignore-prefix",
        "insertion-order",
        "drop-empty-values",
        "alias-buffer",
        "no-delete",
      ),
      fc.nat(),
      async (bug, seed) => {
        let failed = false
        try {
          await keyValueStoreProperties({ create: () => new BuggyKV(bug), seed, numRuns: 200 })
        } catch {
          failed = true
        }
        expect(failed).toBe(true)
      },
    ),
    { ...params, numRuns: 5 },
  )
})
