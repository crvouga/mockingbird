import { parity } from "../helpers.ts";

const orders = [
  "CREATE TABLE customers (id int, name text)",
  "CREATE TABLE orders (id int, customer_id int, amount int)",
  "INSERT INTO customers VALUES (1, 'alice'), (2, 'bob'), (3, 'carol')",
  "INSERT INTO orders VALUES (10, 1, 100), (11, 1, 50), (12, 2, 75)",
];

parity(
  "left join lateral keeps rows without matches",
  orders,
  "SELECT c.name, o.amount FROM customers c LEFT JOIN LATERAL (SELECT amount FROM orders WHERE customer_id = c.id) o ON true ORDER BY c.name, o.amount NULLS LAST",
);
parity(
  "left join lateral top-1 pattern",
  orders,
  "SELECT c.name, o.amount FROM customers c LEFT JOIN LATERAL (SELECT amount FROM orders WHERE customer_id = c.id ORDER BY amount DESC LIMIT 1) o ON true ORDER BY c.name",
);
parity(
  "left join lateral with extra on condition",
  orders,
  "SELECT c.name, o.amount FROM customers c LEFT JOIN LATERAL (SELECT amount FROM orders WHERE customer_id = c.id) o ON o.amount > 60 ORDER BY c.name, o.amount NULLS LAST",
);
parity(
  "left join lateral empty inner table",
  ["CREATE TABLE c (id int)", "CREATE TABLE o (cid int, v int)", "INSERT INTO c VALUES (1), (2)"],
  "SELECT c.id, o.v FROM c LEFT JOIN LATERAL (SELECT v FROM o WHERE cid = c.id) o ON true ORDER BY c.id",
);
parity(
  "left join lateral aggregate per row",
  orders,
  "SELECT c.name, s.cnt FROM customers c LEFT JOIN LATERAL (SELECT count(*) AS cnt FROM orders WHERE customer_id = c.id) s ON true ORDER BY c.name",
);
parity(
  "lateral top-2 per group",
  [
    "CREATE TABLE g (id int)",
    "CREATE TABLE v (gid int, score int)",
    "INSERT INTO g VALUES (1), (2)",
    "INSERT INTO v VALUES (1, 10), (1, 30), (1, 20), (2, 5)",
  ],
  "SELECT g.id, t.score FROM g LEFT JOIN LATERAL (SELECT score FROM v WHERE gid = g.id ORDER BY score DESC LIMIT 2) t ON true ORDER BY g.id, t.score DESC NULLS LAST",
);
parity(
  "left join lateral referencing multiple outer columns",
  [
    "CREATE TABLE r (lo int, hi int)",
    "CREATE TABLE n (v int)",
    "INSERT INTO r VALUES (1, 3), (5, 6), (8, 9)",
    "INSERT INTO n VALUES (1), (2), (3), (4), (5)",
  ],
  "SELECT r.lo, r.hi, m.v FROM r LEFT JOIN LATERAL (SELECT v FROM n WHERE v BETWEEN r.lo AND r.hi) m ON true ORDER BY r.lo, m.v NULLS LAST",
);
