import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { root, seed } from "./engines.ts"
import type { Database, Engine, Fixture, Workload } from "./types.ts"

const rows = 100_000
const batch = 100

function check(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`Production workload: ${actual} !== ${expected}`)
}

function verify(db: Database, runs: number, indexed: boolean): void {
  const actual = db.query<{ id: number; value: number }>("SELECT id, value FROM t ORDER BY id")
  check(actual.length, rows)
  for (let i = 0; i < rows; i++) {
    check(Number(actual[i]?.id), i)
    check(
      Number(actual[i]?.value),
      indexed ? i + (i < batch ? runs * rows : 0) : i < batch ? runs : 0,
    )
  }
}

function writes(engine: Engine, perWrite: boolean, indexed: boolean, rollback = false): Fixture {
  const db = seed(engine, rows)
  if (indexed) {
    db.exec("UPDATE t SET value = id")
    db.exec("CREATE UNIQUE INDEX t_value ON t(value)")
  }
  const update = db.prepare(
    `UPDATE t SET value = value + ${indexed ? rows : 1} WHERE id = ${engine.parameter}`,
  )
  let runs = 0
  const one = (i: number) => update.run(i)
  return {
    run() {
      const apply = () => {
        for (let i = 0; i < batch; i++) perWrite ? db.transaction(() => one(i)) : one(i)
      }
      if (rollback) {
        db.exec("BEGIN")
        apply()
        db.exec("SAVEPOINT nested")
        one(rows - 1)
        db.exec("ROLLBACK TO nested; RELEASE nested; ROLLBACK")
      } else {
        if (perWrite) apply()
        else db.transaction(apply)
        runs++
      }
    },
    verify() {
      verify(db, runs, indexed)
      if (indexed) {
        const lookup = db.prepare(`SELECT id FROM t WHERE value = ${engine.parameter}`)
        for (let i = 0; i < batch; i++) {
          check(Number(lookup.get<{ id: number }>(i + runs * rows)?.id), i)
          if (runs) check(lookup.get(i), undefined)
        }
      }
    },
    close: () => db.close(),
  }
}

async function durable(engine: Engine): Promise<Fixture> {
  const module = engine.module
  if (!module) throw new Error("Missing durability adapter")
  const url = pathToFileURL(Bun.resolveSync("fake-indexeddb", join(root, "packages/core"))).href
  const { IDBFactory } = (await import(url)) as { IDBFactory: new () => object }
  const backend = new module.IndexedDBDurabilityBackend({
    indexedDB: new IDBFactory(),
    name: "production-performance",
  })
  let handle = await module.openDurableDatabase({ key: "production", backend })
  const db = seed(engine, rows, handle.value)
  await handle.flush()
  const update = db.prepare(`UPDATE t SET value = value + 1 WHERE id = ${engine.parameter}`)
  let runs = 0
  return {
    async run() {
      db.transaction(() => {
        for (let i = 0; i < batch; i++) update.run(i)
      })
      await handle.flush()
      runs++
    },
    async verify() {
      await handle.close()
      handle = await module.openDurableDatabase({ key: "production", backend })
      verify(handle.value, runs, false)
    },
    async close() {
      await handle.close()
      await backend.close()
    },
  }
}

/** Count row references and hash entries copied, separately from wall-clock samples. */
async function writeProbe(engine: Engine): Promise<Record<string, number>> {
  const db = seed(engine, rows)
  const update = db.prepare(`UPDATE t SET value = value + 1 WHERE id = ${engine.parameter}`)
  // Pay one-time promotion/index construction before measuring steady-state work.
  db.transaction(() => update.run(rows - 1))
  type StorageMap = Map<unknown, unknown>
  type Table = {
    rowStore?: StorageMap
    rows?: StorageMap
    indexStores?: Map<string, { entries: StorageMap }>
    rowCount(): number
    cloneForDml(): Table
    materializedRows?(): unknown[][]
  }
  const state = db.state as { getTable(name: string): Table; findTable(name: string[]): Table }
  const table = engine.name === "sqlite" ? state.getTable("t") : state.findTable(["t"])
  const map =
    engine.name === "sqlite"
      ? (table.rowStore ?? table.rows)
      : table.indexStores?.values().next().value?.entries
  if (!map) throw new Error("Missing map for copy-work probe")
  const mapPrototype = Object.getPrototypeOf(map) as {
    copyBucket?(bucket: StorageMap): StorageMap
  }
  const tablePrototype = Object.getPrototypeOf(table) as Table
  const copyBucket = mapPrototype.copyBucket
  const clone = tablePrototype.cloneForDml
  const materialize = tablePrototype.materializedRows
  let copiedHashEntries = 0
  let copiedRowReferences = 0
  if (copyBucket)
    mapPrototype.copyBucket = function (bucket) {
      copiedHashEntries += bucket.size
      return copyBucket.call(this, bucket)
    }
  tablePrototype.cloneForDml = function () {
    if (engine.name === "sqlite") {
      if (!this.rowStore || this.rowStore instanceof Map) copiedRowReferences += this.rowCount()
    } else if (!materialize) copiedRowReferences += this.rowCount()
    return clone.call(this)
  }
  if (materialize)
    tablePrototype.materializedRows = function () {
      copiedRowReferences += this.rowCount()
      return materialize.call(this)
    }
  try {
    for (let i = 0; i < batch; i++) db.transaction(() => update.run(i))
    return { copiedHashEntries, copiedRowReferences }
  } finally {
    tablePrototype.cloneForDml = clone
    if (materialize) tablePrototype.materializedRows = materialize
    if (copyBucket) mapPrototype.copyBucket = copyBucket
    db.close()
  }
}

