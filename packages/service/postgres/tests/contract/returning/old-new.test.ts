import { expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { parity, queryErrorParity, sequenceParity } from "../helpers.ts";

// #692: PostgreSQL 18 RETURNING old / new, and the system columns xmax / ctid / tableoid.

const setup = ["CREATE TABLE c (a int PRIMARY KEY, b int)", "INSERT INTO c VALUES (1, 1), (2, 2)"];

sequenceParity("RETURNING old and new on UPDATE", setup, [
  { sql: "UPDATE c SET b = b + 1 WHERE a = 1 RETURNING old.b AS before, new.b AS after, b", query: true },
  { sql: "UPDATE c SET b = b * 10 WHERE a = 2 RETURNING old.*, new.*, old, new", query: true },
]);
sequenceParity("RETURNING old and new on INSERT and DELETE", setup, [
  { sql: "INSERT INTO c VALUES (3, 3) RETURNING old.a, new.a, old.*, old, new, old IS NULL AS no_old", query: true },
  { sql: "DELETE FROM c WHERE a = 3 RETURNING old.a, new.a, a, old, new, new IS NULL AS no_new, *", query: true },
]);
sequenceParity("RETURNING old and new on ON CONFLICT DO UPDATE", setup, [
  {
    sql: "INSERT INTO c VALUES (1, 50), (5, 5) ON CONFLICT (a) DO UPDATE SET b = 60 RETURNING a, old.b, new.b, b",
    query: true,
  },
]);
sequenceParity("RETURNING WITH renames old and new", setup, [
  { sql: "UPDATE c SET b = 0 WHERE a = 1 RETURNING WITH (OLD AS o, NEW AS n) o.b, n.b", query: true },
  { sql: "UPDATE c SET b = 7 WHERE a = 1 RETURNING WITH (NEW AS n) old.b, n.b", query: true },
]);
sequenceParity("a target aliased old keeps the name", setup, [
  { sql: "UPDATE c AS old SET b = 0 WHERE a = 1 RETURNING old.b", query: true },
]);
queryErrorParity(
  "OLD named twice in RETURNING WITH",
  setup,
  "UPDATE c SET b = 8 RETURNING WITH (OLD AS x, OLD AS y) 1",
  "syntax",
);

sequenceParity("xmax tells an upsert's insert from its update", setup, [
  {
    sql: "INSERT INTO c VALUES (1, 2), (3, 3) ON CONFLICT (a) DO UPDATE SET b = EXCLUDED.b RETURNING a, (xmax = 0)::text AS inserted, xmax <> 0 AS updated, pg_typeof(xmax) AS t, pg_typeof(ctid) AS u",
    query: true,
  },
  { sql: "INSERT INTO c VALUES (9, 9) RETURNING xmax, (xmax = 0) AS ins, xmin <> 0 AS has_xmin", query: true },
  { sql: "UPDATE c SET b = b + 1 WHERE a = 2 RETURNING xmax", query: true },
  { sql: "DELETE FROM c WHERE a = 9 RETURNING xmax <> 0 AS deleted", query: true },
]);
parity(
  "system columns are hidden from * and readable by name",
  setup,
  "SELECT *, (ctid IS NOT NULL)::text AS has_ctid, xmax = 0 AS live, tableoid::regclass AS rel, c.xmin <> 0 AS x FROM c ORDER BY a",
);
parity("ctid of an insert-only table", setup, "SELECT a, ctid FROM c ORDER BY a");
parity(
  "tid input, ordering and xid = int",
  [],
  "SELECT '(0,1)'::tid < '(0,2)' AS a, '(1,1)'::tid > '(0,9)' AS b, '( 0, 3)'::tid AS c, '(+1,3)'::tid AS f, '5'::xid = 5 AS d, '5'::xid <> 5 AS e",
);
queryErrorParity("malformed tid", [], "SELECT '(0)'::tid", "invalid_text_representation");
sequenceParity(
  "DELETE by ctid removes one of two duplicate rows",
  ["CREATE TABLE d (v int)", "INSERT INTO d VALUES (1), (1), (2)"],
  [
    { sql: "DELETE FROM d WHERE ctid = (SELECT min(ctid) FROM d WHERE v = 1)" },
    { sql: "SELECT v FROM d ORDER BY v", query: true },
    { sql: "UPDATE d SET v = 3 WHERE ctid IN (SELECT ctid FROM d WHERE v = 2) AND xmax = 0 RETURNING v", query: true },
  ],
);

test("divergence: ctid is the row's position and does not move on UPDATE; xmax is 0 on every scanned row", () => {
  const db = new Database();
  db.exec("CREATE TABLE c (a int PRIMARY KEY, b int); INSERT INTO c VALUES (1, 1), (2, 2)");
  db.exec("INSERT INTO c VALUES (1, 5) ON CONFLICT (a) DO UPDATE SET b = EXCLUDED.b");
  db.exec("UPDATE c SET b = 0 WHERE a = 1");
  // PostgreSQL: (0,4) / (0,2), and the upsert leaves its xid in xmax until the next update
  expect(db.query("SELECT a, ctid::text AS ctid, xmax::text AS xmax FROM c ORDER BY a")).toEqual([
    { a: 1, ctid: "(0,1)", xmax: "0" },
    { a: 2, ctid: "(0,2)", xmax: "0" },
  ]);
  db.close();
});
