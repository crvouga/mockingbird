import { parity } from "../helpers.ts";

const sales = [
  "CREATE TABLE sales (id int, region text, product text, amount int)",
  "INSERT INTO sales VALUES (1, 'east', 'a', 10), (2, 'east', 'b', 20), (3, 'west', 'a', 30), (4, 'west', 'a', 40), (5, 'east', 'a', 50)",
];

parity(
  "having on aggregate",
  sales,
  "SELECT region, count(*) AS n FROM sales GROUP BY region HAVING count(*) > 2 ORDER BY region",
);
parity(
  "having on sum",
  sales,
  "SELECT region, sum(amount) AS total FROM sales GROUP BY region HAVING sum(amount) >= 70 ORDER BY region",
);
parity("having filters all groups", sales, "SELECT region FROM sales GROUP BY region HAVING count(*) > 100");
parity(
  "having on group key",
  sales,
  "SELECT region, count(*) AS n FROM sales GROUP BY region HAVING region = 'east' ORDER BY region",
);
parity(
  "having combined with where",
  sales,
  "SELECT region, count(*) AS n FROM sales WHERE amount > 10 GROUP BY region HAVING count(*) >= 2 ORDER BY region",
);
parity(
  "having with multiple conditions",
  sales,
  "SELECT region, sum(amount) AS total FROM sales GROUP BY region HAVING sum(amount) > 50 AND count(*) >= 2 ORDER BY region",
);
parity("having without group by", sales, "SELECT count(*) AS n FROM sales HAVING count(*) > 3");
parity("having without group by filters out", sales, "SELECT count(*) AS n FROM sales HAVING count(*) > 100");
parity(
  "having with aggregate not in select list",
  sales,
  "SELECT region FROM sales GROUP BY region HAVING max(amount) = 50 ORDER BY region",
);
parity(
  "having with avg comparison",
  sales,
  "SELECT product, avg(amount) AS a FROM sales GROUP BY product HAVING avg(amount) > 20 ORDER BY product",
);
