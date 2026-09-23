import { expect } from "bun:test";
import { PAR_SECTION } from "../../../compat/sections/par.ts";
import { runCatalog } from "./run.ts";

const TEN_ROWS = ["CREATE TABLE t (n int)", "INSERT INTO t SELECT generate_series(1, 10)"];

runCatalog(PAR_SECTION, [
  { id: "PAR-prec-01", kind: "parity", sql: "SELECT -2^2 AS a, 2^3^2 AS b" },
  { id: "PAR-prec-02", kind: "parity", sql: "SELECT true OR false AND false AS a, NOT false AND false AS b" },
  { id: "PAR-prec-03", kind: "parity", sql: "SELECT NOT 1 = 2 AS v" },
  { id: "PAR-prec-04", kind: "parity", sql: "SELECT 1 + NULL IS NULL AS v" },
  { id: "PAR-prec-05", kind: "parity", sql: "SELECT 1 + 1 BETWEEN 1 AND 3 AS v" },
  { id: "PAR-prec-06", kind: "parity", sql: "SELECT -1::int AS a, (-1)::int AS b" },
  { id: "PAR-prec-07", kind: "parity", sql: "SELECT 2 ^ -2 AS v" },
  { id: "PAR-case-01", kind: "parity", sql: "SELECT CASE 2 WHEN 1 THEN 'one' WHEN 2 THEN 'two' ELSE 'many' END AS v" },
  { id: "PAR-case-02", kind: "parity", sql: "SELECT CASE WHEN 1 > 2 THEN 'a' WHEN 2 > 1 THEN 'b' END AS v" },
  { id: "PAR-case-03", kind: "parity", sql: "SELECT CASE WHEN false THEN 1 END AS v" },
  { id: "PAR-row-01", kind: "parity", sql: "SELECT (1, 2) = (1, 2) AS a, ROW(1, 'x') = ROW(1, 'x') AS b" },
  { id: "PAR-row-02", kind: "parity", sql: "SELECT (1, 2) < (1, 3) AS a, (2, 0) > (1, 9) AS b" },
  {
    id: "PAR-row-03",
    kind: "divergence",
    fn: (db) => {
      expect(() => db.query("SELECT (1, 2) = (1, 2, 3) AS v")).toThrow(/unequal number of entries/);
    },
  },
  { id: "PAR-arr-01", kind: "parity", sql: "SELECT ARRAY[1, 2, 3] AS v" },
  { id: "PAR-arr-02", kind: "parity", sql: "SELECT ARRAY[[1, 2], [3, 4]] AS v" },
  { id: "PAR-arr-03", kind: "error", sql: "SELECT ARRAY[1, 'x']", query: true, messageTier: "A" },
  {
    id: "PAR-cast-01",
    kind: "parity",
    sql: "SELECT CAST('42' AS integer) AS a, '42'::integer AS b, CAST(1.9 AS int) AS c",
  },
  { id: "PAR-fetch-01", kind: "parity", setup: TEN_ROWS, sql: "SELECT n FROM t ORDER BY n FETCH FIRST 3 ROWS ONLY" },
  {
    id: "PAR-fetch-02",
    kind: "parity",
    setup: TEN_ROWS,
    sql: "SELECT n FROM t ORDER BY n OFFSET 2 FETCH NEXT 2 ROWS ONLY",
  },
  {
    id: "PAR-fetch-03",
    kind: "parity",
    setup: ["CREATE TABLE t (n int)", "INSERT INTO t VALUES (1), (1), (2)"],
    sql: "SELECT n FROM t ORDER BY n FETCH FIRST 1 ROWS WITH TIES",
  },
  { id: "PAR-limit-01", kind: "parity", setup: TEN_ROWS, sql: "SELECT n FROM t ORDER BY n DESC LIMIT 3 OFFSET 1" },
  { id: "PAR-sub-01", kind: "parity", sql: "SELECT s.v FROM (SELECT 42 AS v) AS s" },
  {
    id: "PAR-exists-01",
    kind: "parity",
    setup: ["CREATE TABLE t (n int)", "INSERT INTO t VALUES (1)"],
    sql: "SELECT EXISTS (SELECT 1 FROM t) AS a, NOT EXISTS (SELECT 1 FROM t WHERE n > 5) AS b",
  },
  { id: "PAR-in-01", kind: "parity", sql: "SELECT 2 IN (1, 2, 3) AS a, 5 NOT IN (1, 2, 3) AS b" },
  {
    id: "PAR-multi-01",
    kind: "exec",
    sql: "CREATE TABLE m (n int); INSERT INTO m VALUES (1); INSERT INTO m VALUES (2)",
  },
  {
    id: "PAR-syntax-01",
    kind: "error",
    sql: "SELEC 1",
    query: true,
    messageTier: "B",
    notes: "both raise 42601; memory adds an unrecognized-statement hint and lowercases the token",
  },
  {
    id: "PAR-syntax-02",
    kind: "error",
    sql: "SELECT (1 + 2",
    query: true,
    messageTier: "B",
    notes: "both raise 42601 at end of input; memory names the expected token",
  },
  {
    id: "PAR-syntax-03",
    kind: "error",
    sql: "SELECT 1, FROM x",
    query: true,
    messageTier: "B",
    notes: "both raise 42601; memory lowercases the offending keyword and adds a hint",
  },
  { id: "PAR-values-01", kind: "parity", sql: "VALUES (1, 'a'), (2, 'b')" },
  { id: "PAR-values-02", kind: "parity", sql: "SELECT * FROM (VALUES (1, 'x'), (2, 'y')) AS v(id, name) ORDER BY id" },
  {
    id: "PAR-distinct-01",
    kind: "parity",
    setup: ["CREATE TABLE t (n int)", "INSERT INTO t VALUES (1), (1), (2)"],
    sql: "SELECT DISTINCT n FROM t ORDER BY n",
  },
  {
    id: "PAR-ord-01",
    kind: "sequence",
    setup: ["CREATE TABLE t (n int)", "INSERT INTO t VALUES (2), (NULL), (1)"],
    steps: [
      { sql: "SELECT n FROM t ORDER BY n ASC NULLS FIRST", query: true },
      { sql: "SELECT n FROM t ORDER BY n DESC NULLS LAST", query: true },
    ],
  },
  {
    id: "PAR-grp-01",
    kind: "parity",
    setup: ["CREATE TABLE t (g text, n int)", "INSERT INTO t VALUES ('a', 1), ('a', 2), ('b', 3)"],
    sql: "SELECT g, sum(n) AS s FROM t GROUP BY g HAVING sum(n) > 2 ORDER BY g",
  },
  {
    id: "PAR-alias-01",
    kind: "parity",
    setup: ["CREATE TABLE t (n int)", "INSERT INTO t VALUES (1)"],
    sql: "SELECT t.n num, x.n FROM t, t x",
  },
  {
    id: "PAR-typedlit-01",
    kind: "parity",
    sql: "SELECT date '2024-06-01' AS d, timestamp '2024-06-01 12:30:00' AS ts",
  },
  { id: "PAR-typedlit-02", kind: "parity", sql: "SELECT interval '1 day' AS i, interval '2 hours 30 minutes' AS j" },
  { id: "PAR-typedlit-03", kind: "error", sql: "SELECT date 'not-a-date'", query: true, messageTier: "A" },
  { id: "PAR-param-01", kind: "parity", sql: "SELECT $1::int + $2::int AS v", params: [1, 2] },
  { id: "PAR-depth-01", kind: "parity", sql: "SELECT ((((((1)))))) AS v" },
  {
    id: "PAR-reserved-01",
    kind: "error",
    sql: "SELECT FROM WHERE",
    query: true,
    messageTier: "B",
    notes: "both raise 42601; memory lowercases the offending keyword and adds an expected-identifier hint",
  },
  {
    id: "PAR-neg-01",
    kind: "parity",
    sql: "SELECT - -5 AS v",
  },
]);
