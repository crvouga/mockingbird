import { parity, parityTyped } from "../helpers.ts";

const t = [
  "CREATE TABLE t (id int, v int, s text)",
  "INSERT INTO t VALUES (1, 10, 'a'), (2, 20, 'b'), (3, 30, 'a'), (4, NULL, 'c')",
];

parity("count star", t, "SELECT count(*) AS n FROM t");
parity("count column skips nulls", t, "SELECT count(v) AS n FROM t");
parity(
  "count distinct",
  ["CREATE TABLE s (v int)", "INSERT INTO s VALUES (1), (2), (2), (3), (NULL)"],
  "SELECT count(DISTINCT v) AS n FROM s",
);
parity("sum", t, "SELECT sum(v) AS s FROM t");
parity("avg", t, "SELECT avg(v) AS a FROM t");
parity("min max int", t, "SELECT min(v) AS mn, max(v) AS mx FROM t");
parity("min max text", t, "SELECT min(s) AS mn, max(s) AS mx FROM t");
parity("sum of expression", t, "SELECT sum(v * 2) AS s FROM t");
parity("avg numeric result", ["CREATE TABLE s (v int)", "INSERT INTO s VALUES (1), (2)"], "SELECT avg(v) AS a FROM s");
parity(
  "sum numeric column",
  ["CREATE TABLE s (v numeric)", "INSERT INTO s VALUES (1.5), (2.25)"],
  "SELECT sum(v) AS s FROM s",
);

// empty-input results
parity("count on empty table", ["CREATE TABLE e (v int)"], "SELECT count(*) AS n, count(v) AS nv FROM e");
parity("sum on empty table is null", ["CREATE TABLE e (v int)"], "SELECT sum(v) AS s FROM e");
parity(
  "avg min max on empty table",
  ["CREATE TABLE e (v int)"],
  "SELECT avg(v) AS a, min(v) AS mn, max(v) AS mx FROM e",
);
parity(
  "aggregates over all-null column",
  ["CREATE TABLE e (v int)", "INSERT INTO e VALUES (NULL), (NULL)"],
  "SELECT count(v) AS c, sum(v) AS s, avg(v) AS a FROM e",
);

// bool aggregates
const b = ["CREATE TABLE b (id int, f boolean)", "INSERT INTO b VALUES (1, true), (2, false), (3, true), (4, NULL)"];
parity("bool_and", b, "SELECT bool_and(f) AS v FROM b");
parity("bool_or", b, "SELECT bool_or(f) AS v FROM b");
parity("every is bool_and alias", b, "SELECT every(f) AS v FROM b");
parity(
  "bool_and all true",
  ["CREATE TABLE b (f boolean)", "INSERT INTO b VALUES (true), (true)"],
  "SELECT bool_and(f) AS a, bool_or(f) AS o FROM b",
);
parity(
  "bool aggregates empty input",
  ["CREATE TABLE b (f boolean)"],
  "SELECT bool_and(f) AS a, bool_or(f) AS o, every(f) AS e FROM b",
);

// types
parityTyped("count returns bigint", t, "SELECT count(*) AS n FROM t");
parityTyped("sum of int returns bigint", t, "SELECT sum(v) AS s FROM t");
parityTyped("avg of int returns numeric", t, "SELECT avg(v) AS a FROM t");
