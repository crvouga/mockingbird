import { parity, sequenceParity } from "../helpers.ts";

sequenceParity(
  "CREATE TABLE AS SELECT copies query results",
  ["CREATE TABLE src(id INTEGER, name TEXT)", "INSERT INTO src VALUES (1,'a'),(2,'b')"],
  [{ sql: "CREATE TABLE dst AS SELECT id, name FROM src" }, { sql: "SELECT * FROM dst ORDER BY id", query: true }],
);

parity(
  "CREATE TABLE AS SELECT preserves expression aliases",
  ["CREATE TABLE t AS SELECT 1 AS x, 'hi' AS y"],
  "SELECT x, y FROM t",
);
