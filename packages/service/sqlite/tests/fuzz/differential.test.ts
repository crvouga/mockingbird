/** Coverage: FZZ-diff-01 FZZ-seed-01 FZZ-replay-01 */
import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { InMemoryAdapter } from "../adapters/in-memory.ts";
import { RealSqliteAdapter } from "../adapters/real-sqlite.ts";
import { expectParity } from "../harness/assert.ts";
import { deepCompareResults } from "../harness/normalize.ts";
import type { ContractDb, QueryResult, SqlValue } from "../harness/types.ts";
import { fuzzAssertConfig, fuzzSeed, intArb, nullArb, realArb, textArb, valueArb } from "./config.ts";

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function sqlLiteral(value: SqlValue): string {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "0";
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  return "X''";
}

function setupPeople(db: ContractDb, rows: Array<{ id: number; name: string; score: number | null }>): void {
  expect(db.exec("CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT, score REAL)").ok).toBe(true);
  for (const row of rows) {
    const result = db.exec(`INSERT INTO people(id, name, score) VALUES (?, ?, ?)`, [row.id, row.name, row.score]);
    expect(result.ok, result.error?.message).toBe(true);
  }
}

function compareOrReport(label: string, sql: string, setup: string, memory: QueryResult, sqlite: QueryResult): void {
  const comparison = deepCompareResults(memory, sqlite);
  if (!comparison.equal) {
    throw new Error(
      [
        `Differential mismatch (${label})`,
        `seed=${fuzzSeed()}`,
        `Replay: SQLITE_MEM_FUZZ_SEED=${fuzzSeed()} bun test tests/fuzz`,
        `SQL: ${sql}`,
        `Setup: ${setup}`,
        `Reason: ${comparison.reason}`,
        `memory: ${JSON.stringify(memory)}`,
        `sqlite: ${JSON.stringify(sqlite)}`,
      ].join("\n"),
    );
  }
}

describe("differential fuzz", () => {
  test("random arithmetic expressions", () => {
    fc.assert(
      fc.property(intArb, intArb, fc.constantFrom("+", "-", "*", "%"), (a, b, op) => {
        if (op === "%" && b === 0) return;
        const sql = `SELECT (${a} ${op} ${b}) AS v`;
        const memory = new InMemoryAdapter();
        const sqlite = new RealSqliteAdapter();
        try {
          compareOrReport("arith", sql, "(none)", memory.query(sql), sqlite.query(sql));
        } finally {
          memory.close();
          sqlite.close();
        }
      }),
      fuzzAssertConfig(80),
    );
  });

  test("random WHERE filters over mixed values", () => {
    fc.assert(
      fc.property(
        fc
          .array(
            fc.record({
              id: fc.integer({ min: 1, max: 50 }),
              name: textArb.filter((s) => s.length > 0),
              score: fc.oneof(nullArb, realArb),
            }),
            { minLength: 1, maxLength: 8 },
          )
          .map((rows) => {
            const seen = new Set<number>();
            return rows.filter((row) => {
              if (seen.has(row.id)) return false;
              seen.add(row.id);
              return true;
            });
          })
          .filter((rows) => rows.length > 0),
        fc.oneof(nullArb, intArb, realArb),
        (rows, threshold) => {
          const memory = new InMemoryAdapter();
          const sqlite = new RealSqliteAdapter();
          try {
            setupPeople(memory, rows);
            setupPeople(sqlite, rows);
            const sql =
              threshold === null
                ? `SELECT id, name, score FROM people WHERE score IS NULL ORDER BY id`
                : `SELECT id, name, score FROM people WHERE score > ${sqlLiteral(threshold)} ORDER BY id`;
            compareOrReport("where", sql, JSON.stringify(rows), memory.query(sql), sqlite.query(sql));
          } finally {
            memory.close();
            sqlite.close();
          }
        },
      ),
      fuzzAssertConfig(40),
    );
  });

  test("random SELECT projections and ORDER BY", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 30 }), { minLength: 2, maxLength: 6 }),
        fc.constantFrom("id", "name", "score"),
        fc.constantFrom("ASC", "DESC"),
        (ids, orderCol, dir) => {
          const rows = ids.map((id) => ({
            id,
            name: `n${id}`,
            score: id % 3 === 0 ? null : id + 0.5,
          }));
          const memory = new InMemoryAdapter();
          const sqlite = new RealSqliteAdapter();
          try {
            setupPeople(memory, rows);
            setupPeople(sqlite, rows);
            const sql = `SELECT id, name, score FROM people ORDER BY ${quoteIdent(orderCol)} ${dir}, id ASC`;
            compareOrReport("order", sql, JSON.stringify(rows), memory.query(sql), sqlite.query(sql));
          } finally {
            memory.close();
            sqlite.close();
          }
        },
      ),
      fuzzAssertConfig(40),
    );
  });

  test("random INSERT values round-trip", () => {
    fc.assert(
      fc.property(valueArb, valueArb, (a, b) => {
        const memory = new InMemoryAdapter();
        const sqlite = new RealSqliteAdapter();
        try {
          for (const db of [memory, sqlite]) {
            expect(db.exec("CREATE TABLE t(a, b)").ok).toBe(true);
            expect(db.exec("INSERT INTO t(a, b) VALUES (?, ?)", [a, b]).ok).toBe(true);
          }
          expectParity(
            memory.query("SELECT typeof(a) AS ta, typeof(b) AS tb, a, b FROM t"),
            sqlite.query("SELECT typeof(a) AS ta, typeof(b) AS tb, a, b FROM t"),
          );
        } finally {
          memory.close();
          sqlite.close();
        }
      }),
      fuzzAssertConfig(50),
    );
  });

  test("invalid SQL fails on both backends", () => {
    const bad = ["SELEC", "SELECT FROM", "INSERT INTO", "CREATE TABLE (", "UPDATE SET"];
    for (const sql of bad) {
      const memory = new InMemoryAdapter();
      const sqlite = new RealSqliteAdapter();
      try {
        const a = memory.exec(sql);
        const b = sqlite.exec(sql);
        expect(a.ok).toBe(false);
        expect(b.ok).toBe(false);
      } finally {
        memory.close();
        sqlite.close();
      }
    }
  });
});
