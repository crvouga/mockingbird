import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { root, seed } from "./engines.ts"
import type { Backend, Database, Engine, Fixture, SQLModule, Workload } from "./types.ts"

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`${message}: ${actual} !== ${expected}`)
}

function verifyRows(db: Database, rows: number, updates: number): void {
  const actual = db.query<{ id: number; value: number }>("SELECT id, value FROM t")
  equal(actual.length, rows, "lost rows")
  const ids = new Set<number>()
  for (const row of actual) {
    const id = Number(row.id)
    if (!Number.isInteger(id) || id < 0 || id >= rows || ids.has(id))
      throw new Error(`Incorrect or duplicate row id: ${id}`)
    ids.add(id)
    equal(Number(row.value), id < 100 ? updates : 0, `incorrect value at row ${id}`)
  }
}

function updateFixture(
  engine: Engine,
  rows: number,
  transaction: boolean,
  canary = false,
): Fixture {
  const db = seed(engine, rows)
  const update = db.prepare(
    `UPDATE t SET value = value + 1 WHERE ${canary ? "(id + 0)" : "id"} = ${engine.parameter}`,
  )
  let runs = 0
  const batch = () => {
    for (let i = 0; i < 100; i++) update.run(i)
  }
  return {
    run: () => {
      transaction ? db.transaction(batch) : batch()
      runs++
    },
    verify: () => verifyRows(db, rows, runs),
    close: () => db.close(),
  }
}

/** Count candidate tuple reads separately from timing. No instrumentation ships in the engine. */
async function updateProbe(
  engine: Engine,
  rows: number,
  canary = false,
): Promise<Record<string, number>> {
  const db = seed(engine, rows)
  const table = (db.state as { findTable(name: string[]): object }).findTable(["t"])
  const originalRows = (table as { rows: unknown[][] }).rows
  type Table = {
    mutableRows(): unknown[][]
    rowAt(index: number): unknown[]
    rowCount(): number
    cloneForWrite(): Table
  }
  const prototype = Object.getPrototypeOf(table) as Table
  const mutableRows = prototype.mutableRows
  const rowAt = prototype.rowAt
  const cloneForWrite = prototype.cloneForWrite
  let visits = 0
  let copied = 0
  prototype.cloneForWrite = function () {
    copied += this.rowCount()
    return cloneForWrite.call(this)
  }
  prototype.mutableRows = function () {
    return new Proxy(mutableRows.call(this), {
      get(target, key, receiver) {
        if (typeof key === "string" && key !== "" && Number.isInteger(Number(key))) visits++
        return Reflect.get(target, key, receiver)
      },
    })
  }
  prototype.rowAt = function (index) {
    visits++
    return rowAt.call(this, index)
  }
  try {
    const update = db.prepare(
      `UPDATE t SET value = value + 1 WHERE ${canary ? "(id + 0)" : "id"} = $1`,
    )
    db.transaction(() => {
      for (let i = 0; i < 100; i++) update.run(i)
    })
    const currentRows = (
      db.state as { findTable(name: string[]): { rows: unknown[][] } }
    ).findTable(["t"]).rows
    let copiedUntouchedRows = 0
    for (let index = 100; index < rows; index++)
      if (originalRows[index] !== currentRows[index]) copiedUntouchedRows++
    return {
      candidateRowVisits: visits,
      candidateRowVisitBudget: 400,
      deepCopiedRows: copied,
      deepCopiedRowBudget: 0,
      copiedUntouchedRows,
    }
  } finally {
    prototype.mutableRows = mutableRows
    prototype.rowAt = rowAt
    prototype.cloneForWrite = cloneForWrite
    db.close()
  }
}

