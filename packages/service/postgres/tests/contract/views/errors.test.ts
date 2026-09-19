import { errorParity, queryErrorParity, sequenceParity } from "../helpers.ts";

errorParity("drop missing view", [], "DROP VIEW ghost", "undefined_table");

errorParity(
  "create view with duplicate name",
  ["CREATE TABLE t (id int)", "CREATE VIEW v AS SELECT id FROM t"],
  "CREATE VIEW v AS SELECT id FROM t",
  "duplicate_object",
);

errorParity(
  "view name collides with table",
  ["CREATE TABLE t (id int)"],
  "CREATE VIEW t AS SELECT 1 AS x",
  "duplicate_object",
);

sequenceParity(
  "DROP VIEW CASCADE removes dependents",
  [
    "CREATE TABLE t (id int)",
    "INSERT INTO t VALUES (1)",
    "CREATE VIEW base AS SELECT id FROM t",
    "CREATE VIEW derived AS SELECT id FROM base",
  ],
  [{ sql: "DROP VIEW base CASCADE" }, { sql: "SELECT id FROM t ORDER BY id", query: true }],
  { compareFinalState: true },
);

queryErrorParity(
  "querying dropped view fails",
  ["CREATE TABLE t (id int)", "CREATE VIEW v AS SELECT id FROM t", "DROP VIEW v"],
  "SELECT * FROM v",
  "undefined_table",
);
