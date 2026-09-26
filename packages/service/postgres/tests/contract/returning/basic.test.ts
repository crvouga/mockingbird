import { parity, sequenceParity } from "../helpers.ts";

parity(
  "INSERT RETURNING *",
  ["CREATE TABLE t (id int, v text)"],
  "INSERT INTO t VALUES (1, 'a'), (2, 'b') RETURNING *",
);

parity(
  "INSERT RETURNING subset of columns",
  ["CREATE TABLE t (id int, v text, extra int)"],
  "INSERT INTO t VALUES (1, 'a', 10) RETURNING v, id",
);

parity(
  "INSERT RETURNING expressions and aliases",
  ["CREATE TABLE t (id int, v text)"],
  "INSERT INTO t VALUES (3, 'abc') RETURNING id * 2 AS doubled, upper(v) AS shout",
);

parity(
  "INSERT RETURNING includes defaults and serial",
  ["CREATE TABLE t (id serial, v text DEFAULT 'dv', n int)"],
  "INSERT INTO t (n) VALUES (1), (2) RETURNING id, v, n",
);

parity(
  "UPDATE RETURNING new values",
  ["CREATE TABLE t (id int, n int)", "INSERT INTO t VALUES (1, 10), (2, 20)"],
  "UPDATE t SET n = n + 1 WHERE id = 1 RETURNING id, n",
);

parity(
  "UPDATE RETURNING expression",
  ["CREATE TABLE t (id int, n int)", "INSERT INTO t VALUES (1, 10)"],
  "UPDATE t SET n = 99 WHERE id = 1 RETURNING n - id AS diff",
);

parity(
  "DELETE RETURNING deleted rows",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (2, 'b')"],
  "DELETE FROM t WHERE id = 2 RETURNING *",
);

parity(
  "DELETE RETURNING with no matches",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
  "DELETE FROM t WHERE id = 99 RETURNING id",
);

parity(
  "UPDATE RETURNING with no matches",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
  "UPDATE t SET id = 5 WHERE id = 99 RETURNING id",
);

sequenceParity(
  "RETURNING rows match final state",
  ["CREATE TABLE t (id int, v text)"],
  [
    { sql: "INSERT INTO t VALUES (1, 'a'), (2, 'b') RETURNING id, v", query: true },
    { sql: "UPDATE t SET v = v || '!' WHERE id = 1 RETURNING id, v", query: true },
    { sql: "DELETE FROM t WHERE id = 2 RETURNING id", query: true },
    { sql: "SELECT id, v FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);
