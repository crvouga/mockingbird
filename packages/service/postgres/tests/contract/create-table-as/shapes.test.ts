import { parity, parityTyped, sequenceParity } from "../helpers.ts";

parity(
  "CTAS from join",
  [
    "CREATE TABLE a (id int, v text)",
    "INSERT INTO a VALUES (1, 'x'), (2, 'y')",
    "CREATE TABLE b (id int, n int)",
    "INSERT INTO b VALUES (1, 10), (2, 20)",
    "CREATE TABLE joined AS SELECT a.id, a.v, b.n FROM a JOIN b ON a.id = b.id",
  ],
  "SELECT id, v, n FROM joined ORDER BY id",
);

parity(
  "CTAS with DISTINCT",
  [
    "CREATE TABLE src (v int)",
    "INSERT INTO src VALUES (1), (1), (2), (2), (3)",
    "CREATE TABLE uniq AS SELECT DISTINCT v FROM src",
  ],
  "SELECT v FROM uniq ORDER BY v",
);

parity(
  "CTAS with ORDER BY and LIMIT",
  [
    "CREATE TABLE src (n int)",
    "INSERT INTO src VALUES (5), (1), (9), (3)",
    "CREATE TABLE top2 AS SELECT n FROM src ORDER BY n DESC LIMIT 2",
  ],
  "SELECT n FROM top2 ORDER BY n",
);

parity(
  "CTAS from UNION",
  [
    "CREATE TABLE a (n int)",
    "INSERT INTO a VALUES (1), (2)",
    "CREATE TABLE b (n int)",
    "INSERT INTO b VALUES (2), (3)",
    "CREATE TABLE u AS SELECT n FROM a UNION SELECT n FROM b",
  ],
  "SELECT n FROM u ORDER BY n",
);

parityTyped(
  "CTAS preserves column types",
  [
    "CREATE TABLE src (i int, b bigint, t text, r numeric)",
    "INSERT INTO src VALUES (1, 2, 'x', 1.5)",
    "CREATE TABLE copy AS SELECT * FROM src",
  ],
  "SELECT i, b, t, r FROM copy",
);

sequenceParity(
  "CTAS does not copy constraints",
  ["CREATE TABLE src (id int PRIMARY KEY)", "INSERT INTO src VALUES (1)"],
  [
    { sql: "CREATE TABLE copy AS SELECT * FROM src" },
    { sql: "INSERT INTO copy VALUES (1)" },
    { sql: "SELECT id FROM copy ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "CTAS snapshot is independent of source",
  ["CREATE TABLE src (id int)", "INSERT INTO src VALUES (1)"],
  [
    { sql: "CREATE TABLE copy AS SELECT * FROM src" },
    { sql: "INSERT INTO src VALUES (2)" },
    { sql: "SELECT id FROM copy ORDER BY id", query: true },
    { sql: "SELECT id FROM src ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

parity(
  "CTAS from CTE",
  [
    "CREATE TABLE src (n int)",
    "INSERT INTO src VALUES (1), (2), (3)",
    "CREATE TABLE evens AS WITH e AS (SELECT n FROM src WHERE n % 2 = 0) SELECT n FROM e",
  ],
  "SELECT n FROM evens ORDER BY n",
);