async function collectionWriteProbe(
  engine: Engine,
  insert = false,
): Promise<Record<string, number>> {
  const url = pathToFileURL(join(root, "packages/service/core/src/collection.ts")).href
  const { Collection } = (await import(url)) as {
    Collection: new (
      db: Database,
      namespace: string,
      name: string,
    ) => {
      insert(id: string, value: object): void
      update(id: string, value: object): unknown
    }
  }
  const schema = pathToFileURL(join(root, "packages/sqlite/src/schema.ts")).href
  const { migrateCore } = (await import(schema)) as { migrateCore(db: Database): void }
  const db = engine.create()
  migrateCore(db)
  const collection = new Collection(db, "performance", "records")
  for (let i = 0; i < 1000; i++) collection.insert(String(i), { value: 0 })
  const tables = (db.state as { tables: Map<string, { columns: object; constraints: object }> })
    .tables
  const schemas = [...tables].map(([name, table]) => ({
    name,
    columns: table.columns,
    constraints: table.constraints,
  }))
  const indexes = (db.state as { indexes: Map<string, { columns: object; where: unknown }> })
    .indexes
  const indexSchemas = [...indexes].map(([name, index]) => ({
    name,
    columns: index.columns,
    where: index.where,
  }))
  const first = (db.state as { indexes: Map<string, { store: object }> }).indexes
    .values()
    .next().value
  if (!first) throw new Error("No collection index available for the work-count probe")
  const prototype = Object.getPrototypeOf(first.store) as { clone(): unknown }
  const original = prototype.clone
  let forks = 0
  prototype.clone = function () {
    forks++
    return original.call(this)
  }
  try {
    for (let i = 0; i < 100; i++)
      if (insert) collection.insert(String(i + 1000), { value: 1 })
      else collection.update(String(i), { value: 1 })
    let schemaCopies = 0
    for (const schema of schemas) {
      const current = (db.state as { tables: typeof tables }).tables.get(schema.name)
      if (current?.columns !== schema.columns || current.constraints !== schema.constraints)
        schemaCopies++
    }
    let indexSchemaCopies = 0
    for (const schema of indexSchemas) {
      const current = (db.state as { indexes: typeof indexes }).indexes.get(schema.name)
      if (current?.columns !== schema.columns || current.where !== schema.where) indexSchemaCopies++
    }
    return {
      ...(insert ? { indexForks: forks } : { unchangedIndexForks: forks }),
      schemaCopies,
      indexSchemaCopies,
    }
  } finally {
    prototype.clone = original
    db.close()
  }
}

async function readProbe(engine: Engine, rows: number): Promise<Record<string, number>> {
  const db = seed(engine, rows)
  const table = (db.state as { findTable(name: string[]): { rows: unknown[][] } }).findTable(["t"])
  const original = table.rows
  let visits = 0
  table.rows = new Proxy(original, {
    get(target, key, receiver) {
      if (typeof key === "string" && key !== "" && Number.isInteger(Number(key))) visits++
      return Reflect.get(target, key, receiver)
    },
  })
  try {
    const read = db.prepare("SELECT value FROM t WHERE id = $1")
    for (let i = 0; i < 100; i++)
      equal(read.get<{ value: number }>(i)?.value, 0, "incorrect probed read")
    return { candidateRowVisits: visits, candidateRowVisitBudget: 400 }
  } finally {
    table.rows = original
    db.close()
  }
}

async function durableFixture(engine: Engine, rows: number, indexedDB: boolean): Promise<Fixture> {
  const module = engine.module as SQLModule
  let backend: Backend
  let closeBackend = async () => {}
  if (indexedDB) {
    const url = pathToFileURL(Bun.resolveSync("fake-indexeddb", join(root, "packages/core"))).href
    const { IDBFactory } = (await import(url)) as { IDBFactory: new () => object }
    const idb = new module.IndexedDBDurabilityBackend({
      indexedDB: new IDBFactory(),
      name: "performance",
    })
    backend = idb
    closeBackend = () => idb.close()
  } else backend = new module.MemoryDurabilityBackend()
  let commits = 0
  let pages = 0
  let bytes = 0
  let commitMs = 0
  let encodeMs = 0
  let sqlMs = 0
  let flushMs = 0
  let runs = 0
  const original = module.Snapshot.prototype.encode
  module.Snapshot.prototype.encode = function () {
    const start = performance.now()
    try {
      return original.call(this)
    } finally {
      encodeMs += performance.now() - start
    }
  }
  const observed: Backend = {
    load: (key) => backend.load(key),
    async commit(key, revision, patch) {
      const start = performance.now()
      const result = await backend.commit(key, revision, patch)
      commitMs += performance.now() - start
      commits++
      pages += patch.pages.length
      for (const page of patch.pages) bytes += page.bytes.length
      return result
    },
  }
  try {
    const handle = await module.openDurableDatabase({ key: "database", backend: observed })
    const db = seed(engine, rows, handle.value)
    await handle.flush()
    commits = pages = bytes = commitMs = encodeMs = 0
    const update = db.prepare(`UPDATE t SET value = value + 1 WHERE id = ${engine.parameter}`)
    return {
      async run() {
        const start = performance.now()
        db.transaction(() => {
          for (let i = 0; i < 100; i++) update.run(i)
        })
        const saved = performance.now()
        sqlMs += saved - start
        await handle.flush()
        flushMs += performance.now() - saved
        runs++
      },
      async verify() {
        equal(commits, runs, "one commit per changed batch")
        const image = await backend.load("database")
        if (!image) throw new Error("missing durable image")
        const reopened = module.Snapshot.decode(image.bytes).open()
        try {
          verifyRows(reopened, rows, runs)
        } finally {
          reopened.close()
        }
      },
      async close() {
        module.Snapshot.prototype.encode = original
        db.close()
        await closeBackend()
      },
      details: () => ({
        sqlMsPerBatch: sqlMs / runs,
        flushMsPerBatch: flushMs / runs,
        encodeMsPerBatch: encodeMs / runs,
        commitMsPerBatch: commitMs / runs,
        pagesPerBatch: pages / runs,
        bytesPerBatch: bytes / runs,
        commits,
        expectedCommits: runs,
      }),
    }
  } catch (error) {
    module.Snapshot.prototype.encode = original
    await closeBackend()
    throw error
  }
}

