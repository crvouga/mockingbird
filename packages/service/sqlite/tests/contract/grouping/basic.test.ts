import { parity } from "../helpers.ts";

const data = [
  "CREATE TABLE sales(region TEXT,amount INTEGER)",
  "INSERT INTO sales VALUES ('east',10),('east',20),('west',7),('west',8),('north',40)",
];

parity(
  "GROUP BY partitions aggregate input",
  data,
  "SELECT region,count(*) n,sum(amount) total FROM sales GROUP BY region ORDER BY region",
);
parity("GROUP BY expression", data, "SELECT amount/10 bucket,count(*) n FROM sales GROUP BY amount/10 ORDER BY bucket");
parity(
  "HAVING filters aggregate groups",
  data,
  "SELECT region,sum(amount) total FROM sales GROUP BY region HAVING sum(amount)>=20 ORDER BY region",
);
parity(
  "HAVING can reference aggregate alias",
  data,
  "SELECT region,count(*) AS n FROM sales GROUP BY region HAVING n>1 ORDER BY region",
);
