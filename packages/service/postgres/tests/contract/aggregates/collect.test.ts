import { parity } from "../helpers.ts";

const t = [
  "CREATE TABLE t (id int, v int, s text)",
  "INSERT INTO t VALUES (1, 10, 'a'), (2, 20, 'b'), (3, 10, 'c'), (4, NULL, 'd')",
];

// string_agg
parity("string_agg with order by", t, "SELECT string_agg(s, ',' ORDER BY s) AS agg FROM t");
parity("string_agg desc order", t, "SELECT string_agg(s, '-' ORDER BY s DESC) AS agg FROM t");
parity("string_agg by expression order", t, "SELECT string_agg(s, ',' ORDER BY id DESC) AS agg FROM t");
parity(
  "string_agg skips nulls",
  ["CREATE TABLE s (v text)", "INSERT INTO s VALUES ('a'), (NULL), ('b')"],
  "SELECT string_agg(v, '+' ORDER BY v) AS agg FROM s",
);
parity("string_agg empty input is null", ["CREATE TABLE s (v text)"], "SELECT string_agg(v, ',') AS agg FROM s");
parity("string_agg empty separator", t, "SELECT string_agg(s, '' ORDER BY s) AS agg FROM t");
parity(
  "string_agg per group",
  t,
  "SELECT v, string_agg(s, ',' ORDER BY s) AS agg FROM t GROUP BY v ORDER BY v NULLS LAST",
);

// array_agg
parity("array_agg with order by", t, "SELECT array_agg(v ORDER BY v NULLS LAST) AS agg FROM t");
parity(
  "array_agg includes nulls",
  ["CREATE TABLE s (v int)", "INSERT INTO s VALUES (1), (NULL), (2)"],
  "SELECT array_agg(v ORDER BY v NULLS FIRST) AS agg FROM s",
);
parity("array_agg of text", t, "SELECT array_agg(s ORDER BY s) AS agg FROM t");
parity("array_agg empty input is null", ["CREATE TABLE s (v int)"], "SELECT array_agg(v) AS agg FROM s");
parity("array_agg per group", t, "SELECT v, array_agg(s ORDER BY s) AS agg FROM t GROUP BY v ORDER BY v NULLS LAST");

// DISTINCT inside aggregates
parity("sum distinct", t, "SELECT sum(DISTINCT v) AS s FROM t");
parity("array_agg distinct ordered", t, "SELECT array_agg(DISTINCT v ORDER BY v NULLS LAST) AS agg FROM t");
parity(
  "string_agg distinct",
  ["CREATE TABLE s (v text)", "INSERT INTO s VALUES ('a'), ('b'), ('a')"],
  "SELECT string_agg(DISTINCT v, ',' ORDER BY v) AS agg FROM s",
);
parity(
  "avg distinct",
  ["CREATE TABLE s (v int)", "INSERT INTO s VALUES (10), (10), (20)"],
  "SELECT avg(DISTINCT v) AS a FROM s",
);

// json aggregates
parity("jsonb_agg ordered", t, "SELECT jsonb_agg(v ORDER BY v NULLS LAST) AS agg FROM t");
parity("jsonb_agg of text", t, "SELECT jsonb_agg(s ORDER BY s) AS agg FROM t");
parity("json_object_agg", t, "SELECT json_object_agg(s, v ORDER BY s) AS agg FROM t");
parity("jsonb_object_agg", t, "SELECT jsonb_object_agg(s, v ORDER BY s) AS agg FROM t");
parity("jsonb_agg empty input is null", ["CREATE TABLE s (v int)"], "SELECT jsonb_agg(v) AS agg FROM s");