async function binaryFixture(module: SQLModule, probeCopies = false): Promise<Fixture> {
  let encodedCopyBytes = 0
  class ObservedBytes extends Uint8Array {
    constructor(lengthOrBuffer: number | ArrayBuffer, byteOffset?: number, length?: number) {
      if (typeof lengthOrBuffer === "number") {
        super(lengthOrBuffer)
        encodedCopyBytes += lengthOrBuffer
      } else super(lengthOrBuffer, byteOffset, length)
    }
  }
  const bytes = new (probeCopies ? ObservedBytes : Uint8Array)(8 * 1024 * 1024).fill(7)
  const memory = new module.MemoryDurabilityBackend()
  let pages = 0
  let commits = 0
  const backend: Backend = {
    load: (key) => memory.load(key),
    commit(key, revision, patch) {
      pages += patch.pages.length
      commits++
      return memory.commit(key, revision, patch)
    },
  }
  const handle = await module.openDurable({
    key: "binary",
    backend,
    codec: {
      create: () => ({ bytes }),
      decode: (data) => ({ bytes: data }),
      encode: (value) => value.bytes,
    },
  })
  await handle.flush()
  pages = commits = encodedCopyBytes = 0
  let runs = 0
  return {
    async run() {
      bytes[bytes.length - 17] = (bytes[bytes.length - 17] ?? 0) + 1
      await handle.flush()
      runs++
    },
    async verify() {
      equal(pages, runs, "one changed page per sparse write")
      equal(commits, runs, "one atomic commit per sparse write")
      equal(
        (await backend.load("binary"))?.bytes[bytes.length - 17],
        bytes[bytes.length - 17],
        "lost sparse byte",
      )
    },
    close: () => handle.close(),
    details: () => ({
      pagesPerBatch: pages / runs,
      bytesPerBatch: (pages * 16_384) / runs,
      imageBytes: bytes.length,
      ...(probeCopies ? { encodedCopyBytes } : {}),
    }),
  }
}

function snapshotFixture(engine: Engine, text: boolean): Fixture {
  const db = engine.create()
  const module = engine.module as SQLModule
  if (text) {
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT, repeated TEXT)")
    const insert = db.prepare(
      `INSERT INTO t VALUES (${engine.parameter}, ${engine.name === "postgres" ? "$2, $3" : "?, ?"})`,
    )
    db.transaction(() => {
      for (let i = 0; i < 10000; i++)
        insert.run(
          i,
          i % 13 === 0 ? null : `row ${i}: café 🐦 ${"x".repeat(80)}`,
          `group ${i % 64}`,
        )
    })
  } else seed(engine, 10000, db)
  let bytes: Uint8Array | undefined
  return {
    run() {
      if (!db.snapshot) throw new Error("Missing snapshot API")
      // Each capture is new: do not time Snapshot.encode's cached-buffer shortcut.
      for (let i = 0; i < 10; i++) bytes = db.snapshot().encode()
    },
    verify() {
      if (!bytes) throw new Error("Snapshot was not encoded")
      const reopened = module.Snapshot.decode(bytes).open()
      try {
        if (!text) verifyRows(reopened, 10000, 0)
        else {
          const actual = reopened.query<{ id: number; value: string | null; repeated: string }>(
            "SELECT id, value, repeated FROM t ORDER BY id",
          )
          equal(actual.length, 10000, "lost text snapshot rows")
          for (let i = 0; i < actual.length; i++) {
            equal(Number(actual[i]?.id), i, "incorrect snapshot id")
            equal(
              actual[i]?.value,
              i % 13 === 0 ? null : `row ${i}: café 🐦 ${"x".repeat(80)}`,
              "incorrect snapshot text",
            )
            equal(actual[i]?.repeated, `group ${i % 64}`, "incorrect interned text")
          }
        }
      } finally {
        reopened.close()
      }
    },
    close: () => db.close(),
    details: () => ({ imageBytes: bytes?.length ?? 0, snapshotsPerBatch: 10 }),
  }
}

