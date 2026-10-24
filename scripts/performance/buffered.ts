import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { root, seed } from "./engines.ts"
import type { Backend, Database, Durable, Engine, Fixture, Workload } from "./types.ts"

const scheduler = { schedule: () => 0, cancel: () => {} }
function check(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`Buffered workload: ${actual} !== ${expected}`)
}

async function fixture(
  engine: Engine,
  rows: number,
  kind: string,
  canary: boolean,
): Promise<Fixture> {
  const module = engine.module
  if (!module) throw new Error("Missing SQL module")
  const buffered = module.openBufferedDurableDatabase
  if (kind !== "legacy-sparse-flush" && !buffered)
    throw new Error("Missing buffered durability API")
  const url = pathToFileURL(Bun.resolveSync("fake-indexeddb", join(root, "packages/core"))).href
  const { IDBFactory } = (await import(url)) as { IDBFactory: new () => object }
  const storage = new module.IndexedDBDurabilityBackend({
    indexedDB: new IDBFactory(),
    name: "buffered-performance",
    durability: "relaxed",
  })
  let serializing = false
  let started = 0
  let captureAndQueueMs = 0
  let sqlMs = 0
  let flushMs = 0
  let commitMs = 0
  let pages = 0
  let bytes = 0
  let commits = 0
  const backend: Backend = {
    load: (key) => storage.load(key),
    async commit(key, revision, patch) {
      if (started) {
        captureAndQueueMs += performance.now() - started
        pages += patch.pages.length
        bytes += patch.pages.reduce((n, page) => n + page.bytes.length, 0)
        commits++
      }
      serializing = false
      const before = performance.now()
      const result = await storage.commit(key, revision, patch)
      if (started) commitMs += performance.now() - before
      return result
    },
  }
  const open = () => {
    if (kind === "legacy-sparse-flush") return module.openDurableDatabase({ key: "t", backend })
    if (!buffered) throw new Error("Missing buffered durability API")
    return buffered({ key: "t", backend, scheduler })
  }
  let handle: Durable<Database> | undefined
  const encode = module.Snapshot.prototype.encode
  let fullSnapshotEncodes = 0
  let visitedRows = 0
  const restore: (() => void)[] = []
  try {
    handle = await open()
    const current = handle
    const db = seed(engine, rows, current.value)
    await handle.flush()
    const update = db.prepare(`UPDATE t SET value = value + 1 WHERE id = ${engine.parameter}`)
    // Warm COW conversion and lazy index construction outside timing/work counts.
    db.transaction(() => update.run(rows - 1))
    await handle.flush()
    if (canary && kind !== "legacy-sparse-flush") void db.state
    const state = (db.engineState ?? db.state) as {
      getTable(name: string): object
      findTable(name: string[]): object
    }
    const target = engine.name === "sqlite" ? state.getTable("t") : state.findTable(["t"])
    const prototype = Object.getPrototypeOf(target) as Record<string, unknown>
    for (const name of engine.name === "sqlite"
      ? ["sortedRows"]
      : ["serializationRows", "allRows"]) {
      const original = prototype[name] as ((this: { rowCount(): number }) => unknown) | undefined
      if (!original) continue
      prototype[name] = function (this: { rowCount(): number }) {
        if (serializing) visitedRows += this.rowCount()
        return original.call(this)
      }
      restore.push(() => {
        prototype[name] = original
      })
    }
    module.Snapshot.prototype.encode = function () {
      if (serializing) fullSnapshotEncodes++
      return encode.call(this)
    }
    let runs = 0
    const count =
      kind === "enqueue" || kind === "coalesced-flush" ? 1000 : kind === "batch-flush" ? 100 : 1
    const reopening = kind === "reopen-read-close"
    if (reopening) await handle.close()
    const expected = () => {
      if (reopening) return 0
      return kind === "coalesced-flush" || kind === "sparse-flush" || kind === "legacy-sparse-flush"
        ? count * runs
        : runs
    }
    return {
      async run() {
        if (reopening) {
          const fresh = await open()
          check(
            Number(
              fresh.value
                .prepare(`SELECT value FROM t WHERE id = ${engine.parameter}`)
                .get<{ value: number }>(0)?.value,
            ),
            0,
          )
          await fresh.close()
        } else {
          const begin = performance.now()
          db.transaction(() => {
            for (let i = 0; i < count; i++) update.run(kind === "coalesced-flush" ? 0 : i)
          })
          sqlMs += performance.now() - begin
          if (kind !== "enqueue") {
            started = performance.now()
            serializing = true
            await current.flush()
            flushMs += performance.now() - started
            started = 0
            serializing = false
          }
        }
        runs++
      },
      async verify() {
        if (kind === "enqueue") {
          check(commits, 0)
          check(fullSnapshotEncodes, 0)
        } else if (!reopening) check(commits, runs)
        if (!reopening) await current.close()
        const reopened = await module.openDurableDatabase({ key: "t", backend })
        try {
          const actual = reopened.value.query<{ id: number; value: number }>(
            "SELECT id, value FROM t ORDER BY id",
          )
          check(actual.length, rows)
          for (let i = 0; i < actual.length; i++) {
            check(Number(actual[i]?.id), i)
            const touched =
              kind === "enqueue" ? i < 1000 : kind === "batch-flush" ? i < 100 : i === 0
            check(
              Number(actual[i]?.value),
              (i === rows - 1 ? 1 : 0) + (reopening ? 0 : touched ? expected() : 0),
            )
          }
        } finally {
          await reopened.close()
        }
      },
      async close() {
        try {
          await current.close()
        } finally {
          module.Snapshot.prototype.encode = encode
          for (const reset of restore) reset()
          db.close()
          await storage.close()
        }
      },
      details: () => ({
        rows,
        fullSnapshotEncodes,
        serializedRowVisits: visitedRows,
        serializedRowVisitsPerBatch: visitedRows / Math.max(runs, 1),
        bytesPerBatch: bytes / Math.max(runs, 1),
        pagesPerBatch: pages / Math.max(runs, 1),
        commits,
        captureAndQueueMsPerBatch: captureAndQueueMs / Math.max(runs, 1),
        sqlMsPerBatch: sqlMs / Math.max(runs, 1),
        flushMsPerBatch: flushMs / Math.max(runs, 1),
        commitMsPerBatch: commitMs / Math.max(runs, 1),
      }),
    }
  } catch (error) {
    module.Snapshot.prototype.encode = encode
    for (const reset of restore) reset()
    handle?.value.close()
    await storage.close()
    throw error
  }
}

/** Acknowledged IO and enqueue throughput have distinct workloads and labels. */
export function bufferedWorkloads(engines: Engine[], rows = 100_000, canary = false): Workload[] {
  return engines
    .filter((engine) => engine.module)
    .flatMap((engine) =>
      [
        "legacy-sparse-flush",
        "sparse-flush",
        "batch-flush",
        "coalesced-flush",
        "enqueue",
        "reopen-read-close",
      ].map((kind) => ({
        name: `${engine.name}/buffered/${kind}/${rows}`,
        operations:
          kind === "enqueue" || kind === "coalesced-flush"
            ? 1000
            : kind === "batch-flush"
              ? 100
              : 1,
        setup: () => fixture(engine, rows, kind, canary),
      })),
    )
}
