import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "insert returning inside with",
  ["CREATE TABLE t (id int, v text)"],
  [
    {
      sql: "WITH ins AS (INSERT INTO t VALUES (1, 'a'), (2, 'b') RETURNING id) SELECT id FROM ins ORDER BY id",
      query: true,
    },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "update returning inside with",
  ["CREATE TABLE t (id int, v int)", "INSERT INTO t VALUES (1, 10), (2, 20), (3, 30)"],
  [
    {
      sql: "WITH upd AS (UPDATE t SET v = v + 1 WHERE id > 1 RETURNING id, v) SELECT id, v FROM upd ORDER BY id",
      query: true,
    },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "delete returning inside with",
  ["CREATE TABLE t (id int, v int)", "INSERT INTO t VALUES (1, 10), (2, 20), (3, 30)"],
  [
    { sql: "WITH del AS (DELETE FROM t WHERE v >= 20 RETURNING id) SELECT id FROM del ORDER BY id", query: true },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "move rows between tables",
  [
    "CREATE TABLE src (id int, v text)",
    "CREATE TABLE dst (id int, v text)",
    "INSERT INTO src VALUES (1, 'a'), (2, 'b'), (3, 'c')",
  ],
  [
    {
      sql: "WITH moved AS (DELETE FROM src WHERE id < 3 RETURNING id, v) INSERT INTO dst SELECT id, v FROM moved",
    },
    { sql: "SELECT * FROM src ORDER BY id", query: true },
    { sql: "SELECT * FROM dst ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "insert cte feeding select aggregation",
  ["CREATE TABLE t (v int)"],
  [
    {
      sql: "WITH ins AS (INSERT INTO t VALUES (5), (7), (9) RETURNING v) SELECT sum(v) AS total FROM ins",
      query: true,
    },
    { sql: "SELECT count(*) AS n FROM t", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "two modifying ctes in one statement",
  ["CREATE TABLE a (v int)", "CREATE TABLE b (v int)"],
  [
    {
      sql: "WITH ia AS (INSERT INTO a VALUES (1) RETURNING v), ib AS (INSERT INTO b VALUES (2) RETURNING v) SELECT ia.v + ib.v AS s FROM ia, ib",
      query: true,
    },
    { sql: "SELECT (SELECT count(*) FROM a) AS na, (SELECT count(*) FROM b) AS nb", query: true },
  ],
  { compareFinalState: true },
);
