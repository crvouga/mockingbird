import { describe, expect, test } from "bun:test"
import { Database } from "@crvouga/mockingbird-service-sqlite"
import { fcParameters } from "@crvouga/mockingbird-testing"
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

describe("listAppliedMigrations order", () => {
  test("returns migrations applied in the same second in run order, not id order", () => {
    const sqlite = createDefaultSqlite()
    migrate(sqlite, [
      { id: "002_z", sql: "CREATE TABLE z (id INTEGER PRIMARY KEY)" },
      { id: "001_a", sql: "CREATE TABLE a (id INTEGER PRIMARY KEY)" },
      { id: "003_m", sql: "CREATE TABLE m (id INTEGER PRIMARY KEY)" },
    ])
    expect(listAppliedMigrations(sqlite)).toEqual(["002_z", "001_a", "003_m"])
  })
})

describe("migrate duplicate ids", () => {
  test("rejects a list that repeats an id, naming it, before applying anything", () => {
    const sqlite = createDefaultSqlite()
    const migrations = [
      { id: "001_a", sql: "CREATE TABLE a (id INTEGER PRIMARY KEY)" },
      { id: "002_b", sql: "CREATE TABLE b (id INTEGER PRIMARY KEY)" },
      { id: "001_a", sql: "CREATE TABLE c (id INTEGER PRIMARY KEY)" },
    ]
    expect(() => migrate(sqlite, migrations)).toThrow('duplicate migration id "001_a"')
    expect(tableExists(sqlite, "a")).toBe(false)
    expect(listAppliedMigrations(sqlite)).toEqual([])
  })
})

describe("migrateCore legacy names", () => {
  const legacySchema = (prefix: "emulates" | "emulators") => `
    CREATE TABLE schema_migrations (id TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL);
    INSERT INTO schema_migrations (id, applied_at) VALUES ('20260322_core_records_sequences', 1);
    CREATE TABLE ${prefix}_records (
      namespace TEXT NOT NULL,
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (namespace, collection, id)
    );
    CREATE INDEX ${prefix}_records_seq ON ${prefix}_records (namespace, collection, seq);
    CREATE TABLE ${prefix}_sequences (
      namespace TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      value INTEGER NOT NULL,
      PRIMARY KEY (namespace, name, kind)
    );
    INSERT INTO ${prefix}_records (namespace, collection, id, seq, value)
      VALUES ('ns', 'customers', 'cus_1', 1, '{}');
  `

  test("renames tables created under emulates_ or emulators_ back to mockingbird_", () => {
    for (const prefix of ["emulates", "emulators"] as const) {
      const sqlite = createDefaultSqlite()
      sqlite.exec(legacySchema(prefix))
      migrateCore(sqlite)
      expect(tableExists(sqlite, "mockingbird_records")).toBe(true)
      expect(tableExists(sqlite, "mockingbird_sequences")).toBe(true)
      expect(tableExists(sqlite, `${prefix}_records`)).toBe(false)
      expect(tableExists(sqlite, `${prefix}_sequences`)).toBe(false)
      const row = sqlite
        .prepare("SELECT id FROM mockingbird_records WHERE namespace = ?")
        .get<{ id: string }>("ns")
      expect(row?.id).toBe("cus_1")
    }
  })
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
