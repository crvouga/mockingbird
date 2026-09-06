import { describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import { Database } from "@crvouga/sqlite-mem"
import fc from "fast-check"
import {
  CORE_MIGRATIONS,
  createDefaultSqlite,
  listAppliedMigrations,
  migrate,
  migrateCore,
  resolveSqlite,
  type SqliteClient,
} from "./src/index.js"

const params = fcParameters(process.env)

const tableExists = (sqlite: SqliteClient, name: string) =>
  sqlite
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get<{ ok: number }>(name) !== undefined

describe("resolveSqlite", () => {
  test("defaults to sqlite-mem and passes through an injected client", () => {
    fc.assert(
      fc.property(fc.nat(), (seed) => {
        const injected = new Database({ seed })
        expect(resolveSqlite(injected)).toBe(injected)
        const fresh = createDefaultSqlite()
        fresh.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)")
        expect(tableExists(fresh, "t")).toBe(true)
      }),
      params,
    )
  })
})

describe("migrate", () => {
  test(
    "applies pending migrations once; a second call is a no-op",
    () => {
      fc.assert(
        fc.property(fc.nat({ max: 5 }), (extra) => {
          const sqlite = createDefaultSqlite()
          migrateCore(sqlite)
          const first = listAppliedMigrations(sqlite)
          expect(first).toEqual(CORE_MIGRATIONS.map((m) => m.id))
          expect(tableExists(sqlite, "mockingbird_records")).toBe(true)
          expect(tableExists(sqlite, "mockingbird_sequences")).toBe(true)

          migrateCore(sqlite)
          expect(listAppliedMigrations(sqlite)).toEqual(first)

          const more = Array.from({ length: extra }, (_, i) => ({
            id: `extra_${i}`,
            sql: `CREATE TABLE IF NOT EXISTS extra_${i} (id INTEGER PRIMARY KEY)`,
          }))
          migrate(sqlite, [...CORE_MIGRATIONS, ...more])
          expect(listAppliedMigrations(sqlite)).toEqual([
            ...CORE_MIGRATIONS.map((m) => m.id),
            ...more.map((m) => m.id),
          ])
          migrate(sqlite, [...CORE_MIGRATIONS, ...more])
          expect(listAppliedMigrations(sqlite).length).toBe(CORE_MIGRATIONS.length + extra)
        }),
        params,
      )
    },
    { timeout: 30_000 },
  )
})

describe("SqliteClient CRUD walks", () => {
  test("random insert/update/delete/select against default and injected clients agree with a Map model", async () => {
    const clients: Array<() => SqliteClient> = [
      () => createDefaultSqlite(),
      () => new Database() as SqliteClient,
    ]
    for (const create of clients) {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.oneof(
              fc.record({
                op: fc.constant("upsert" as const),
                key: fc.stringMatching(/^[a-c]$/),
                value: fc.integer(),
              }),
              fc.record({ op: fc.constant("delete" as const), key: fc.stringMatching(/^[a-c]$/) }),
              fc.record({ op: fc.constant("get" as const), key: fc.stringMatching(/^[a-c]$/) }),
            ),
            { minLength: 1, maxLength: 40 },
          ),
          async (ops) => {
            const sqlite = create()
            sqlite.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v INTEGER NOT NULL)")
            const upsert = sqlite.prepare(
              "INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            )
            const del = sqlite.prepare("DELETE FROM kv WHERE k = ?")
            const get = sqlite.prepare("SELECT v FROM kv WHERE k = ?")
            const model = new Map<string, number>()
            for (const op of ops) {
              if (op.op === "upsert") {
                upsert.run(op.key, op.value)
                model.set(op.key, op.value)
              } else if (op.op === "delete") {
                del.run(op.key)
                model.delete(op.key)
              } else {
                const row = get.get<{ v: number }>(op.key)
                expect(row?.v).toBe(model.get(op.key))
              }
            }
            const rows = sqlite
              .prepare("SELECT k, v FROM kv ORDER BY k ASC")
              .all<{ k: string; v: number }>()
            expect(rows).toEqual(
              [...model.entries()]
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([k, v]) => ({ k, v })),
            )
          },
        ),
        params,
      )
    }
  })
})
