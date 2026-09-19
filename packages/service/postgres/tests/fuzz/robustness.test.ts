import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { Database, PostgresError, Snapshot } from "../../src/index.ts";
import { fuzzAssertConfig } from "./config.ts";

const TOKEN_SALAD = fc
  .array(
    fc.constantFrom(
      "SELECT",
      "FROM",
      "WHERE",
      "INSERT",
      "UPDATE",
      "DELETE",
      "INTO",
      "VALUES",
      "*",
      "(",
      ")",
      ",",
      ";",
      "1",
      "1.5",
      "NULL",
      "TRUE",
      "AND",
      "OR",
      "NOT",
      "t",
      "a",
      "'x'",
      "$1",
      "::int",
      "--",
      "/*",
      "UNION",
      "JOIN",
      "ON",
      "GROUP",
      "BY",
      "ORDER",
      "LIMIT",
    ),
    { minLength: 1, maxLength: 12 },
  )
  .map((parts) => parts.join(" "));

/** Assert `fn` either succeeds or throws PostgresError (never TypeError/RangeError/etc.). */
function expectOnlyPostgresError(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PostgresError);
  }
}

describe("robustness fuzz (memory-only)", () => {
  test("token salads throw only PostgresError from prepare/query/exec", () => {
    fc.assert(
      fc.property(TOKEN_SALAD, (sql) => {
        const db = new Database();
        try {
          expectOnlyPostgresError(() => db.prepare(sql));
          expectOnlyPostgresError(() => db.query(sql));
          expectOnlyPostgresError(() => db.exec(sql));
        } finally {
          db.close();
        }
      }),
      fuzzAssertConfig(25),
    );
  });

  test("snapshot bit-flips either restore cleanly or throw PostgresError", () => {
    const base = new Database();
    base.exec("CREATE TABLE t (id serial PRIMARY KEY, a int, b text, c float8)");
    base.exec("INSERT INTO t (id, a, b, c) VALUES (1, 10, 'x', 1.5)");
    base.exec("INSERT INTO t (id, a, b, c) VALUES (2, NULL, NULL, NULL)");
    const snap = base.snapshot().encode();
    base.close();

    fc.assert(
      fc.property(fc.integer({ min: 0, max: 255 }), fc.nat({ max: 4095 }), (byte, offset) => {
        const corrupt = new Uint8Array(snap);
        corrupt[offset % corrupt.length] = byte;
        try {
          const opened = Snapshot.decode(corrupt).open();
          try {
            // Restored cleanly — the database must still be queryable.
            expectOnlyPostgresError(() => opened.query("SELECT * FROM t ORDER BY id"));
          } finally {
            opened.close();
          }
        } catch (error) {
          expect(error).toBeInstanceOf(PostgresError);
        }
      }),
      fuzzAssertConfig(25),
    );
  });

  test("deeply nested parentheses and very long identifiers do not crash", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 600 }),
        fc.integer({ min: 1, max: 4000 }),
        fc.boolean(),
        (depth, identLen, asTable) => {
          const db = new Database();
          try {
            const nested = `SELECT ${"(".repeat(depth)}1${")".repeat(depth)}`;
            expectOnlyPostgresError(() => db.query(nested));

            const ident = `x${"y".repeat(identLen)}`;
            const identSql = asTable ? `CREATE TABLE ${ident} (a int)` : `SELECT 1 AS ${ident}`;
            expectOnlyPostgresError(() => db.exec(identSql));
          } finally {
            db.close();
          }
        },
      ),
      fuzzAssertConfig(25),
    );
  });
});
