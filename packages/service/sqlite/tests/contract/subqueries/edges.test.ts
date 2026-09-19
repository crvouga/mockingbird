import { parity } from "../helpers.ts";

const data = [
  "CREATE TABLE users(id INTEGER,name TEXT)",
  "CREATE TABLE orders(id INTEGER,user_id INTEGER,total INTEGER)",
  "INSERT INTO users VALUES (1,'Ada'),(2,'Bob'),(3,'Cy')",
  "INSERT INTO orders VALUES (10,1,20),(11,1,30),(12,2,5)",
];
parity(
  "correlated EXISTS can reference the outer row",
  data,
  "SELECT u.name FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id=u.id AND o.total>10) ORDER BY u.id",
);
parity(
  "correlated NOT EXISTS finds unmatched rows",
  data,
  "SELECT u.name FROM users u WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id=u.id) ORDER BY u.id",
);
parity(
  "scalar subquery appears in SELECT projection",
  data,
  "SELECT name,(SELECT max(total) FROM orders) peak FROM users ORDER BY id",
);
parity(
  "scalar correlated aggregate returns one value per row",
  data,
  "SELECT name,(SELECT sum(total) FROM orders o WHERE o.user_id=users.id) spent FROM users ORDER BY id",
);
parity(
  "IN SELECT applies projected membership",
  data,
  "SELECT name FROM users WHERE id IN (SELECT user_id FROM orders WHERE total<10) ORDER BY id",
);
parity(
  "empty IN (SELECT) matches no rows",
  ["CREATE TABLE t(v INTEGER)", "INSERT INTO t VALUES (1),(2)", "CREATE TABLE empty(v INTEGER)"],
  "SELECT v FROM t WHERE v IN (SELECT v FROM empty) ORDER BY v",
);
parity(
  "empty NOT IN (SELECT) keeps all candidates",
  ["CREATE TABLE t(v INTEGER)", "INSERT INTO t VALUES (1),(2)", "CREATE TABLE empty(v INTEGER)"],
  "SELECT v FROM t WHERE v NOT IN (SELECT v FROM empty) ORDER BY v",
);
parity(
  "multi-row scalar subquery returns first row (SQLite 3.51)",
  ["CREATE TABLE t(x INTEGER)", "INSERT INTO t VALUES (1),(2),(3)"],
  "SELECT (SELECT x FROM t ORDER BY x) AS v",
);
parity(
  "scalar subquery with no rows is NULL",
  ["CREATE TABLE t(x INTEGER)"],
  "SELECT (SELECT x FROM t) AS v, (SELECT x FROM t) IS NULL AS isn",
);
