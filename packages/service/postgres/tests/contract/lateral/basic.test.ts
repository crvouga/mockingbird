import { parity } from "../helpers.ts";

const orders = [
  "CREATE TABLE customers (id int, name text)",
  "CREATE TABLE orders (id int, customer_id int, amount int)",
  "INSERT INTO customers VALUES (1, 'alice'), (2, 'bob'), (3, 'carol')",
  "INSERT INTO orders VALUES (10, 1, 100), (11, 1, 50), (12, 2, 75)",
];

parity(
  "lateral subquery referencing outer column",
  orders,
  "SELECT c.name, o.amount FROM customers c, LATERAL (SELECT amount FROM orders WHERE customer_id = c.id) o ORDER BY c.name, o.amount",
);
parity(
  "cross join lateral",
  orders,
  "SELECT c.name, top.amount FROM customers c CROSS JOIN LATERAL (SELECT amount FROM orders WHERE customer_id = c.id ORDER BY amount DESC LIMIT 1) top ORDER BY c.name",
);
parity(
  "lateral with computed columns",
  ["CREATE TABLE t (n int)", "INSERT INTO t VALUES (1), (2), (3)"],
  "SELECT t.n, l.double, l.square FROM t, LATERAL (SELECT t.n * 2 AS double, t.n * t.n AS square) l ORDER BY t.n",
);
parity(
  "lateral limit per outer row",
  orders,
  "SELECT c.name, o.amount FROM customers c JOIN LATERAL (SELECT amount FROM orders WHERE customer_id = c.id ORDER BY amount LIMIT 1) o ON true ORDER BY c.name",
);
parity(
  "lateral keyword optional for subquery not referencing outer",
  ["CREATE TABLE t (n int)", "INSERT INTO t VALUES (1), (2)"],
  "SELECT t.n, s.v FROM t, LATERAL (SELECT 10 AS v) s ORDER BY t.n",
);
parity(
  "nested lateral chain",
  ["CREATE TABLE t (n int)", "INSERT INTO t VALUES (1), (2)"],
  "SELECT t.n, a.x, b.y FROM t, LATERAL (SELECT t.n + 1 AS x) a, LATERAL (SELECT a.x * 10 AS y) b ORDER BY t.n",
);
parity(
  "lateral over values",
  ["CREATE TABLE t (n int)", "INSERT INTO t VALUES (1), (2)"],
  "SELECT t.n, v.m FROM t, LATERAL (VALUES (t.n), (t.n * 100)) v(m) ORDER BY t.n, v.m",
);
