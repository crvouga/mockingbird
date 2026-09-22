import { parity, sequenceParity } from "../helpers.ts";

sequenceParity(
  "SET single column with WHERE",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')"],
  [{ sql: "UPDATE t SET v = 'updated' WHERE id = 2" }, { sql: "SELECT id, v FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "SET multiple columns",
  ["CREATE TABLE t (id int, a int, b text)", "INSERT INTO t VALUES (1, 10, 'x'), (2, 20, 'y')"],
  [
    { sql: "UPDATE t SET a = a + 1, b = b || '!' WHERE id = 1" },
    { sql: "SELECT id, a, b FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "update all rows",
  ["CREATE TABLE t (id int, flag boolean)", "INSERT INTO t VALUES (1, false), (2, false), (3, true)"],
  [{ sql: "UPDATE t SET flag = true" }, { sql: "SELECT id, flag FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "no-match update changes zero rows",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a')"],
  [{ sql: "UPDATE t SET v = 'never' WHERE id = 99" }, { sql: "SELECT id, v FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "SET expression referencing old value",
  ["CREATE TABLE t (id int, n int)", "INSERT INTO t VALUES (1, 5), (2, 10)"],
  [{ sql: "UPDATE t SET n = n * n + id" }, { sql: "SELECT id, n FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "SET (a, b) = row syntax",
  ["CREATE TABLE t (id int, a int, b text)", "INSERT INTO t VALUES (1, 0, '')"],
  [
    { sql: "UPDATE t SET (a, b) = (42, 'row') WHERE id = 1" },
    { sql: "SELECT id, a, b FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "SET (a, b) = scalar subquery",
  [
    "CREATE TABLE t (id int, a int, b text)",
    "INSERT INTO t VALUES (1, 0, '')",
    "CREATE TABLE s (x int, y text)",
    "INSERT INTO s VALUES (7, 'from-s')",
  ],
  [
    { sql: "UPDATE t SET (a, b) = (SELECT x, y FROM s) WHERE id = 1" },
    { sql: "SELECT id, a, b FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

parity(
  "update with parameters",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (2, 'b')"],
  "UPDATE t SET v = $1 WHERE id = $2 RETURNING id, v",
  ["patched", 2],
);

sequenceParity(
  "swap columns in one statement",
  ["CREATE TABLE t (id int, a int, b int)", "INSERT INTO t VALUES (1, 10, 20)"],
  [{ sql: "UPDATE t SET a = b, b = a" }, { sql: "SELECT id, a, b FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "CASE expression in SET",
  ["CREATE TABLE t (id int, grade text)", "INSERT INTO t VALUES (1, NULL), (2, NULL), (3, NULL)"],
  [
    { sql: "UPDATE t SET grade = CASE WHEN id < 2 THEN 'low' WHEN id < 3 THEN 'mid' ELSE 'high' END" },
    { sql: "SELECT id, grade FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "WHERE with IN subquery",
  [
    "CREATE TABLE t (id int, v text)",
    "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')",
    "CREATE TABLE pick (id int)",
    "INSERT INTO pick VALUES (1), (3)",
  ],
  [
    { sql: "UPDATE t SET v = 'picked' WHERE id IN (SELECT id FROM pick)" },
    { sql: "SELECT id, v FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);
