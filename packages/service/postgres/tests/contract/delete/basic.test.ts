import { parity, sequenceParity } from "../helpers.ts";

sequenceParity(
  "DELETE with WHERE",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')"],
  [{ sql: "DELETE FROM t WHERE id = 2" }, { sql: "SELECT id, v FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "DELETE all rows",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1), (2), (3)"],
  [{ sql: "DELETE FROM t" }, { sql: "SELECT count(*) FROM t", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "no-match delete changes zero rows",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
  [{ sql: "DELETE FROM t WHERE id = 99" }, { sql: "SELECT id FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

parity(
  "delete with parameter",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (2, 'b')"],
  "DELETE FROM t WHERE id = $1 RETURNING id, v",
  [1],
);

sequenceParity(
  "DELETE with IN subquery",
  [
    "CREATE TABLE t (id int, v text)",
    "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')",
    "CREATE TABLE doomed (id int)",
    "INSERT INTO doomed VALUES (1), (3)",
  ],
  [
    { sql: "DELETE FROM t WHERE id IN (SELECT id FROM doomed)" },
    { sql: "SELECT id, v FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "DELETE with expression predicate",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1), (2), (3), (4), (5)"],
  [{ sql: "DELETE FROM t WHERE id % 2 = 0" }, { sql: "SELECT id FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "DELETE with BETWEEN",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1), (2), (3), (4), (5)"],
  [{ sql: "DELETE FROM t WHERE id BETWEEN 2 AND 4" }, { sql: "SELECT id FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "delete then reinsert",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'old')"],
  [
    { sql: "DELETE FROM t WHERE id = 1" },
    { sql: "INSERT INTO t VALUES (1, 'new')" },
    { sql: "SELECT id, v FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "DELETE with NOT EXISTS",
  [
    "CREATE TABLE parent (id int)",
    "INSERT INTO parent VALUES (1)",
    "CREATE TABLE child (id int, pid int)",
    "INSERT INTO child VALUES (10, 1), (11, 2)",
  ],
  [
    { sql: "DELETE FROM child WHERE NOT EXISTS (SELECT 1 FROM parent WHERE parent.id = child.pid)" },
    { sql: "SELECT id, pid FROM child ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);
