import { expect } from "bun:test";
import { matrixBoth } from "../../harness/index.ts";
import { errorParity, parity, sequenceParity } from "../helpers.ts";

parity(
  "MATERIALIZED and NOT MATERIALIZED CTE hints are accepted",
  [],
  "WITH a(x) AS MATERIALIZED (VALUES(1),(2)), b(y) AS NOT MATERIALIZED (SELECT x+10 FROM a) SELECT * FROM b ORDER BY y",
);

parity(
  "nested WITH clauses resolve their local CTEs",
  [],
  "WITH outer_cte(x) AS (WITH inner_cte(y) AS (VALUES(2),(3)) SELECT y*10 FROM inner_cte) SELECT x FROM outer_cte ORDER BY x",
);

sequenceParity(
  "INSERT SELECT reads rows from a CTE",
  ["CREATE TABLE target(v INTEGER)"],
  [
    { sql: "WITH source(v) AS (VALUES(3),(1),(2)) INSERT INTO target SELECT * FROM source" },
    { sql: "SELECT v FROM target ORDER BY v", query: true },
  ],
);

errorParity(
  "INSERT SELECT reports a CTE column-count mismatch",
  ["CREATE TABLE target(a INTEGER,b INTEGER)"],
  "WITH source(v) AS (VALUES(1)) INSERT INTO target SELECT * FROM source",
);

matrixBoth("NOT MATERIALIZED random() CTE is always materialized in sqlite-mem", (memory, sqlite) => {
  const sql =
    "WITH c(r) AS NOT MATERIALIZED (SELECT random() AS r) SELECT (SELECT r FROM c) = (SELECT r FROM c) AS same";
  const actual = memory.query(sql);
  const oracle = sqlite.query(sql);
  expect(actual.ok && oracle.ok).toBe(true);
  expect(actual.rows[0]?.same).toBe(1);
  if (oracle.rows[0]?.same === 1) {
    expect(actual.values).toEqual(oracle.values);
  } else {
    expect(oracle.rows[0]?.same).toBe(0);
  }
});
