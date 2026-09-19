import { sequenceParity } from "../helpers.ts";

// Postgres updates each target row at most once even when the FROM join yields
// multiple matches. Cases here keep the assigned value identical across
// matches so results stay deterministic.

sequenceParity(
  "duplicate source rows update target once",
  [
    "CREATE TABLE t (id int, v int)",
    "INSERT INTO t VALUES (1, 0)",
    "CREATE TABLE s (tid int, x int)",
    "INSERT INTO s VALUES (1, 5), (1, 5), (1, 5)",
  ],
  [{ sql: "UPDATE t SET v = s.x FROM s WHERE t.id = s.tid" }, { sql: "SELECT id, v FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "changes counts one per target row not per join row",
  [
    "CREATE TABLE t (id int, v int)",
    "INSERT INTO t VALUES (1, 0), (2, 0)",
    "CREATE TABLE s (tid int, x int)",
    "INSERT INTO s VALUES (1, 9), (1, 9), (2, 9)",
  ],
  [{ sql: "UPDATE t SET v = s.x FROM s WHERE t.id = s.tid" }, { sql: "SELECT id, v FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "increment applied once despite multiple matches",
  [
    "CREATE TABLE t (id int, n int)",
    "INSERT INTO t VALUES (1, 100)",
    "CREATE TABLE s (tid int)",
    "INSERT INTO s VALUES (1), (1)",
  ],
  [
    { sql: "UPDATE t SET n = n + 1 FROM s WHERE t.id = s.tid" },
    { sql: "SELECT id, n FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "DELETE USING duplicate matches deletes each row once",
  [
    "CREATE TABLE t (id int)",
    "INSERT INTO t VALUES (1), (2), (3)",
    "CREATE TABLE s (tid int)",
    "INSERT INTO s VALUES (1), (1), (2), (2), (2)",
  ],
  [{ sql: "DELETE FROM t USING s WHERE t.id = s.tid" }, { sql: "SELECT id FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

sequenceParity(
  "UPDATE FROM cross join hits every target row once",
  [
    "CREATE TABLE t (id int, v int)",
    "INSERT INTO t VALUES (1, 0), (2, 0)",
    "CREATE TABLE s (x int)",
    "INSERT INTO s VALUES (7), (7)",
  ],
  [{ sql: "UPDATE t SET v = s.x FROM s" }, { sql: "SELECT id, v FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);
