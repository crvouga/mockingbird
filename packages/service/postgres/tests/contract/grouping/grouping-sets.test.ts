import { parity } from "../helpers.ts";

const sales = [
  "CREATE TABLE sales (region text, product text, amount int)",
  "INSERT INTO sales VALUES ('east', 'a', 10), ('east', 'b', 20), ('west', 'a', 30), ('west', 'b', 40)",
];

parity(
  "grouping sets basic",
  sales,
  "SELECT region, product, sum(amount) AS total FROM sales GROUP BY GROUPING SETS ((region), (product)) ORDER BY region NULLS LAST, product NULLS LAST",
);
parity(
  "grouping sets with grand total",
  sales,
  "SELECT region, product, sum(amount) AS total FROM sales GROUP BY GROUPING SETS ((region, product), (region), ()) ORDER BY region NULLS LAST, product NULLS LAST",
);
parity(
  "rollup",
  sales,
  "SELECT region, product, sum(amount) AS total FROM sales GROUP BY ROLLUP (region, product) ORDER BY region NULLS LAST, product NULLS LAST",
);
parity(
  "rollup single column",
  sales,
  "SELECT region, sum(amount) AS total FROM sales GROUP BY ROLLUP (region) ORDER BY region NULLS LAST",
);
parity(
  "cube",
  sales,
  "SELECT region, product, sum(amount) AS total FROM sales GROUP BY CUBE (region, product) ORDER BY region NULLS LAST, product NULLS LAST",
);
parity(
  "grouping function distinguishes null group from null data",
  ["CREATE TABLE t (k text, v int)", "INSERT INTO t VALUES ('a', 1), (NULL, 2), ('b', 3)"],
  "SELECT k, GROUPING(k) AS g, sum(v) AS total FROM t GROUP BY ROLLUP (k) ORDER BY g, k NULLS LAST",
);
parity(
  "grouping function multiple args",
  sales,
  "SELECT region, product, GROUPING(region, product) AS g, sum(amount) AS total FROM sales GROUP BY CUBE (region, product) ORDER BY g, region NULLS LAST, product NULLS LAST",
);
parity(
  "grouping sets duplicate set",
  sales,
  "SELECT region, sum(amount) AS total FROM sales GROUP BY GROUPING SETS ((region), (region)) ORDER BY region",
);
parity(
  "rollup with having on grouping",
  sales,
  "SELECT region, product, sum(amount) AS total FROM sales GROUP BY ROLLUP (region, product) HAVING GROUPING(product) = 1 ORDER BY region NULLS LAST",
);
parity(
  "mixed group by and rollup",
  sales,
  "SELECT region, product, sum(amount) AS total FROM sales GROUP BY region, ROLLUP (product) ORDER BY region, product NULLS LAST",
);
