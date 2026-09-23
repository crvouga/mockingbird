import { parity, sequenceParity } from "../helpers.ts";

parity(
  "CTAS from SELECT",
  [
    "CREATE TABLE src (id int, v text)",
    "INSERT INTO src VALUES (1, 'a'), (2, 'b'), (3, 'c')",
    "CREATE TABLE copy AS SELECT id, v FROM src WHERE id > 1",
  ],
  "SELECT id, v FROM copy ORDER BY id",
);

parity(
  "CTAS from VALUES",
  ["CREATE TABLE t AS SELECT * FROM (VALUES (1, 'one'), (2, 'two')) AS v(id, name)"],
  "SELECT id, name FROM t ORDER BY id",
);

parity(
  "CTAS with expressions and aliases",
  [
    "CREATE TABLE src (n int)",
    "INSERT INTO src VALUES (1), (2)",
    "CREATE TABLE derived AS SELECT n, n * n AS square FROM src",
  ],
  "SELECT n, square FROM derived ORDER BY n",
);

parity(
  "CTAS WITH NO DATA creates empty table with shape",
  [
    "CREATE TABLE src (id int, v text)",
    "INSERT INTO src VALUES (1, 'a')",
    "CREATE TABLE empty_copy AS SELECT * FROM src WITH NO DATA",
  ],
  "SELECT count(*) FROM empty_copy",
);

parity(
  "CTAS column name overrides",
  [
    "CREATE TABLE src (a int, b text)",
    "INSERT INTO src VALUES (1, 'x')",
    "CREATE TABLE renamed (col1, col2) AS SELECT a, b FROM src",
  ],
  "SELECT col1, col2 FROM renamed",
);

sequenceParity(
  "CTAS result is a normal table",
  ["CREATE TABLE src (id int)", "INSERT INTO src VALUES (1)"],
  [
    { sql: "CREATE TABLE t AS SELECT id FROM src" },
    { sql: "INSERT INTO t VALUES (2)" },
    { sql: "UPDATE t SET id = id + 10" },
    { sql: "SELECT id FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "CTAS from aggregate query",
  ["CREATE TABLE sales (region text, amount int)", "INSERT INTO sales VALUES ('n', 10), ('n', 20), ('s', 5)"],
  [
    { sql: "CREATE TABLE totals AS SELECT region, sum(amount) AS total FROM sales GROUP BY region" },
    { sql: "SELECT region, total FROM totals ORDER BY region", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "CTAS WITH NO DATA then fill",
  ["CREATE TABLE src (id int, v text)", "INSERT INTO src VALUES (1, 'a')"],
  [
    { sql: "CREATE TABLE t AS SELECT * FROM src WITH NO DATA" },
    { sql: "INSERT INTO t SELECT * FROM src" },
    { sql: "SELECT id, v FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);
