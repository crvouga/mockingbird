/**
 * Capture oracle results for browser SQL smoke (run on Bun with bun:sqlite).
 *   bun run scripts/generate-browser-fixtures.ts
 */
import { Database as BunDatabase } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
mkdirSync(join(ROOT, "tests/browser"), { recursive: true });

const cases: Array<{ id: string; setup: string[]; sql: string; params?: unknown[] }> = [
  { id: "select-1", setup: [], sql: "SELECT 1 AS v" },
  {
    id: "affinity",
    setup: ["CREATE TABLE t(i INTEGER, r REAL, t TEXT)", "INSERT INTO t VALUES ('42','42','42')"],
    sql: "SELECT typeof(i) ti, typeof(r) tr, typeof(t) tt FROM t",
  },
  {
    id: "join",
    setup: [
      "CREATE TABLE a(id INT, n TEXT)",
      "CREATE TABLE b(id INT, a_id INT)",
      "INSERT INTO a VALUES (1,'x'),(2,'y')",
      "INSERT INTO b VALUES (10,1),(20,2)",
    ],
    sql: "SELECT a.n, b.id FROM a JOIN b ON a.id = b.a_id ORDER BY b.id",
  },
  {
    id: "null-3vl",
    setup: [],
    sql: "SELECT NULL = NULL AS eq, NULL IS NULL AS isn, 1 IN (1, NULL) AS inn",
  },
  {
    id: "bind",
    setup: ["CREATE TABLE t(x INT)", "INSERT INTO t VALUES (1),(2),(3)"],
    sql: "SELECT x FROM t WHERE x > ? ORDER BY x",
    params: [1],
  },
  {
    id: "master-sql",
    setup: ["CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL)"],
    sql: "SELECT sql FROM sqlite_master WHERE name='users'",
  },
  {
    id: "window",
    setup: ["CREATE TABLE t(x INT)", "INSERT INTO t VALUES (1),(2),(3)"],
    sql: "SELECT x, row_number() OVER (ORDER BY x) AS rn FROM t ORDER BY x",
  },
  {
    id: "json",
    setup: [],
    sql: "SELECT json_extract('{\"a\":1}', '$.a') AS a",
  },
];

const ora = new BunDatabase(":memory:");
const version = String(ora.prepare("SELECT sqlite_version()").get()?.["sqlite_version()"] ?? "");

const out = {
  version: 1,
  oracleVersion: version,
  cases: cases.map((c) => {
    const db = new BunDatabase(":memory:");
    for (const s of c.setup) db.exec(s);
    try {
      const stmt = db.prepare(c.sql);
      const rows = c.params ? stmt.all(...(c.params as never[])) : stmt.all();
      const columns = stmt.columnNames;
      const values = (rows as Record<string, unknown>[]).map((row) => columns.map((col) => row[col] ?? null));
      return { ...c, expect: { columns, values } };
    } catch (error) {
      return {
        ...c,
        expect: { errorCategory: "other", message: (error as Error).message },
      };
    }
  }),
};

writeFileSync(join(ROOT, "tests/browser/fixtures.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`Wrote ${out.cases.length} fixtures (oracle ${version})`);
