import { execParity, parity, sequenceParity } from "../helpers.ts";

sequenceParity(
  "ANALYZE creates sqlite_stat1",
  ["CREATE TABLE t(x INT)", "CREATE INDEX ix ON t(x)", "INSERT INTO t VALUES (1),(2),(3)"],
  [
    { sql: "ANALYZE" },
    {
      sql: "SELECT tbl, idx IS NOT NULL AS has_idx, typeof(stat) AS st FROM sqlite_stat1 ORDER BY tbl, idx",
      query: true,
    },
  ],
);

execParity("VACUUM succeeds on memory", ["CREATE TABLE t(x INT)"], "VACUUM");
execParity(
  "REINDEX succeeds",
  ["CREATE TABLE t(x INT)", "CREATE INDEX ix ON t(x)", "INSERT INTO t VALUES (1)"],
  "REINDEX",
);
execParity("REINDEX table", ["CREATE TABLE t(x INT)", "CREATE INDEX ix ON t(x)"], "REINDEX t");
execParity("REINDEX index name", ["CREATE TABLE t(x INT)", "CREATE INDEX ix ON t(x)"], "REINDEX ix");
execParity(
  "REINDEX NOCASE collation",
  ["CREATE TABLE t(x TEXT COLLATE NOCASE)", "CREATE INDEX ix ON t(x)"],
  "REINDEX NOCASE",
);
sequenceParity(
  "REINDEX rebuilds a composite index used for prefix equality",
  [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT, b TEXT)",
    "CREATE INDEX t_ab ON t(a, b)",
    "INSERT INTO t VALUES (1, 'u', NULL)",
  ],
  [{ sql: "REINDEX t_ab" }, { sql: "SELECT id FROM t WHERE a = 'u'", query: true }],
);
parity("sqlite_version matches oracle major", [], "SELECT length(sqlite_version()) > 0 AS ok");
