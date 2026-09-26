import { parity } from "../helpers.ts";

parity(
  "row value equality",
  ["CREATE TABLE t(a INT, b INT)", "INSERT INTO t VALUES (1,2),(1,3),(2,2)"],
  "SELECT a,b FROM t WHERE (a,b) = (1,2)",
);
parity(
  "row value inequality",
  ["CREATE TABLE t(a INT, b INT)", "INSERT INTO t VALUES (1,2),(1,3),(2,2)"],
  "SELECT a,b FROM t WHERE (a,b) < (1,3) ORDER BY a,b",
);
parity(
  "row value IN list",
  ["CREATE TABLE t(a INT, b INT)", "INSERT INTO t VALUES (1,2),(3,4),(5,6)"],
  "SELECT a,b FROM t WHERE (a,b) IN ((1,2),(5,6)) ORDER BY a",
);
parity(
  "row value IS NULL component",
  ["CREATE TABLE t(a INT, b INT)", "INSERT INTO t VALUES (1,NULL),(NULL,2),(1,2)"],
  "SELECT a,b FROM t WHERE (a,b) IS (1, NULL)",
);
parity("arrow operator precedence vs multiply", [], `SELECT '{"a":2}' -> '$.a' * 3 AS v`);
parity("arrow extract then arithmetic with parens", [], `SELECT ('{"a":2}' ->> '$.a') + 1 AS v`);