async function denseIndexedDBFixture(module: SQLModule, probe = false): Promise<Fixture> {
  const url = pathToFileURL(Bun.resolveSync("fake-indexeddb", join(root, "packages/core"))).href
  const { IDBFactory, IDBObjectStore } = (await import(url)) as {
    IDBFactory: new () => object
    IDBObjectStore: {
      prototype: { name: string; put(value: unknown, key?: unknown): unknown }
    }
  }
  const backend = new module.IndexedDBDurabilityBackend({
    indexedDB: new IDBFactory(),
    name: "dense-performance",
  })
  const bytes = new Uint8Array(1024 * 1024)
  const handle = await module.openDurable({
    key: "dense",
    backend,
    codec: { create: () => bytes, decode: (value) => value, encode: (value) => value },
  })
  await handle.flush()
  let runs = 0
  let clonedBackingBytes = 0
  let pageWrites = 0
  const put = IDBObjectStore.prototype.put
  if (probe)
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === "pages") {
        const record = value as { bytes: Uint8Array }
        clonedBackingBytes += record.bytes.buffer.byteLength
        pageWrites++
      }
      return put.call(this, value, key)
    }
  return {
    async run() {
      bytes.fill(++runs % 251)
      await handle.flush()
    },
    async verify() {
      const saved = await backend.load("dense")
      equal(saved?.bytes.length, bytes.length, "lost dense image")
      if (!saved?.bytes.every((byte) => byte === runs % 251))
        throw new Error("Incorrect dense IndexedDB image")
    },
    async close() {
      try {
        await handle.close()
      } finally {
        IDBObjectStore.prototype.put = put
        await backend.close()
      }
    },
    details: () => ({
      imageBytes: bytes.length,
      ...(probe ? { clonedBackingBytes, pageWrites } : {}),
    }),
  }
}

