/**
 * `withNamespaceRollback` as properties: for any namespace contents and any script of collection
 * writes, a throw leaves the namespace exactly as a full snapshot taken before would restore it,
 * a success keeps every write, another namespace's writes survive, and a nested scope rolls back
 * only its own writes. The rollback reads only the rows the work touched.
 *
 * Replay a failure with the seed fast-check prints: `FC_SEED=<seed> bun test namespace-rollback`.
 */
import { describe, expect, test } from "bun:test"
import { Database } from "@crvouga/mockingbird-service-sqlite"
import {
  migrateCore,
  type SqliteClient,
  type SqliteStatement,
  type SqliteValue,
} from "@crvouga/mockingbird-sqlite"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { Collection } from "./src/collection.js"
import { snapshotNamespace, withNamespaceRollback } from "./src/snapshot.js"

const params = fcParameters(process.env)

type Op =
  | { kind: "insert"; collection: string; id: string; value: number }
  | { kind: "update"; collection: string; id: string; value: number }
  | { kind: "delete"; collection: string; id: string }
  | { kind: "sequence"; collection: string }

const collectionName = fc.constantFrom("a", "b", "c")
const id = fc.constantFrom("1", "2", "3", "4")
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant("insert" as const),
    collection: collectionName,
    id,
    value: fc.nat(),
  }),
  fc.record({
    kind: fc.constant("update" as const),
    collection: collectionName,
    id,
    value: fc.nat(),
  }),
  fc.record({ kind: fc.constant("delete" as const), collection: collectionName, id }),
  fc.record({ kind: fc.constant("sequence" as const), collection: collectionName }),
)

const apply = (db: SqliteClient, namespace: string, ops: readonly Op[]) => {
  for (const step of ops) {
    const collection = new Collection<number>(db, namespace, step.collection)
    if (step.kind === "insert") collection.insert(step.id, step.value)
    else if (step.kind === "update") collection.update(step.id, step.value)
    else if (step.kind === "delete") collection.delete(step.id)
    else collection.nextSequence()
  }
}

const fresh = (seed: readonly Op[]) => {
  const db = new Database()
  migrateCore(db)
  apply(db, "ns", seed)
  return db
}

const fail = new Error("rolled back")

describe("withNamespaceRollback", () => {
  test("a throw restores exactly what a full snapshot holds", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op), fc.array(op), async (seed, work) => {
        const db = fresh(seed)
        const before = snapshotNamespace(db, "ns")
        await expect(
          withNamespaceRollback(db, "ns", async () => {
            apply(db, "ns", work)
            await Promise.resolve()
            throw fail
          }),
        ).rejects.toBe(fail)
        expect(snapshotNamespace(db, "ns")).toEqual(before)
      }),
      params,
    )
  })

  test("a success keeps every write", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op), fc.array(op), async (seed, work) => {
        const db = fresh(seed)
        const expected = fresh(seed)
        apply(expected, "ns", work)
        await withNamespaceRollback(db, "ns", async () => apply(db, "ns", work))
        expect(snapshotNamespace(db, "ns")).toEqual(snapshotNamespace(expected, "ns"))
      }),
      params,
    )
  })

  test("another namespace's writes survive a rollback", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op), fc.array(op), fc.array(op), async (seed, work, other) => {
        const db = fresh(seed)
        const expected = fresh([])
        apply(expected, "other", other)
        await expect(
          withNamespaceRollback(db, "ns", async () => {
            apply(db, "ns", work)
            apply(db, "other", other)
            throw fail
          }),
        ).rejects.toBe(fail)
        expect(snapshotNamespace(db, "other").records).toEqual(
          snapshotNamespace(expected, "other").records,
        )
      }),
      params,
    )
  })

  test("a nested scope that throws undoes only its own writes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(op),
        fc.array(op),
        fc.array(op),
        fc.array(op),
        async (seed, first, inner, last) => {
          const db = fresh(seed)
          const expected = fresh(seed)
          apply(expected, "ns", first)
          apply(expected, "ns", last)
          await withNamespaceRollback(db, "ns", async () => {
            apply(db, "ns", first)
            await expect(
              withNamespaceRollback(db, "ns", async () => {
                apply(db, "ns", inner)
                throw fail
              }),
            ).rejects.toBe(fail)
            apply(db, "ns", last)
          })
          expect(snapshotNamespace(db, "ns")).toEqual(snapshotNamespace(expected, "ns"))
        },
      ),
      params,
    )
  })

  test("an outer throw also undoes a nested scope that succeeded", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op), fc.array(op), fc.array(op), async (seed, outer, inner) => {
        const db = fresh(seed)
        const before = snapshotNamespace(db, "ns")
        await expect(
          withNamespaceRollback(db, "ns", async () => {
            apply(db, "ns", outer)
            await withNamespaceRollback(db, "ns", async () => apply(db, "ns", inner))
            throw fail
          }),
        ).rejects.toBe(fail)
        expect(snapshotNamespace(db, "ns")).toEqual(before)
      }),
      params,
    )
  })

  test("a scope reads only the rows it writes, however large the namespace", async () => {
    const reads = async (size: number) => {
      const db = fresh([])
      const collection = new Collection<number>(db, "ns", "big")
      for (let index = 0; index < size; index++) collection.insert(String(index), index)
      let selected = 0
      const counting: SqliteClient = {
        exec: (sql) => db.exec(sql),
        transaction: (fn) => db.transaction(fn),
        prepare: (sql) => {
          const statement: SqliteStatement = db.prepare(sql)
          return {
            run: (...params) => statement.run(...params),
            get: <T>(...params: SqliteValue[]) => {
              selected++
              return statement.get<T>(...params)
            },
            all: <T>(...params: SqliteValue[]) => {
              const rows = statement.all<T>(...params)
              selected += rows.length
              return rows
            },
          }
        },
      }
      await expect(
        withNamespaceRollback(counting, "ns", async () => {
          new Collection<number>(counting, "ns", "big").update("0", -1)
          throw fail
        }),
      ).rejects.toBe(fail)
      expect(collection.get("0")).toBe(0)
      return selected
    }
    expect(await reads(1000)).toBe(await reads(10))
  })
})
