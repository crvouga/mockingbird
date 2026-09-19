import { parity, sequenceParity } from "../helpers.ts";

parity(
  "generated stored column computes on insert",
  [
    "CREATE TABLE t (a int, b int, total int GENERATED ALWAYS AS (a + b) STORED)",
    "INSERT INTO t (a, b) VALUES (1, 2), (10, 20)",
  ],
  "SELECT a, b, total FROM t ORDER BY a",
);

parity(
  "generated text expression",
  [
    "CREATE TABLE people (first text, last text, full_name text GENERATED ALWAYS AS (first || ' ' || last) STORED)",
    "INSERT INTO people (first, last) VALUES ('Ada', 'Lovelace')",
  ],
  "SELECT first, last, full_name FROM people",
);

parity(
  "generated column with function",
  [
    "CREATE TABLE t (v text, len int GENERATED ALWAYS AS (length(v)) STORED)",
    "INSERT INTO t (v) VALUES ('abc'), ('hello')",
  ],
  "SELECT v, len FROM t ORDER BY v",
);

parity(
  "generated column from null input is null",
  ["CREATE TABLE t (a int, doubled int GENERATED ALWAYS AS (a * 2) STORED)", "INSERT INTO t (a) VALUES (NULL), (3)"],
  "SELECT a, doubled FROM t ORDER BY a NULLS LAST",
);

sequenceParity(
  "generated recomputes on update",
  [
    "CREATE TABLE t (id int, a int, b int, total int GENERATED ALWAYS AS (a + b) STORED)",
    "INSERT INTO t (id, a, b) VALUES (1, 1, 1)",
  ],
  [
    { sql: "UPDATE t SET a = 100 WHERE id = 1" },
    { sql: "SELECT id, a, b, total FROM t", query: true },
    { sql: "UPDATE t SET b = 50 WHERE id = 1" },
    { sql: "SELECT id, a, b, total FROM t", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "generated column visible in RETURNING",
  ["CREATE TABLE t (a int, sq int GENERATED ALWAYS AS (a * a) STORED)"],
  [
    { sql: "INSERT INTO t (a) VALUES (4) RETURNING a, sq", query: true },
    { sql: "UPDATE t SET a = 5 RETURNING a, sq", query: true },
  ],
  { compareFinalState: true },
);

parity(
  "generated with CASE expression",
  [
    "CREATE TABLE t (n int, sign text GENERATED ALWAYS AS (CASE WHEN n < 0 THEN 'neg' WHEN n > 0 THEN 'pos' ELSE 'zero' END) STORED)",
    "INSERT INTO t (n) VALUES (-5), (0), (5)",
  ],
  "SELECT n, sign FROM t ORDER BY n",
);

parity(
  "generated column omitted from wildcard-free insert",
  ["CREATE TABLE t (a int, b int GENERATED ALWAYS AS (a + 1) STORED, c int)", "INSERT INTO t (a, c) VALUES (1, 3)"],
  "SELECT a, b, c FROM t",
);