export function workloads(engines: Engine[], canary = false): Workload[] {
  const cases: Workload[] = []
  for (const engine of engines) {
    for (const rows of [1000, 10000]) {
      const read: Workload = {
        name: `${engine.name}/point-read/${rows}`,
        operations: 5000,
        setup() {
          const db = seed(engine, rows)
          const read = db.prepare(`SELECT value FROM t WHERE id = ${engine.parameter}`)
          return {
            run: () => {
              for (let i = 0; i < 5000; i++)
                equal(read.get<{ value: number }>(i % rows)?.value, 0, "incorrect point read")
            },
            verify: () => {},
            close: () => db.close(),
          }
        },
      }
      if (engine.name === "postgres") read.probe = () => readProbe(engine, rows)
      cases.push(read)
      const update: Workload = {
        name: `${engine.name}/update-batch/${rows}`,
        operations: 100,
        setup: () => updateFixture(engine, rows, true, canary),
      }
      if (engine.name === "postgres") update.probe = () => updateProbe(engine, rows, canary)
      cases.push(update)
      if (engine.module)
        cases.push({
          name: `${engine.name}/durable-memory/${rows}`,
          operations: 100,
          setup: () => durableFixture(engine, rows, false),
        })
    }
    cases.push({
      name: `${engine.name}/update-autocommit/1000`,
      operations: 100,
      setup: () => updateFixture(engine, 1000, false),
    })
    cases.push({
      name: `${engine.name}/insert/1000`,
      operations: 1000,
      isolate: true,
      setup() {
        const db = seed(engine, 0)
        const insert = db.prepare(
          `INSERT INTO t VALUES (${engine.parameter}, ${engine.name === "postgres" ? "$2" : "?"})`,
        )
        return {
          run: () =>
            db.transaction(() => {
              for (let i = 0; i < 1000; i++) insert.run(i, 0)
            }),
          verify: () => verifyRows(db, 1000, 0),
          close: () => db.close(),
        }
      },
    })
    if (engine.module)
      cases.push(
        {
          name: `${engine.name}/durable-indexeddb-emulated/1000`,
          operations: 100,
          setup: () => durableFixture(engine, 1000, true),
        },
        ...[false, true].map((text) => ({
          name: `${engine.name}/snapshot-${text ? "text" : "numeric"}/10000`,
          operations: 100000,
          setup: () => snapshotFixture(engine, text),
        })),
      )
  }
  const sqlite = engines.find((engine) => engine.name === "sqlite")
  if (sqlite?.module) {
    const module = sqlite.module
    cases.push({
      name: "durability/sparse-8MiB",
      operations: 1,
      setup: () => binaryFixture(module),
      async probe() {
        const fixture = await binaryFixture(module, true)
        try {
          await fixture.run()
          await fixture.verify()
          return fixture.details?.() ?? {}
        } finally {
          await fixture.close()
        }
      },
    })
    cases.push({
      name: "durability/dense-indexeddb-emulated-1MiB",
      operations: 1,
      setup: () => denseIndexedDBFixture(module),
      async probe() {
        const fixture = await denseIndexedDBFixture(module, true)
        try {
          await fixture.run()
          await fixture.verify()
          return fixture.details?.() ?? {}
        } finally {
          await fixture.close()
        }
      },
    })
    cases.push({
      name: "collection/point-read/1000",
      operations: 5000,
      async setup() {
        const url = pathToFileURL(join(root, "packages/service/core/src/collection.ts")).href
        const { Collection } = (await import(url)) as {
          Collection: new (
            db: Database,
            namespace: string,
            name: string,
          ) => { insert(id: string, value: object): void; get(id: string): { value: number } }
        }
        const schema = pathToFileURL(join(root, "packages/sqlite/src/schema.ts")).href
        const { migrateCore } = (await import(schema)) as { migrateCore(db: Database): void }
        const db = sqlite.create()
        migrateCore(db)
        const collection = new Collection(db, "performance", "records")
        db.transaction(() => {
          for (let i = 0; i < 1000; i++) collection.insert(String(i), { value: i })
        })
        return {
          run: () => {
            for (let i = 0; i < 5000; i++)
              equal(collection.get(String(i % 1000)).value, i % 1000, "incorrect collection read")
          },
          verify: () => {},
          close: () => db.close(),
        }
      },
    })
    for (const write of ["update-batch", "insert"]) {
      const workload: Workload = {
        name: `collection/${write}/1000`,
        operations: write === "insert" ? 1000 : 100,
        isolate: write === "insert",
        async setup() {
          const url = pathToFileURL(join(root, "packages/service/core/src/collection.ts")).href
          const { Collection } = (await import(url)) as {
            Collection: new (
              db: Database,
              namespace: string,
              name: string,
            ) => {
              insert(id: string, value: object): void
              update(id: string, value: object): unknown
              get(id: string): { value: number }
              count(): number
            }
          }
          const schema = pathToFileURL(join(root, "packages/sqlite/src/schema.ts")).href
          const { migrateCore } = (await import(schema)) as { migrateCore(db: Database): void }
          const db = sqlite.create()
          migrateCore(db)
          const collection = new Collection(db, "performance", "records")
          if (write === "update-batch")
            for (let i = 0; i < 1000; i++) collection.insert(String(i), { value: 0 })
          let runs = 0
          return {
            run() {
              runs++
              if (write === "insert")
                for (let i = 0; i < 1000; i++) collection.insert(String(i), { value: i })
              else for (let i = 0; i < 100; i++) collection.update(String(i), { value: runs })
            },
            verify() {
              equal(collection.count(), 1000, "lost collection write")
              for (let i = 0; i < 1000; i++)
                equal(
                  collection.get(String(i)).value,
                  write === "insert" ? i : i < 100 ? runs : 0,
                  `incorrect collection value at ${i}`,
                )
            },
            close: () => db.close(),
          }
        },
      }
      workload.probe = () => collectionWriteProbe(sqlite, write === "insert")
      cases.push(workload)
    }
  }
  return cases
}
