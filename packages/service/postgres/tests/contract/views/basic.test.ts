import { parity, sequenceParity } from "../helpers.ts";

parity(
  "simple view",
  [
    "CREATE TABLE t (id int, v text)",
    "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')",
    "CREATE VIEW big AS SELECT id, v FROM t WHERE id > 1",
  ],
  "SELECT id, v FROM big ORDER BY id",
);

parity(
  "view with expressions and aliases",
  [
    "CREATE TABLE t (n int)",
    "INSERT INTO t VALUES (1), (2)",
    "CREATE VIEW derived AS SELECT n, n * 10 AS scaled FROM t",
  ],
  "SELECT n, scaled FROM derived ORDER BY n",
);

parity(
  "view column aliases in definition",
  [
    "CREATE TABLE t (a int, b text)",
    "INSERT INTO t VALUES (1, 'x')",
    "CREATE VIEW v (num, label) AS SELECT a, b FROM t",
  ],
  "SELECT num, label FROM v",
);

sequenceParity(
  "view reflects underlying table changes",
  ["CREATE TABLE t (id int)", "CREATE VIEW v AS SELECT id FROM t"],
  [
    { sql: "SELECT count(*) FROM v", query: true },
    { sql: "INSERT INTO t VALUES (1), (2)" },
    { sql: "SELECT id FROM v ORDER BY id", query: true },
    { sql: "DELETE FROM t WHERE id = 1" },
    { sql: "SELECT id FROM v ORDER BY id", query: true },
  ],
);

sequenceParity(
  "CREATE OR REPLACE swaps definition",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1), (2), (3)", "CREATE VIEW v AS SELECT id FROM t WHERE id < 2"],
  [
    { sql: "SELECT id FROM v ORDER BY id", query: true },
    { sql: "CREATE OR REPLACE VIEW v AS SELECT id FROM t WHERE id >= 2" },
    { sql: "SELECT id FROM v ORDER BY id", query: true },
  ],
);

parity(
  "view on view",
  [
    "CREATE TABLE t (n int)",
    "INSERT INTO t VALUES (1), (2), (3), (4)",
    "CREATE VIEW evens AS SELECT n FROM t WHERE n % 2 = 0",
    "CREATE VIEW big_evens AS SELECT n FROM evens WHERE n > 2",
  ],
  "SELECT n FROM big_evens ORDER BY n",
);

parity(
  "view with aggregate",
  [
    "CREATE TABLE sales (region text, amount int)",
    "INSERT INTO sales VALUES ('n', 10), ('n', 20), ('s', 5)",
    "CREATE VIEW totals AS SELECT region, sum(amount) AS total FROM sales GROUP BY region",
  ],
  "SELECT region, total FROM totals ORDER BY region",
);

parity(
  "view with join",
  [
    "CREATE TABLE a (id int, v text)",
    "INSERT INTO a VALUES (1, 'x')",
    "CREATE TABLE b (id int, n int)",
    "INSERT INTO b VALUES (1, 10)",
    "CREATE VIEW j AS SELECT a.id, a.v, b.n FROM a JOIN b ON a.id = b.id",
  ],
  "SELECT id, v, n FROM j",
);

sequenceParity(
  "DROP VIEW removes it",
  ["CREATE TABLE t (id int)", "CREATE VIEW v AS SELECT id FROM t"],
  [{ sql: "DROP VIEW v" }, { sql: "SELECT count(*) FROM t", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "DROP VIEW IF EXISTS on missing view",
  ["CREATE TABLE t (id int)"],
  [{ sql: "DROP VIEW IF EXISTS ghost" }, { sql: "SELECT count(*) FROM t", query: true }],
  { compareFinalState: true },
);
