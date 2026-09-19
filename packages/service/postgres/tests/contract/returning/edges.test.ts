import { parity } from "../helpers.ts";

parity(
  "multi-row INSERT RETURNING preserves insertion order",
  ["CREATE TABLE t (id int, v text)"],
  "INSERT INTO t VALUES (3, 'c'), (1, 'a'), (2, 'b') RETURNING id, v",
);

parity(
  "INSERT ... SELECT RETURNING",
  ["CREATE TABLE src (id int)", "INSERT INTO src VALUES (1), (2)", "CREATE TABLE dst (id int)"],
  "INSERT INTO dst SELECT id * 10 FROM src ORDER BY id RETURNING id",
);

parity(
  "RETURNING with CASE expression",
  ["CREATE TABLE t (id int)"],
  "INSERT INTO t VALUES (1), (10) RETURNING CASE WHEN id >= 10 THEN 'big' ELSE 'small' END AS size",
);

parity("RETURNING qualified column", ["CREATE TABLE t (id int)"], "INSERT INTO t VALUES (7) RETURNING t.id");

parity(
  "RETURNING generated identity across statements",
  ["CREATE TABLE t (id int GENERATED ALWAYS AS IDENTITY, v text)", "INSERT INTO t (v) VALUES ('first')"],
  "INSERT INTO t (v) VALUES ('second') RETURNING id, v",
);

parity(
  "DELETE RETURNING expression on deleted values",
  ["CREATE TABLE t (id int, n int)", "INSERT INTO t VALUES (1, 100), (2, 200)"],
  "DELETE FROM t RETURNING id + n AS total",
);

parity(
  "UPDATE RETURNING all rows updated",
  ["CREATE TABLE t (id int, n int)", "INSERT INTO t VALUES (1, 1), (2, 2), (3, 3)"],
  "UPDATE t SET n = n * 10 RETURNING id, n",
);

parity(
  "RETURNING NULL-valued columns",
  ["CREATE TABLE t (id int, v text)"],
  "INSERT INTO t (id) VALUES (1) RETURNING id, v",
);

parity(
  "RETURNING with parameter in expression",
  ["CREATE TABLE t (id int)"],
  "INSERT INTO t VALUES (5) RETURNING id + $1::int AS bumped",
  [100],
);
