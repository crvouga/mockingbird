import { parity, sequenceParity } from "../helpers.ts";

parity(
  "generated depending on two columns updated together",
  [
    "CREATE TABLE rect (w int, h int, area int GENERATED ALWAYS AS (w * h) STORED)",
    "INSERT INTO rect (w, h) VALUES (2, 3)",
  ],
  "SELECT w, h, area FROM rect",
);

sequenceParity(
  "swap-style update recomputes from new values",
  ["CREATE TABLE t (a int, b int, diff int GENERATED ALWAYS AS (a - b) STORED)", "INSERT INTO t (a, b) VALUES (10, 3)"],
  [{ sql: "UPDATE t SET a = b, b = a" }, { sql: "SELECT a, b, diff FROM t", query: true }],
  { compareFinalState: true },
);

parity(
  "generated column in WHERE clause",
  ["CREATE TABLE t (n int, sq int GENERATED ALWAYS AS (n * n) STORED)", "INSERT INTO t (n) VALUES (1), (2), (3), (4)"],
  "SELECT n, sq FROM t WHERE sq > 5 ORDER BY n",
);

parity(
  "generated column usable in aggregates",
  ["CREATE TABLE t (n int, sq int GENERATED ALWAYS AS (n * n) STORED)", "INSERT INTO t (n) VALUES (1), (2), (3)"],
  "SELECT sum(sq) AS total, max(sq) AS biggest FROM t",
);

sequenceParity(
  "generated with numeric cast expression",
  [
    "CREATE TABLE t (cents int, dollars numeric GENERATED ALWAYS AS ((cents / 100.0)::numeric(10,2)) STORED)",
    "INSERT INTO t (cents) VALUES (150), (99)",
  ],
  [
    { sql: "SELECT cents, dollars FROM t ORDER BY cents", query: true },
    { sql: "UPDATE t SET cents = 200 WHERE cents = 150" },
    { sql: "SELECT cents, dollars FROM t ORDER BY cents", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "insert via column-subset multi-row keeps generation per row",
  ["CREATE TABLE t (a int, b int, s int GENERATED ALWAYS AS (a + b) STORED)"],
  [
    { sql: "INSERT INTO t (a, b) VALUES (1, 1), (2, 2), (3, 3)" },
    { sql: "SELECT a, b, s FROM t ORDER BY a", query: true },
  ],
  { compareFinalState: true },
);

parity(
  "generated not-null constraint enforced",
  [
    "CREATE TABLE t (v text, up text GENERATED ALWAYS AS (upper(v)) STORED NOT NULL)",
    "INSERT INTO t (v) VALUES ('ok')",
  ],
  "SELECT v, up FROM t",
);
