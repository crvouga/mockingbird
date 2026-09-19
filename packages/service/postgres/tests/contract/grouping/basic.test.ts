import { parity } from "../helpers.ts";

const sales = [
  "CREATE TABLE sales (id int, region text, product text, amount int)",
  "INSERT INTO sales VALUES (1, 'east', 'a', 10), (2, 'east', 'b', 20), (3, 'west', 'a', 30), (4, 'west', 'a', 40), (5, 'east', 'a', 50)",
];

parity("group by single column", sales, "SELECT region, count(*) AS n FROM sales GROUP BY region ORDER BY region");
parity(
  "group by two columns",
  sales,
  "SELECT region, product, sum(amount) AS total FROM sales GROUP BY region, product ORDER BY region, product",
);
parity(
  "group by with where",
  sales,
  "SELECT region, count(*) AS n FROM sales WHERE amount > 15 GROUP BY region ORDER BY region",
);
parity(
  "group by expression",
  sales,
  "SELECT amount % 20 AS bucket, count(*) AS n FROM sales GROUP BY amount % 20 ORDER BY bucket",
);
parity("group by ordinal", sales, "SELECT region, sum(amount) AS total FROM sales GROUP BY 1 ORDER BY region");
parity("group by output alias", sales, "SELECT upper(region) AS r, count(*) AS n FROM sales GROUP BY r ORDER BY r");
parity(
  "group by null values group together",
  ["CREATE TABLE t (k int, v int)", "INSERT INTO t VALUES (NULL, 1), (NULL, 2), (1, 3)"],
  "SELECT k, count(*) AS n FROM t GROUP BY k ORDER BY k NULLS LAST",
);
parity("group by empty table", ["CREATE TABLE t (k int, v int)"], "SELECT k, count(*) FROM t GROUP BY k");
parity("group by all rows one group", sales, "SELECT count(*) AS n, sum(amount) AS total FROM sales");
parity("group key not in select list", sales, "SELECT sum(amount) AS total FROM sales GROUP BY region ORDER BY total");
parity(
  "group by over join",
  [
    "CREATE TABLE u (id int, name text)",
    "CREATE TABLE o (uid int, amount int)",
    "INSERT INTO u VALUES (1, 'alice'), (2, 'bob')",
    "INSERT INTO o VALUES (1, 10), (1, 20), (2, 5)",
  ],
  "SELECT u.name, sum(o.amount) AS total FROM u JOIN o ON o.uid = u.id GROUP BY u.name ORDER BY u.name",
);
parity(
  "group by constant expression from column",
  sales,
  "SELECT region || '!' AS r, count(*) AS n FROM sales GROUP BY region || '!' ORDER BY r",
);
parity(
  "count distinct in group",
  sales,
  "SELECT region, count(DISTINCT product) AS products FROM sales GROUP BY region ORDER BY region",
);
