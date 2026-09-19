import { parity, queryErrorParity } from "../helpers.ts";

// UNION vs UNION ALL semantics
parity(
  "union all keeps duplicate work rows",
  ["CREATE TABLE edges (src int, dst int)", "INSERT INTO edges VALUES (1, 2), (2, 3), (1, 3)"],
  "WITH RECURSIVE reach(node) AS (SELECT 1 UNION ALL SELECT e.dst FROM edges e JOIN reach r ON e.src = r.node WHERE r.node < 3) SELECT node FROM reach ORDER BY node",
);
parity(
  "union dedups and terminates on repeats",
  ["CREATE TABLE edges (src int, dst int)", "INSERT INTO edges VALUES (1, 2), (2, 1)"],
  "WITH RECURSIVE reach(node) AS (SELECT 1 UNION SELECT e.dst FROM edges e JOIN reach r ON e.src = r.node) SELECT node FROM reach ORDER BY node",
);
parity(
  "union dedup on multi-column working set",
  [],
  "WITH RECURSIVE c(a, b) AS (SELECT 1, 1 UNION SELECT b, a FROM c) SELECT a, b FROM c ORDER BY a, b",
);
parity(
  "recursive with two ctes one plain",
  ["CREATE TABLE t (n int)", "INSERT INTO t VALUES (3)"],
  "WITH RECURSIVE lim AS (SELECT n FROM t), c(n) AS (SELECT 1 UNION ALL SELECT c.n + 1 FROM c, lim WHERE c.n < lim.n) SELECT n FROM c ORDER BY n",
);
parity(
  "two independent recursive ctes",
  [],
  "WITH RECURSIVE a(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM a WHERE n < 3), b(m) AS (SELECT 10 UNION ALL SELECT m + 10 FROM b WHERE m < 30) SELECT n, m FROM a, b ORDER BY n, m",
);
parity(
  "recursive cte consumed by aggregate",
  [],
  "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 50) SELECT count(*) AS cnt, min(n) AS mn, max(n) AS mx FROM c",
);
parity(
  "outer limit on recursive cte",
  [],
  "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 1000) SELECT n FROM c ORDER BY n LIMIT 5",
);

// errors
queryErrorParity(
  "recursive cte without column list referencing undefined column",
  [],
  "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT zz + 1 FROM c WHERE n < 3) SELECT * FROM c",
  "undefined_column",
);
