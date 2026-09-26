import { parity } from "../helpers.ts";

const orders = [
  "CREATE TABLE customers (id int, name text)",
  "CREATE TABLE orders (id int, customer_id int, amount int)",
  "INSERT INTO customers VALUES (1, 'alice'), (2, 'bob'), (3, 'carol')",
  "INSERT INTO orders VALUES (10, 1, 100), (11, 1, 50), (12, 2, 75), (13, NULL, 20)",
];

parity(
  "inner join on",
  orders,
  "SELECT c.name, o.amount FROM customers c JOIN orders o ON c.id = o.customer_id ORDER BY c.name, o.amount",
);
parity(
  "inner join explicit keyword",
  orders,
  "SELECT c.name, o.amount FROM customers c INNER JOIN orders o ON c.id = o.customer_id ORDER BY c.name, o.amount",
);
parity(
  "left join keeps unmatched left rows",
  orders,
  "SELECT c.name, o.amount FROM customers c LEFT JOIN orders o ON c.id = o.customer_id ORDER BY c.name, o.amount NULLS LAST",
);
parity(
  "left outer join keyword",
  orders,
  "SELECT c.name, o.id FROM customers c LEFT OUTER JOIN orders o ON c.id = o.customer_id ORDER BY c.name, o.id NULLS LAST",
);
parity(
  "right join keeps unmatched right rows",
  orders,
  "SELECT c.name, o.amount FROM customers c RIGHT JOIN orders o ON c.id = o.customer_id ORDER BY o.amount, c.name NULLS LAST",
);
parity(
  "full join keeps both sides",
  orders,
  "SELECT c.name, o.amount FROM customers c FULL JOIN orders o ON c.id = o.customer_id ORDER BY c.name NULLS LAST, o.amount NULLS LAST",
);
parity(
  "full outer join keyword",
  orders,
  "SELECT c.id, o.id AS oid FROM customers c FULL OUTER JOIN orders o ON c.id = o.customer_id ORDER BY c.id NULLS LAST, oid NULLS LAST",
);
parity(
  "cross join",
  [
    "CREATE TABLE a (x int)",
    "CREATE TABLE b (y text)",
    "INSERT INTO a VALUES (1), (2)",
    "INSERT INTO b VALUES ('p'), ('q')",
  ],
  "SELECT x, y FROM a CROSS JOIN b ORDER BY x, y",
);
parity(
  "join with additional on condition",
  orders,
  "SELECT c.name, o.amount FROM customers c JOIN orders o ON c.id = o.customer_id AND o.amount > 60 ORDER BY c.name, o.amount",
);
parity(
  "left join with filtering on condition",
  orders,
  "SELECT c.name, o.amount FROM customers c LEFT JOIN orders o ON c.id = o.customer_id AND o.amount > 60 ORDER BY c.name, o.amount NULLS LAST",
);
parity(
  "join then where filters after join",
  orders,
  "SELECT c.name, o.amount FROM customers c LEFT JOIN orders o ON c.id = o.customer_id WHERE o.amount IS NULL ORDER BY c.name",
);
parity(
  "join on inequality",
  ["CREATE TABLE n (v int)", "INSERT INTO n VALUES (1), (2), (3)"],
  "SELECT a.v AS av, b.v AS bv FROM n a JOIN n b ON a.v < b.v ORDER BY av, bv",
);
parity(
  "join with expression keys",
  [
    "CREATE TABLE a (x int)",
    "CREATE TABLE b (y int)",
    "INSERT INTO a VALUES (1), (2), (3)",
    "INSERT INTO b VALUES (2), (4), (6)",
  ],
  "SELECT a.x, b.y FROM a JOIN b ON a.x * 2 = b.y ORDER BY a.x",
);
parity(
  "join empty right table",
  ["CREATE TABLE a (x int)", "CREATE TABLE b (y int)", "INSERT INTO a VALUES (1), (2)"],
  "SELECT a.x, b.y FROM a LEFT JOIN b ON a.x = b.y ORDER BY a.x",
);
parity(
  "join on true",
  ["CREATE TABLE a (x int)", "CREATE TABLE b (y int)", "INSERT INTO a VALUES (1)", "INSERT INTO b VALUES (9)"],
  "SELECT x, y FROM a JOIN b ON true ORDER BY x, y",
);
