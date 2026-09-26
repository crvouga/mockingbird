import { queryErrorParity, sequenceParity } from "../helpers.ts";

sequenceParity(
  "materialized view snapshots data",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1), (2)"],
  [
    { sql: "CREATE MATERIALIZED VIEW mv AS SELECT id FROM t" },
    { sql: "INSERT INTO t VALUES (3)" },
    { sql: "SELECT id FROM mv ORDER BY id", query: true },
    { sql: "SELECT id FROM t ORDER BY id", query: true },
  ],
);

sequenceParity(
  "REFRESH MATERIALIZED VIEW picks up changes",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
  [
    { sql: "CREATE MATERIALIZED VIEW mv AS SELECT id FROM t" },
    { sql: "INSERT INTO t VALUES (2)" },
    { sql: "SELECT id FROM mv ORDER BY id", query: true },
    { sql: "REFRESH MATERIALIZED VIEW mv" },
    { sql: "SELECT id FROM mv ORDER BY id", query: true },
  ],
);

queryErrorParity(
  "matview WITH NO DATA is unscannable",
  ["CREATE TABLE t (id int)", "CREATE MATERIALIZED VIEW mv AS SELECT id FROM t WITH NO DATA"],
  "SELECT * FROM mv",
);

sequenceParity(
  "REFRESH populates WITH NO DATA matview",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (5)"],
  [
    { sql: "CREATE MATERIALIZED VIEW mv AS SELECT id FROM t WITH NO DATA" },
    { sql: "REFRESH MATERIALIZED VIEW mv" },
    { sql: "SELECT id FROM mv ORDER BY id", query: true },
  ],
);

sequenceParity(
  "matview with aggregate",
  ["CREATE TABLE t (grp text, n int)", "INSERT INTO t VALUES ('a', 1), ('a', 2), ('b', 3)"],
  [
    { sql: "CREATE MATERIALIZED VIEW mv AS SELECT grp, sum(n) AS total FROM t GROUP BY grp" },
    { sql: "SELECT grp, total FROM mv ORDER BY grp", query: true },
  ],
);

sequenceParity(
  "DROP MATERIALIZED VIEW",
  ["CREATE TABLE t (id int)", "CREATE MATERIALIZED VIEW mv AS SELECT id FROM t"],
  [{ sql: "DROP MATERIALIZED VIEW mv" }, { sql: "SELECT count(*) FROM t", query: true }],
  { compareFinalState: true },
);
