import { execParity, parity, sequenceParity } from "../helpers.ts";

parity(
  "parameter in a WHERE clause",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')"],
  "SELECT id, v FROM t WHERE id > $1 ORDER BY id",
  [1],
);

parity(
  "text parameter matching a column",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (2, 'b')"],
  "SELECT id FROM t WHERE v = $1",
  ["b"],
);

parity(
  "null parameter comparison yields no rows",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a')"],
  "SELECT id FROM t WHERE v = $1",
  [null],
);

parity(
  "parameter with IS NOT DISTINCT FROM matches nulls",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, NULL), (2, 'x')"],
  "SELECT id FROM t WHERE v IS NOT DISTINCT FROM $1 ORDER BY id",
  [null],
);

execParity(
  "INSERT with parameters reports the row count",
  ["CREATE TABLE t (id int, v text)"],
  "INSERT INTO t VALUES ($1, $2)",
  [1, "a"],
);

execParity(
  "UPDATE with parameters reports the affected count",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (2, 'b')"],
  "UPDATE t SET v = $1 WHERE id = $2",
  ["z", 1],
);

execParity(
  "DELETE with a parameter reports the affected count",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1), (2), (3)"],
  "DELETE FROM t WHERE id >= $1",
  [2],
);

sequenceParity(
  "parameterized steps in a session flow",
  ["CREATE TABLE t (id int, v text)"],
  [
    { sql: "INSERT INTO t VALUES ($1, $2)", params: [1, "one"] },
    { sql: "INSERT INTO t VALUES ($1, $2)", params: [2, "two"] },
    { sql: "UPDATE t SET v = $1 WHERE id = $2", params: ["deux", 2] },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
    { sql: "SELECT v FROM t WHERE id = $1", query: true, params: [2] },
  ],
  { compareFinalState: true },
);

parity(
  "parameter inside an expression with a column",
  ["CREATE TABLE t (n int)", "INSERT INTO t VALUES (10), (20)"],
  "SELECT n + $1::int AS bumped FROM t ORDER BY n",
  [5],
);

parity(
  "parameter in LIMIT",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1), (2), (3), (4)"],
  "SELECT id FROM t ORDER BY id LIMIT $1",
  [2],
);

parity(
  "parameter compared with LIKE",
  ["CREATE TABLE t (v text)", "INSERT INTO t VALUES ('apple'), ('banana'), ('apricot')"],
  "SELECT v FROM t WHERE v LIKE $1 ORDER BY v",
  ["ap%"],
);
