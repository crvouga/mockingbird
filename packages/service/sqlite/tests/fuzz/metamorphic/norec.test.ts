import { describe, test } from "bun:test";
import * as fc from "fast-check";
import { fuzzAssertConfig, intArb, textArb } from "../config.ts";
import { compareOrReport, withDatabases } from "../helpers.ts";

const rowArb = fc.record({
  id: fc.integer({ min: 1, max: 40 }),
  a: intArb,
  b: textArb.filter((s) => s.length <= 12),
});

const predicateArb = fc.oneof(
  fc.record({ kind: fc.constant("gt" as const), n: intArb }),
  fc.record({ kind: fc.constant("eq" as const), n: intArb }),
  fc.record({ kind: fc.constant("notnull" as const) }),
);

function predicateSql(p: fc.InferValue<typeof predicateArb>): string {
  if (p.kind === "gt") return `a > ${p.n}`;
  if (p.kind === "eq") return `a = ${p.n}`;
  return "a IS NOT NULL";
}

/**
 * NoREC: filtered SELECT must match a non-optimized boolean projection rewrite.
 */
describe("NoREC metamorphic fuzz", () => {
  test("WHERE query matches boolean-projection rewrite on both engines", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(rowArb, { selector: (r) => r.id, minLength: 3, maxLength: 20 }),
        predicateArb,
        (rows, pred) => {
          const p = predicateSql(pred);
          withDatabases((memory, sqlite) => {
            for (const db of [memory, sqlite]) {
              db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT)");
              for (const row of rows) {
                db.exec("INSERT INTO t VALUES (?, ?, ?)", [row.id, row.a, row.b]);
              }
            }

            const original = `SELECT id, a, b FROM t WHERE (${p}) ORDER BY id`;
            const norecBool = [
              "SELECT id, a, b FROM (",
              `  SELECT id, a, b, (${p}) AS flag FROM t`,
              ") AS q WHERE flag ORDER BY id",
            ].join(" ");
            const innerPred =
              pred.kind === "gt"
                ? `inner.a > ${pred.n}`
                : pred.kind === "eq"
                  ? `inner.a = ${pred.n}`
                  : "inner.a IS NOT NULL";
            const norecExists = [
              "SELECT id, a, b FROM t AS outer",
              `WHERE EXISTS (SELECT 1 FROM t AS inner WHERE inner.id = outer.id AND (${innerPred}))`,
              "ORDER BY id",
            ].join(" ");

            for (const [label, sql] of [
              ["orig", original],
              ["norec-bool", norecBool],
              ["norec-exists", norecExists],
            ] as const) {
              compareOrReport(`norec-${label}`, sql, { rows, pred }, memory.query(sql), sqlite.query(sql));
            }

            for (const db of [memory, sqlite]) {
              const a = JSON.stringify(db.query(original).rows);
              const b = JSON.stringify(db.query(norecBool).rows);
              const c = JSON.stringify(db.query(norecExists).rows);
              if (a !== b || a !== c) {
                throw new Error(`NoREC mismatch pred=${p} engine=${db === memory ? "mem" : "sqlite"}`);
              }
            }
          });
        },
      ),
      fuzzAssertConfig(20),
    );
  });
});
