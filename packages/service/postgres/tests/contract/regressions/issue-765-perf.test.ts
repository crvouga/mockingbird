import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { getCatalogBuilder, setCatalogBuilder } from "../../../src/schema/catalog.ts";

// #765 complexity guard: correlated EXISTS / NOT EXISTS over catalog views used to rebuild the
// catalog for every outer row (quadratic: a 470-table schema did not finish in 60 s).
//  - deterministic: a statement materializes each catalog it reads once, however many outer rows;
//  - timing: each shape runs at n and 4n tables, where both the outer rows and the catalog grow 4x.
//    Linear work grows about 4x and quadratic work 16x; the bound sits between them, and the best of
//    several runs keeps a loaded CI machine from failing it.

function schema(tables: number): Database {
  const db = new Database();
  const ddl: string[] = [];
  for (let i = 0; i < tables; i++) {
    const fk = i > 0 ? `, ref int REFERENCES t${i - 1} (id)` : "";
    ddl.push(`CREATE TABLE t${i} (id int PRIMARY KEY, a int, b text, c text${fk})`);
    ddl.push(`CREATE INDEX t${i}_a ON t${i} (a)`);
  }
  db.exec(ddl.join(";\n"));
  return db;
}

const names = (tables: number) => `{${Array.from({ length: tables }, (_, i) => `t${i}`).join(",")},missing}`;
const indexNames = (tables: number) => `{${Array.from({ length: tables }, (_, i) => `t${i}_a`).join(",")},gone}`;

interface Shape {
  sql: string;
  params: (tables: number) => unknown[];
  /** catalog relations the statement reads */
  catalogs: number;
}

const SHAPES: Record<string, Shape> = {
  "pg_class x NOT EXISTS pg_depend": {
    sql: "SELECT count(*) FROM pg_class c WHERE NOT EXISTS (SELECT FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'i')",
    params: () => [],
    catalogs: 2,
  },
  "unnest x NOT EXISTS pg_class JOIN pg_namespace": {
    sql: `SELECT count(*)::int AS missing FROM unnest($1::text[]) AS expected(name) WHERE NOT EXISTS (
            SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = expected.name AND c.relkind IN ('r', 'v'))`,
    params: (tables) => [names(tables)],
    catalogs: 2,
  },
  "unnest x NOT EXISTS information_schema.tables / pg_indexes": {
    sql: `SELECT ARRAY(SELECT x.name FROM unnest($1::text[]) AS x(name) WHERE NOT EXISTS (
              SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = x.name)) AS t,
            ARRAY(SELECT x.name FROM unnest($2::text[]) AS x(name) WHERE NOT EXISTS (
              SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = x.name)) AS i`,
    params: (tables) => [names(tables), indexNames(tables)],
    catalogs: 2,
  },
  "pg_class x correlated scalar count over pg_attribute (not decorrelated)": {
    sql: `SELECT sum((SELECT count(*) FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0))::int AS n
          FROM pg_class c WHERE c.relkind = 'r'`,
    params: () => [],
    catalogs: 2,
  },
};

function bestOf(db: Database, sql: string, params: unknown[], runs = 5): number {
  let best = Number.POSITIVE_INFINITY;
  for (let r = 0; r < runs; r++) {
    const start = performance.now();
    db.query(sql, params as never);
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

describe("#765 correlated catalog subqueries stay linear", () => {
  const SMALL = 100;
  const LARGE = SMALL * 4;
  let small: Database;
  let large: Database;
  let builds = 0;
  const original = getCatalogBuilder();

  beforeAll(() => {
    small = schema(SMALL);
    large = schema(LARGE);
    if (!original) throw new Error("catalog builder not registered");
    setCatalogBuilder((ctx, schemaName, name) => {
      builds++;
      return original(ctx, schemaName, name);
    });
  });
  afterAll(() => {
    if (original) setCatalogBuilder(original);
  });

  for (const [name, shape] of Object.entries(SHAPES)) {
    test(`#765 ${name}: each catalog is built once per statement`, () => {
      builds = 0;
      expect(large.query(shape.sql, shape.params(LARGE) as never).length).toBe(1);
      expect(builds).toBe(shape.catalogs);
    });

    test(`#765 ${name}: 4x tables costs well under 16x`, () => {
      const a = bestOf(small, shape.sql, shape.params(SMALL));
      const b = bestOf(large, shape.sql, shape.params(LARGE));
      // generous absolute bound: the quadratic path took seconds here, the memoized path milliseconds
      expect(b).toBeLessThan(1500);
      // ratios of millisecond timings are mostly noise; only a measurable large run is compared
      if (b > 25) expect(b / Math.max(a, 2)).toBeLessThan(10);
    });
  }

  test("#765 the shapes answer what PostgreSQL does on this schema", () => {
    const db = schema(4);
    const q = (shape: string, params: unknown[]) => db.query(SHAPES[shape]!.sql, params as never);
    expect(q("unnest x NOT EXISTS pg_class JOIN pg_namespace", [names(4)])).toEqual([{ missing: 1 }]);
    expect(q("unnest x NOT EXISTS information_schema.tables / pg_indexes", [names(4), indexNames(4)])).toEqual([
      { t: "{missing}", i: "{gone}" },
    ]);
    // id, a, b, c in t0; id, a, b, c, ref in t1..t3
    expect(q("pg_class x correlated scalar count over pg_attribute (not decorrelated)", [])).toEqual([{ n: 19 }]);
  });
});
