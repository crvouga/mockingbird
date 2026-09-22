import { parity } from "../helpers.ts";

const three = [
  "CREATE TABLE users (id int, name text)",
  "CREATE TABLE orders (id int, user_id int)",
  "CREATE TABLE items (id int, order_id int, sku text)",
  "INSERT INTO users VALUES (1, 'alice'), (2, 'bob')",
  "INSERT INTO orders VALUES (10, 1), (11, 2), (12, 1)",
  "INSERT INTO items VALUES (100, 10, 'x'), (101, 10, 'y'), (102, 11, 'z')",
];

parity(
  "three-way inner join",
  three,
  "SELECT u.name, o.id AS oid, i.sku FROM users u JOIN orders o ON u.id = o.user_id JOIN items i ON o.id = i.order_id ORDER BY u.name, oid, i.sku",
);
parity(
  "three-way with left join tail",
  three,
  "SELECT u.name, o.id AS oid, i.sku FROM users u JOIN orders o ON u.id = o.user_id LEFT JOIN items i ON o.id = i.order_id ORDER BY u.name, oid, i.sku NULLS LAST",
);
parity(
  "left join chain preserves outer rows",
  [
    "CREATE TABLE a (id int)",
    "CREATE TABLE b (id int, a_id int)",
    "CREATE TABLE c (id int, b_id int)",
    "INSERT INTO a VALUES (1), (2)",
    "INSERT INTO b VALUES (10, 1)",
    "INSERT INTO c VALUES (100, 99)",
  ],
  "SELECT a.id, b.id AS bid, c.id AS cid FROM a LEFT JOIN b ON a.id = b.a_id LEFT JOIN c ON b.id = c.b_id ORDER BY a.id",
);
parity(
  "parenthesized join grouping",
  [
    "CREATE TABLE a (id int)",
    "CREATE TABLE b (id int)",
    "CREATE TABLE c (id int)",
    "INSERT INTO a VALUES (1), (2)",
    "INSERT INTO b VALUES (2), (3)",
    "INSERT INTO c VALUES (2), (4)",
  ],
  "SELECT a.id FROM a JOIN (b JOIN c ON b.id = c.id) ON a.id = b.id ORDER BY a.id",
);
parity(
  "self join",
  [
    "CREATE TABLE emp (id int, name text, manager_id int)",
    "INSERT INTO emp VALUES (1, 'ceo', NULL), (2, 'vp', 1), (3, 'eng', 2), (4, 'eng2', 2)",
  ],
  "SELECT e.name AS emp, m.name AS mgr FROM emp e JOIN emp m ON e.manager_id = m.id ORDER BY emp",
);
parity(
  "self left join includes root",
  ["CREATE TABLE emp (id int, name text, manager_id int)", "INSERT INTO emp VALUES (1, 'ceo', NULL), (2, 'vp', 1)"],
  "SELECT e.name AS emp, m.name AS mgr FROM emp e LEFT JOIN emp m ON e.manager_id = m.id ORDER BY emp",
);
parity(
  "self cross join pairs",
  ["CREATE TABLE n (v int)", "INSERT INTO n VALUES (1), (2), (3)"],
  "SELECT a.v AS x, b.v AS y FROM n a, n b WHERE a.v <> b.v ORDER BY x, y",
);
parity(
  "join subquery to table",
  ["CREATE TABLE t (id int, grp text)", "INSERT INTO t VALUES (1, 'a'), (2, 'a'), (3, 'b')"],
  "SELECT t.id, s.cnt FROM t JOIN (SELECT grp, count(*) AS cnt FROM t GROUP BY grp) s ON t.grp = s.grp ORDER BY t.id",
);
parity(
  "mixed comma and explicit join",
  [
    "CREATE TABLE a (x int)",
    "CREATE TABLE b (y int)",
    "CREATE TABLE c (z int)",
    "INSERT INTO a VALUES (1)",
    "INSERT INTO b VALUES (1)",
    "INSERT INTO c VALUES (1), (2)",
  ],
  "SELECT x, y, z FROM a, b JOIN c ON b.y = c.z ORDER BY x, y, z",
);
parity(
  "four-way join",
  [
    "CREATE TABLE t1 (id int)",
    "CREATE TABLE t2 (id int)",
    "CREATE TABLE t3 (id int)",
    "CREATE TABLE t4 (id int)",
    "INSERT INTO t1 VALUES (1), (2), (3)",
    "INSERT INTO t2 VALUES (2), (3), (4)",
    "INSERT INTO t3 VALUES (3), (4), (5)",
    "INSERT INTO t4 VALUES (3), (5), (7)",
  ],
  "SELECT t1.id FROM t1 JOIN t2 ON t1.id = t2.id JOIN t3 ON t2.id = t3.id JOIN t4 ON t3.id = t4.id ORDER BY t1.id",
);
