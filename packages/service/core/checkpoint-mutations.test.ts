/**
 * `checkpointMutations: false` stops the runtime recording a time-travel checkpoint after every
 * write. A checkpoint reads the whole namespace, so with it on a write costs more the more the
 * namespace holds; with it off a write reads nothing back, and time travel still works from the
 * checkpoints a caller takes.
 */
import { describe, expect, test } from "bun:test"
import { Database } from "@crvouga/mockingbird-service-sqlite"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { CHECKPOINT_HEADER, Collection, createRuntime, markMutationAccepted } from "./src/index.js"

/** A client that counts the stored records its statements return. */
const counting = () => {
  const db = new Database()
  let rowsRead = 0
  const client: SqliteClient = {
    exec: (sql) => db.exec(sql),
    transaction: (fn) => db.transaction(fn),
    prepare: (sql) => {
      const statement = db.prepare(sql)
      const reads = sql.includes("FROM mockingbird_records")
      return {
        run: (...params) => statement.run(...params),
        get: (...params) => {
          const row = statement.get(...params)
          if (reads && row !== undefined) rowsRead++
          return row as never
        },
        all: (...params) => {
          const rows = statement.all(...params)
          if (reads) rowsRead += rows.length
          return rows as never
        },
      }
    },
  }
  return { client, rowsRead: () => rowsRead }
}

const itemsRuntime = (options: { checkpointMutations?: boolean; sqlite?: SqliteClient } = {}) =>
  createRuntime({
    name: "checkpoint-mutations",
    ...options,
    create: ({ sqlite, namespace }) => {
      const items = new Collection<{ n: number }>(sqlite, namespace, "items")
      return {
        items,
        reset: async () => {},
        fetch: async (request: Request) => {
          const id = new URL(request.url).pathname.slice(1)
          items.insert(id, { n: 1 })
          markMutationAccepted(request, { ids: { id } })
          return new Response(null, { status: 201 })
        },
      }
    },
  })

const write = (runtime: ReturnType<typeof itemsRuntime>, id: string) =>
  runtime.fetch(new Request(`http://test.local/${id}`, { method: "POST" }))

describe("checkpointMutations", () => {
  test("by default every write records a checkpoint and names it", async () => {
    const runtime = itemsRuntime()
    const response = await write(runtime, "a")
    const id = response.headers.get(CHECKPOINT_HEADER)
    expect(id).toBeTruthy()
    expect(runtime.timeline().head("main")?.id).toBe(id ?? "")
  })

  test("off, a write records no checkpoint, and a checkpoint taken later still restores", async () => {
    const runtime = itemsRuntime({ checkpointMutations: false })
    const before = runtime.timeline().checkpoints().length
    const response = await write(runtime, "a")
    expect(response.status).toBe(201)
    expect(response.headers.get(CHECKPOINT_HEADER)).toBeNull()
    expect(runtime.timeline().checkpoints().length).toBe(before)

    const saved = runtime.checkpoint()
    await write(runtime, "b")
    expect(runtime.instance().items.has("b")).toBe(true)
    runtime.checkout(saved.id)
    expect(runtime.instance().items.has("a")).toBe(true)
    expect(runtime.instance().items.has("b")).toBe(false)
  })

  test("off, a write reads no stored records back, however many the namespace holds", async () => {
    const readsForOneWrite = async (held: number, checkpointMutations: boolean) => {
      const { client, rowsRead } = counting()
      const runtime = itemsRuntime({ checkpointMutations, sqlite: client })
      for (let n = 0; n < held; n++) await write(runtime, `held-${n}`)
      const start = rowsRead()
      await write(runtime, "next")
      return rowsRead() - start
    }
    expect(await readsForOneWrite(20, false)).toBe(0)
    expect(await readsForOneWrite(400, false)).toBe(0)
    expect(await readsForOneWrite(400, true)).toBeGreaterThan(400)
  })
})
