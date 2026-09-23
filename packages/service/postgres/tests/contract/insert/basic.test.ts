import { parity, sequenceParity } from "../helpers.ts";

parity(
  "multi-row VALUES insert",
  ["CREATE TABLE t (id int, name text)", "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')"],
  "SELECT id, name FROM t ORDER BY id",
);

parity(
  "column subset leaves others null",
  ["CREATE TABLE t (id int, name text, score int)", "INSERT INTO t (id) VALUES (1), (2)"],
  "SELECT id, name, score FROM t ORDER BY id",
);

parity(
  "column subset fills defaults",
  ["CREATE TABLE t (id int, name text DEFAULT 'anon', score int DEFAULT 0)", "INSERT INTO t (id) VALUES (7)"],
  "SELECT id, name, score FROM t ORDER BY id",
);

parity(
  "columns listed out of order",
  ["CREATE TABLE t (a int, b text, c int)", "INSERT INTO t (c, a, b) VALUES (3, 1, 'two')"],
  "SELECT a, b, c FROM t",
);

parity(
  "INSERT ... SELECT",
  [
    "CREATE TABLE src (id int, v text)",
    "INSERT INTO src VALUES (1, 'x'), (2, 'y'), (3, 'z')",
    "CREATE TABLE dst (id int, v text)",
    "INSERT INTO dst SELECT id, v FROM src WHERE id > 1",
  ],
  "SELECT id, v FROM dst ORDER BY id",
);

parity(
  "INSERT from VALUES subquery",
  ["CREATE TABLE t (a int, b text)", "INSERT INTO t SELECT * FROM (VALUES (1, 'one'), (2, 'two')) AS v(a, b)"],
  "SELECT a, b FROM t ORDER BY a",
);

parity(
  "DEFAULT VALUES",
  ["CREATE TABLE t (id int DEFAULT 42, name text DEFAULT 'dv')", "INSERT INTO t DEFAULT VALUES"],
  "SELECT id, name FROM t",
);

parity(
  "DEFAULT keyword in VALUES list",
  [
    "CREATE TABLE t (id int, name text DEFAULT 'unnamed', score int DEFAULT -1)",
    "INSERT INTO t VALUES (1, DEFAULT, 10), (2, 'named', DEFAULT)",
  ],
  "SELECT id, name, score FROM t ORDER BY id",
);

parity(
  "expression values",
  ["CREATE TABLE t (a int, b text, c int)", "INSERT INTO t VALUES (1 + 2, upper('ab') || 'c', abs(-5))"],
  "SELECT a, b, c FROM t",
);

parity(
  "explicit NULL insert",
  ["CREATE TABLE t (id int, name text)", "INSERT INTO t VALUES (1, NULL), (NULL, 'x')"],
  "SELECT id, name FROM t ORDER BY id NULLS LAST",
);

parity(
  "insert with parameters",
  ["CREATE TABLE t (id int, name text)"],
  "INSERT INTO t VALUES ($1, $2) RETURNING id, name",
  [5, "param"],
);

sequenceParity(
  "insert accumulates rows across statements",
  ["CREATE TABLE t (id int, v text)"],
  [
    { sql: "INSERT INTO t VALUES (1, 'a')" },
    { sql: "INSERT INTO t VALUES (2, 'b'), (3, 'c')" },
    { sql: "INSERT INTO t (id) VALUES (4)" },
    { sql: "SELECT count(*) FROM t", query: true },
    { sql: "SELECT id, v FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "insert select from same table",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1), (2)"],
  [{ sql: "INSERT INTO t SELECT id + 10 FROM t" }, { sql: "SELECT id FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);
