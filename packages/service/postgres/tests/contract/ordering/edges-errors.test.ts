import { parity, queryErrorParity } from "../helpers.ts";

const t = ["CREATE TABLE t (a int, b text)", "INSERT INTO t VALUES (2, 'x'), (1, 'y'), (3, 'w')"];

// edges
parity("order by same key twice", t, "SELECT a FROM t ORDER BY a, a DESC");
parity("order by case expression", t, "SELECT a, b FROM t ORDER BY CASE WHEN b = 'y' THEN 0 ELSE 1 END, a");
parity(
  "order by alias shadowing column",
  ["CREATE TABLE s (a int, b int)", "INSERT INTO s VALUES (1, 9), (2, 3)"],
  "SELECT a, b AS a2 FROM s ORDER BY a2",
);
parity(
  "order by applies after distinct",
  ["CREATE TABLE s (v int)", "INSERT INTO s VALUES (3), (1), (3), (2)"],
  "SELECT DISTINCT v FROM s ORDER BY v DESC",
);
parity(
  "order by in subquery then outer order",
  ["CREATE TABLE s (v int)", "INSERT INTO s VALUES (5), (1), (4)"],
  "SELECT v FROM (SELECT v FROM s ORDER BY v DESC) sub ORDER BY v ASC",
);
parity(
  "order by mixed directions",
  ["CREATE TABLE s (a int, b int)", "INSERT INTO s VALUES (1, 1), (1, 2), (2, 1), (2, 2)"],
  "SELECT a, b FROM s ORDER BY a ASC, b DESC",
);
parity(
  "order by group key and aggregate",
  ["CREATE TABLE s (k text, v int)", "INSERT INTO s VALUES ('a', 1), ('b', 5), ('a', 2), ('b', 1)"],
  "SELECT k, sum(v) AS total FROM s GROUP BY k ORDER BY sum(v) DESC, k",
);
parity(
  "order by using operator explicit",
  ["CREATE TABLE s (v int)", "INSERT INTO s VALUES (2), (1), (3)"],
  "SELECT v FROM s ORDER BY v USING <",
);

// errors
queryErrorParity("order by ordinal zero", t, "SELECT a FROM t ORDER BY 0", undefined);
queryErrorParity("order by ordinal out of range", t, "SELECT a FROM t ORDER BY 5", undefined);
queryErrorParity("order by undefined column", t, "SELECT a FROM t ORDER BY zz", "undefined_column");
