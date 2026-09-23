import { parity } from "../helpers.ts";

const data = [
  "CREATE TABLE users(id INTEGER,name TEXT)",
  "CREATE TABLE orders(id INTEGER,user_id INTEGER,total INTEGER)",
  "INSERT INTO users VALUES (1,'Ada'),(2,'Bob'),(3,'Cy')",
  "INSERT INTO orders VALUES (10,1,20),(11,1,30),(12,2,5)",
];

parity(
  "scalar subquery returns one value",
  data,
  "SELECT name,(SELECT max(total) FROM orders) AS maximum FROM users ORDER BY id",
);
parity(
  "IN subquery filters membership",
  data,
  "SELECT name FROM users WHERE id IN (SELECT user_id FROM orders WHERE total>=20) ORDER BY name",
);
parity(
  "EXISTS subquery tests row presence",
  data,
  "SELECT name FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id=u.id) ORDER BY name",
);
parity(
  "FROM subquery exposes projected columns",
  data,
  "SELECT x.user_id,x.spent FROM (SELECT user_id,sum(total) spent FROM orders GROUP BY user_id) x ORDER BY x.user_id",
);
parity(
  "correlated scalar subquery evaluates per row",
  data,
  "SELECT u.name,(SELECT count(*) FROM orders o WHERE o.user_id=u.id) n FROM users u ORDER BY u.id",
);
