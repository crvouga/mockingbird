import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { Database, Snapshot, SqliteError } from "../../src/index.ts";
import { dumpLogicalState } from "../harness/state-dump.ts";
import { fuzzAssertConfig, intArb, textArb } from "./config.ts";
import { compareStateOrReport, withDatabases } from "./helpers.ts";
import { mixedOpArb, runSequence } from "./dst/index.ts";

const TOKEN_SALAD = fc
  .array(
    fc.constantFrom(
      "SELECT",
      "FROM",
      "WHERE",
      "INSERT",
      "*",
      "(",
      ")",
      ",",
      "1",
      "NULL",
      "AND",
      "OR",
      "t",
      "a",
      "'x'",
      "--",
      "/*",
      "UNION",
      "JOIN",
    ),
    { minLength: 1, maxLength: 12 },
  )
  .map((parts) => parts.join(" "));

describe("robustness fuzz", () => {
  test("token salads throw only SqliteError", () => {
    fc.assert(
      fc.property(TOKEN_SALAD, (sql) => {
        const db = new Database();
        try {
          try {
            db.prepare(sql);
          } catch (error) {
            expect(error).toBeInstanceOf(SqliteError);
          }
          try {
            db.query(sql);
          } catch (error) {
            expect(error).toBeInstanceOf(SqliteError);
          }
          try {
            db.exec(sql);
          } catch (error) {
            expect(error).toBeInstanceOf(SqliteError);
          }
        } finally {
          db.close();
        }
      }),
      fuzzAssertConfig(40),
    );
  });

  test("short mixed sequences finish under wall-clock budget", () => {
    fc.assert(
      fc.property(fc.array(mixedOpArb, { minLength: 4, maxLength: 12 }), (ops) => {
        const started = Date.now();
        runSequence(ops, { label: "robust-mixed", finalizeCommit: true });
        const elapsed = Date.now() - started;
        if (elapsed > 5_000) {
          throw new Error(`mixed sequence exceeded 5s budget: ${elapsed}ms`);
        }
      }),
      fuzzAssertConfig(8),
    );
  });

  test("Dump stays well-formed after DML and matches oracle", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ a: intArb, b: textArb }), { minLength: 1, maxLength: 6 }), (rows) => {
        withDatabases((memory, sqlite) => {
          for (const db of [memory, sqlite]) {
            db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT)");
            for (const [i, row] of rows.entries()) {
              db.exec("INSERT INTO t VALUES (?, ?, ?)", [i + 1, row.a, row.b]);
            }
          }
          const dump = dumpLogicalState(memory);
          expect(dump.ok).toBe(true);
          expect(dump.rows.some((r) => r.section === "schema")).toBe(true);
          expect(dump.rows.some((r) => r.section === "row")).toBe(true);
          compareStateOrReport("robust-dump", rows, memory, sqlite);

          const integrity = sqlite.query("PRAGMA integrity_check");
          expect(integrity.ok).toBe(true);
          expect(integrity.rows[0]).toEqual({ integrity_check: "ok" });
        });
      }),
      fuzzAssertConfig(15),
    );
  });

  test("SQLM bit-flips yield decoder errors only", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 64 }), (byte, offset) => {
        const db = new Database({ seed: 1 });
        try {
          db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT)");
          db.exec("INSERT INTO t VALUES (1, 1)");
          const snap = db.snapshot().encode();
          const corrupt = new Uint8Array(snap);
          const idx = Math.min(offset, Math.max(0, corrupt.length - 1));
          corrupt[idx] = byte;
          try {
            Snapshot.decode(corrupt);
            // Some flips may still decode — only assert non-SqliteError never escapes.
          } catch (error) {
            expect(error).toBeInstanceOf(SqliteError);
          }
        } finally {
          db.close();
        }
      }),
      fuzzAssertConfig(25),
    );
  });
});
