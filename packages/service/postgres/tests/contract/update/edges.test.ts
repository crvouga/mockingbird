import { parity, sequenceParity } from "../helpers.ts";

sequenceParity(
  "assignment cast rounds numeric to int",
  ["CREATE TABLE t (id int, n int)", "INSERT INTO t VALUES (1, 0)"],
  [{ sql: "UPDATE t SET n = 3.7 WHERE id = 1" }, { sql: "SELECT id, n FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "assignment cast string literal to int",
  ["CREATE TABLE t (id int, n int)", "INSERT INTO t VALUES (1, 0)"],
  [{ sql: "UPDATE t SET n = '42' WHERE id = 1" }, { sql: "SELECT id, n FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "SET column to DEFAULT",
  ["CREATE TABLE t (id int, v text DEFAULT 'dflt')", "INSERT INTO t VALUES (1, 'explicit')"],
  [{ sql: "UPDATE t SET v = DEFAULT WHERE id = 1" }, { sql: "SELECT id, v FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "SET to DEFAULT without default yields null",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'x')"],
  [{ sql: "UPDATE t SET v = DEFAULT WHERE id = 1" }, { sql: "SELECT id, v FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "update primary key value",
  ["CREATE TABLE t (id int PRIMARY KEY, v text)", "INSERT INTO t VALUES (1, 'a'), (2, 'b')"],
  [{ sql: "UPDATE t SET id = 10 WHERE id = 1" }, { sql: "SELECT id, v FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "update to same value still counts",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (2, 'a')"],
  [{ sql: "UPDATE t SET v = 'a'" }, { sql: "SELECT id, v FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "scalar subquery in SET",
  [
    "CREATE TABLE t (id int, total int)",
    "INSERT INTO t VALUES (1, 0)",
    "CREATE TABLE nums (n int)",
    "INSERT INTO nums VALUES (1), (2), (3)",
  ],
  [
    { sql: "UPDATE t SET total = (SELECT sum(n) FROM nums) WHERE id = 1" },
    { sql: "SELECT id, total FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "correlated subquery in SET",
  [
    "CREATE TABLE t (id int, cnt int)",
    "INSERT INTO t VALUES (1, 0), (2, 0)",
    "CREATE TABLE items (tid int)",
    "INSERT INTO items VALUES (1), (1), (2)",
  ],
  [
    { sql: "UPDATE t SET cnt = (SELECT count(*) FROM items WHERE items.tid = t.id)" },
    { sql: "SELECT id, cnt FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "WHERE false updates nothing",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
  [{ sql: "UPDATE t SET id = 0 WHERE false" }, { sql: "SELECT id FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "toggle boolean with NOT",
  ["CREATE TABLE t (id int, flag boolean)", "INSERT INTO t VALUES (1, true), (2, false), (3, NULL)"],
  [{ sql: "UPDATE t SET flag = NOT flag" }, { sql: "SELECT id, flag FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

parity(
  "update where null comparison matches nothing",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, NULL)"],
  "UPDATE t SET v = 'set' WHERE v = NULL RETURNING id",
);
