import { parity } from "../helpers.ts";

const shop = [
  "CREATE TABLE customers (id int, name text)",
  "CREATE TABLE orders (id int, customer_id int, amount int)",
  "INSERT INTO customers VALUES (1, 'alice'), (2, 'bob'), (3, 'carol')",
  "INSERT INTO orders VALUES (10, 1, 100), (11, 1, 50), (12, 2, 75)",
];

parity(
  "exists correlated",
  shop,
  "SELECT name FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id) ORDER BY name",
);
parity(
  "not exists correlated",
  shop,
  "SELECT name FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id) ORDER BY name",
);
parity(
  "exists with condition inside",
  shop,
  "SELECT name FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.amount > 60) ORDER BY name",
);
parity(
  "uncorrelated exists true",
  shop,
  "SELECT name FROM customers WHERE EXISTS (SELECT 1 FROM orders) ORDER BY name",
);
parity(
  "uncorrelated exists false",
  shop,
  "SELECT name FROM customers WHERE EXISTS (SELECT 1 FROM orders WHERE amount > 1000) ORDER BY name",
);
parity(
  "exists in select list",
  shop,
  "SELECT name, EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = customers.id) AS has_orders FROM customers ORDER BY name",
);
parity(
  "exists ignores select list contents",
  shop,
  "SELECT name FROM customers c WHERE EXISTS (SELECT NULL FROM orders o WHERE o.customer_id = c.id) ORDER BY name",
);
parity(
  "nested exists",
  [
    "CREATE TABLE a (id int)",
    "CREATE TABLE b (id int, a_id int)",
    "CREATE TABLE c (id int, b_id int)",
    "INSERT INTO a VALUES (1), (2)",
    "INSERT INTO b VALUES (10, 1), (11, 2)",
    "INSERT INTO c VALUES (100, 10)",
  ],
  "SELECT a.id FROM a WHERE EXISTS (SELECT 1 FROM b WHERE b.a_id = a.id AND EXISTS (SELECT 1 FROM c WHERE c.b_id = b.id)) ORDER BY a.id",
);
parity(
  "exists combined with other predicates",
  shop,
  "SELECT name FROM customers c WHERE c.id > 1 AND EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id) ORDER BY name",
);
parity(
  "exists on empty table",
  ["CREATE TABLE a (id int)", "CREATE TABLE b (id int)", "INSERT INTO a VALUES (1)"],
  "SELECT id FROM a WHERE EXISTS (SELECT 1 FROM b)",
);
