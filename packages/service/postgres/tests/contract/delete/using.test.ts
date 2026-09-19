import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "DELETE USING join",
  [
    "CREATE TABLE orders (id int, customer_id int)",
    "INSERT INTO orders VALUES (1, 10), (2, 20), (3, 10)",
    "CREATE TABLE customers (id int, banned boolean)",
    "INSERT INTO customers VALUES (10, true), (20, false)",
  ],
  [
    { sql: "DELETE FROM orders USING customers WHERE orders.customer_id = customers.id AND customers.banned" },
    { sql: "SELECT id, customer_id FROM orders ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "DELETE USING with alias",
  [
    "CREATE TABLE t (id int)",
    "INSERT INTO t VALUES (1), (2), (3)",
    "CREATE TABLE kill (id int)",
    "INSERT INTO kill VALUES (2)",
  ],
  [{ sql: "DELETE FROM t USING kill AS k WHERE t.id = k.id" }, { sql: "SELECT id FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "DELETE USING multiple matches deletes row once",
  [
    "CREATE TABLE t (id int)",
    "INSERT INTO t VALUES (1), (2)",
    "CREATE TABLE s (tid int)",
    "INSERT INTO s VALUES (1), (1), (1)",
  ],
  [{ sql: "DELETE FROM t USING s WHERE t.id = s.tid" }, { sql: "SELECT id FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "DELETE USING two source tables",
  [
    "CREATE TABLE t (id int)",
    "INSERT INTO t VALUES (1), (2), (3)",
    "CREATE TABLE a (id int)",
    "INSERT INTO a VALUES (1), (2)",
    "CREATE TABLE b (id int)",
    "INSERT INTO b VALUES (2), (3)",
  ],
  [
    { sql: "DELETE FROM t USING a, b WHERE t.id = a.id AND t.id = b.id" },
    { sql: "SELECT id FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "DELETE USING with no matches",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)", "CREATE TABLE s (id int)", "INSERT INTO s VALUES (99)"],
  [{ sql: "DELETE FROM t USING s WHERE t.id = s.id" }, { sql: "SELECT id FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "DELETE USING with extra predicate",
  [
    "CREATE TABLE t (id int, grp text)",
    "INSERT INTO t VALUES (1, 'x'), (2, 'x'), (3, 'y')",
    "CREATE TABLE s (id int)",
    "INSERT INTO s VALUES (1), (2), (3)",
  ],
  [
    { sql: "DELETE FROM t USING s WHERE t.id = s.id AND t.grp = 'x'" },
    { sql: "SELECT id, grp FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);
