/** Regressions for fuzz-found bugs: per-group aggregate typing and IN over empty sets. */
import { parity, queryErrorParity } from "../helpers.ts";

const GT = ["CREATE TABLE gt (g int, v int)", "INSERT INTO gt VALUES (0, NULL), (1, 20)"];
const SUB = [
  "CREATE TABLE s (g int, a int)",
  "INSERT INTO s VALUES (1, 5), (1, NULL)",
  "CREATE TABLE t2 (id int, g int)",
  "INSERT INTO t2 VALUES (1, 1), (2, 9)",
];

parity(
  "sum() FILTER over a fully-filtered group returns NULL with a numeric-compatible column",
  GT,
  "SELECT g, sum(v) FILTER (WHERE v > 0) AS x FROM gt GROUP BY g ORDER BY g",
);

parity(
  "min/max FILTER over mixed empty and non-empty groups keep the argument type",
  GT,
  "SELECT g, min(v) FILTER (WHERE v > 0) AS lo, max(v) FILTER (WHERE v > 0) AS hi FROM gt GROUP BY g ORDER BY g",
);

parity(
  "correlated scalar sum over an empty set is NULL",
  SUB,
  "SELECT t2.id, (SELECT sum(s.a) FROM s WHERE s.g = t2.g) AS m FROM t2 ORDER BY t2.id",
);

parity(
  "correlated scalar min with NULLs in the aggregated column",
  SUB,
  "SELECT t2.id, (SELECT min(s.a) FROM s WHERE s.g = t2.g) AS m FROM t2 ORDER BY t2.id",
);

parity(
  "NULL IN an empty subquery is false",
  SUB,
  "SELECT NULL::int IN (SELECT a FROM s WHERE false) AS a, NULL::int NOT IN (SELECT a FROM s WHERE false) AS b",
);

parity(
  "NULL IN a non-empty subquery stays NULL",
  SUB,
  "SELECT (NULL::int IN (SELECT a FROM s)) IS NULL AS a, (NULL::int NOT IN (SELECT a FROM s)) IS NULL AS b",
);

parity(
  "FULL JOIN accepts equijoin variants",
  [
    "CREATE TABLE l (x int, y int)",
    "CREATE TABLE r (x int, y int)",
    "INSERT INTO l VALUES (1, 2)",
    "INSERT INTO r VALUES (1, 3), (5, 6)",
  ],
  "SELECT l.x AS lx, r.x AS rx FROM l FULL JOIN r ON l.x + 0 = r.x ORDER BY lx NULLS LAST, rx NULLS LAST",
);

queryErrorParity(
  "FULL JOIN rejects non-equijoin conditions",
  ["CREATE TABLE l (x int)", "CREATE TABLE r (x int)"],
  "SELECT count(*) FROM l FULL JOIN r ON l.x <> r.x",
  "unsupported",
);

queryErrorParity(
  "FULL JOIN rejects OR-of-equalities conditions",
  ["CREATE TABLE l (x int, y int)", "CREATE TABLE r (x int, y int)"],
  "SELECT count(*) FROM l FULL JOIN r ON l.x = r.x OR l.y = r.y",
  "unsupported",
);
