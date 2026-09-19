import { parity } from "../helpers.ts";

parity(
  "single CTE supplies rows",
  [],
  "WITH values_cte(x) AS (VALUES (3),(1),(2)) SELECT x FROM values_cte ORDER BY x",
);
parity(
  "CTE can aggregate base table",
  ["CREATE TABLE sales(g TEXT,v INTEGER)", "INSERT INTO sales VALUES ('a',1),('a',2),('b',5)"],
  "WITH totals AS (SELECT g,sum(v) total FROM sales GROUP BY g) SELECT * FROM totals ORDER BY g",
);
parity(
  "multiple CTEs can reference earlier CTEs",
  [],
  "WITH a(x) AS (VALUES (1),(2)),b(y) AS (SELECT x*10 FROM a) SELECT y FROM b ORDER BY y",
);
parity(
  "CTE shadows table with same name",
  ["CREATE TABLE data(v INTEGER)", "INSERT INTO data VALUES (99)"],
  "WITH data(v) AS (VALUES (1),(2)) SELECT v FROM data ORDER BY v",
);
