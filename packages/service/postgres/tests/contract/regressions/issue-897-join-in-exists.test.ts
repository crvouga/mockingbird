import { beforeAll, describe, expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";

// #897 complexity guard: a join inside a correlated EXISTS whose ON clause reads only one side
// (plus the outer row) used to pair every pg_index row with every pg_attribute row before any
// predicate ran, and did so even when the outer query had no rows (the zero-row type probe ran the
// subquery). 800 tables took ~10 s against ~25 ms for the equivalent scalar-subquery form.
//  - timing: each shape runs at n and 4n tables. Quadratic work grows ~16x, linear ~4x; the bound
//    sits between them and the best of several runs keeps a loaded CI machine from failing it.
//  - the joined form must stay within a small factor of the scalar form at the larger size, and
//    the zero-outer-row form must cost no more than the outer query itself.

const JOINED = `SELECT c.relname,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attname = 'key'
    WHERE i.indrelid = c.oid AND i.indisunique AND i.indkey[0] = a.attnum
  ) AS "keyUnique"
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relname = $2`;

const SCALAR = `SELECT c.relname,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
    WHERE i.indrelid = c.oid AND i.indisunique
      AND i.indkey[0] = (SELECT a.attnum FROM pg_catalog.pg_attribute a
                         WHERE a.attrelid = c.oid AND a.attname = 'key')
  ) AS "keyUnique"
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relname = $2`;

function schema(tables: number): Database {
  const db = new Database();
  const ddl = [
    'CREATE TABLE records ("key" text PRIMARY KEY, "value" jsonb)',
    'CREATE TABLE loose ("value" int, "key" text)',
  ];
  for (let t = 0; t < tables; t++) {
    ddl.push(`CREATE TABLE other_${t} (id serial PRIMARY KEY, a text UNIQUE, b text, c text, d text, e text)`);
  }
  db.exec(ddl.join(";\n"));
  return db;
}

function bestOf(db: Database, sql: string, params: string[], runs = 5): number {
  let best = Number.POSITIVE_INFINITY;
  for (let r = 0; r < runs; r++) {
    const start = performance.now();
    db.query(sql, params);
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

describe("#897 join inside a correlated EXISTS", () => {
  const SMALL = 100;
  const LARGE = SMALL * 4;
  let small: Database;
  let large: Database;

  beforeAll(() => {
    small = schema(SMALL);
    large = schema(LARGE);
  });

  test("#897 both forms answer the same", () => {
    for (const sql of [JOINED, SCALAR]) {
      expect(small.query(sql, ["public", "records"])).toEqual([{ relname: "records", keyUnique: true }]);
      expect(small.query(sql, ["public", "loose"])).toEqual([{ relname: "loose", keyUnique: false }]);
      expect(small.query(sql, ["public", "other_3"])).toEqual([{ relname: "other_3", keyUnique: false }]);
      expect(small.query(sql, ["public", "missing"])).toEqual([]);
    }
  });

  test("#897 4x tables costs well under 16x", () => {
    const a = bestOf(small, JOINED, ["public", "records"]);
    const b = bestOf(large, JOINED, ["public", "records"]);
    // generous absolute bound: the cross-product path took over two seconds here, the fixed one milliseconds
    expect(b).toBeLessThan(1000);
    if (b > 25) expect(b / Math.max(a, 2)).toBeLessThan(10);
  });

  test("#897 the joined form stays within a small factor of the scalar-subquery form", () => {
    const joined = bestOf(large, JOINED, ["public", "records"]);
    const scalar = bestOf(large, SCALAR, ["public", "records"]);
    expect(joined).toBeLessThan(scalar * 5 + 25);
  });

  test("#897 no outer row: the subquery is analysed, not run", () => {
    const none = bestOf(large, JOINED, ["public", "missing"]);
    const scalar = bestOf(large, SCALAR, ["public", "records"]);
    // the outer query alone (pg_class x pg_namespace) is most of what the scalar form costs
    expect(none).toBeLessThan(scalar * 2 + 25);
  });
});