async function rangeProbe(engine: Engine): Promise<Record<string, number>> {
  const db = seed(engine, rows)
  db.exec("CREATE INDEX t_id ON t(id)")
  const read = db.prepare(
    `SELECT id FROM t WHERE id >= ${engine.parameter} AND id < ${engine.name === "postgres" ? "$2" : "?"} ORDER BY id`,
  )
  read.get(100, 132)
  type Table = {
    rows: unknown[][]
    get?(key: unknown): unknown
    rowAt?(index: number): unknown
    scan?(): Iterable<unknown>
  }
  const state = db.state as { getTable(name: string): Table; findTable(name: string[]): Table }
  const table = engine.name === "sqlite" ? state.getTable("t") : state.findTable(["t"])
  const prototype = Object.getPrototypeOf(table) as Table
  const get = prototype.get
  const rowAt = prototype.rowAt
  const scan = prototype.scan
  let candidateRowVisits = 0
  if (get)
    prototype.get = function (key) {
      candidateRowVisits++
      return get.call(this, key)
    }
  if (rowAt)
    prototype.rowAt = function (index) {
      candidateRowVisits++
      return rowAt.call(this, index)
    }
  if (scan)
    prototype.scan = function* () {
      for (const row of scan.call(this)) {
        candidateRowVisits++
        yield row
      }
    }
  if (engine.name === "postgres")
    table.rows = new Proxy(table.rows, {
      get(target, key, receiver) {
        if (typeof key === "string" && key !== "" && Number.isInteger(Number(key)))
          candidateRowVisits++
        return Reflect.get(target, key, receiver)
      },
    })
  try {
    for (let i = 0; i < 10; i++) {
      const start = (i * 7919) % (rows - 32)
      check(Number(read.get<{ id: number }>(start, start + 32)?.id), start)
    }
    return { candidateRowVisits }
  } finally {
    if (get) prototype.get = get
    if (rowAt) prototype.rowAt = rowAt
    if (scan) prototype.scan = scan
    db.close()
  }
}

/** Large-table transactions, recovery and reads; fixture setup/verification is never timed. */
export function productionWorkloads(engines: Engine[]): Workload[] {
  return engines.flatMap((engine) => {
    const cases: Workload[] = [
      ...[
        ["transaction-per-write", true, false, false],
        ["indexed-transaction-per-write", true, true, false],
        ["update-batch", false, true, false],
        ["rollback", false, true, true],
      ].map(([name, perWrite, indexed, rollback]) => ({
        name: `${engine.name}/production/${name}/${rows}`,
        operations: batch,
        setup: () => writes(engine, Boolean(perWrite), Boolean(indexed), Boolean(rollback)),
      })),
      {
        name: `${engine.name}/production/point-read/${rows}`,
        operations: 5000,
        setup() {
          const db = seed(engine, rows)
          const read = db.prepare(`SELECT value FROM t WHERE id = ${engine.parameter}`)
          return {
            run() {
              for (let i = 0; i < 5000; i++)
                check(read.get<{ value: number }>((i * 7919) % rows)?.value, 0)
            },
            verify() {},
            close: () => db.close(),
          }
        },
      },
      {
        name: `${engine.name}/production/range-read/${rows}`,
        operations: 10,
        setup() {
          const db = seed(engine, rows)
          db.exec("CREATE INDEX t_value ON t(id)")
          const read = db.prepare(
            `SELECT id FROM t WHERE id >= ${engine.parameter} AND id < ${engine.name === "postgres" ? "$2" : "?"} ORDER BY id`,
          )
          return {
            run() {
              // get() must preserve ORDER BY and stop after the first qualifying row.
              for (let i = 0; i < 10; i++) {
                const start = (i * 7919) % (rows - 32)
                check(Number(read.get<{ id: number }>(start, start + 32)?.id), start)
              }
            },
            verify() {},
            close: () => db.close(),
          }
        },
      },
    ]
    if (engine.module)
      cases.push({
        name: `${engine.name}/production/durable-indexeddb-emulated/${rows}`,
        operations: batch,
        setup: () => durable(engine),
      })
    if (engine.module) {
      const write = cases[0]
      if (write) write.probe = () => writeProbe(engine)
      const range = cases.find((workload) => workload.name.includes("/range-read/"))
      if (range) range.probe = () => rangeProbe(engine)
    }
    return cases
  })
}
