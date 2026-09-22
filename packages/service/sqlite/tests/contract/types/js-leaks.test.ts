import { expect, test } from "bun:test";
import { Database, SqliteError } from "../../../src/index.ts";
import { expectParity } from "../../harness/assert.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { divergence, parity, setupBoth } from "../helpers.ts";

/** JS↔SQL boundary edges. Differential only where both engines agree; rest pinned as divergences. */

parity("empty TEXT is not empty BLOB", [], "SELECT '' = X'' AS eq, typeof('') AS t, typeof(X'') AS b");

parity(
  "empty BLOB vs empty TEXT as stored columns",
  ["CREATE TABLE t(a TEXT, b BLOB)", "INSERT INTO t VALUES ('', X'')"],
  "SELECT typeof(a) ta, typeof(b) tb, length(a) la, length(b) lb FROM t",
);

parity("SQL -0.0 literal is real zero", [], "SELECT typeof(-0.0) t, -0.0 = 0 AS eq");

matrixBoth("BigInt at MAX_SAFE_INTEGER roundtrips as integer", (memory, sqlite) => {
  setupBoth(memory, sqlite, ["CREATE TABLE t(v INTEGER)"]);
  const value = 9007199254740991n;
  expectParity(memory.exec("INSERT INTO t VALUES (?)", [value]), sqlite.exec("INSERT INTO t VALUES (?)", [value]));
  expectParity(memory.query("SELECT v, typeof(v) kind FROM t"), sqlite.query("SELECT v, typeof(v) kind FROM t"));
});

/**
 * bun:sqlite binds JS Number.MAX_SAFE_INTEGER as REAL; sqlite-mem keeps INTEGER.
 * Documented intentional bind-class difference (same numeric value).
 */
divergence("js-bind-max-safe-integer-typeof", "Number.MAX_SAFE_INTEGER bind is integer in sqlite-mem", (db) => {
  const rows = db.query("SELECT typeof(?) AS t", [Number.MAX_SAFE_INTEGER]);
  expect(rows).toEqual([{ t: "integer" }]);
});

/**
 * bun:sqlite without safeIntegers loses low bits on BigInt > MAX_SAFE_INTEGER.
 * sqlite-mem preserves the BigInt bit pattern.
 */
divergence("js-bind-bigint-beyond-safe", "BigInt beyond MAX_SAFE_INTEGER preserves bits", (db) => {
  db.exec("CREATE TABLE t(id INTEGER)");
  db.prepare("INSERT INTO t VALUES (?)").run(9007199254740993n);
  expect(db.query("SELECT id FROM t")).toEqual([{ id: 9007199254740993n }]);
});

/** IEEE -0 is canonicalized to +0 on bind (determinism invariant). */
divergence("js-bind-neg-zero", "bound -0 becomes +0 integer", (db) => {
  const rows = db.query("SELECT ? AS v, typeof(?) AS t", [-0, -0]);
  expect(rows[0]?.v).toBe(0);
  expect(Object.is(rows[0]?.v, -0)).toBe(false);
  expect(rows[0]?.t).toBe("integer");
});

test("undefined bind is rejected", () => {
  const db = new Database();
  try {
    expect(() => db.query("SELECT ?", [undefined as unknown as null])).toThrow(SqliteError);
  } finally {
    db.close();
  }
});
