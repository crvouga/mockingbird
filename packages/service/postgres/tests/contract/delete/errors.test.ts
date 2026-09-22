import { errorParity, sequenceParity } from "../helpers.ts";

errorParity("delete from missing table", [], "DELETE FROM missing_table", "undefined_table");

errorParity(
  "undefined column in delete WHERE",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
  "DELETE FROM t WHERE missing = 1",
  "undefined_column",
);

errorParity(
  "cardinality error from scalar subquery in WHERE",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)", "CREATE TABLE s (id int)", "INSERT INTO s VALUES (1), (2)"],
  "DELETE FROM t WHERE id = (SELECT id FROM s)",
  "cardinality",
);

errorParity(
  "delete restricted by foreign key",
  [
    "CREATE TABLE parent (id int PRIMARY KEY)",
    "INSERT INTO parent VALUES (1)",
    "CREATE TABLE child (id int, pid int REFERENCES parent(id))",
    "INSERT INTO child VALUES (10, 1)",
  ],
  "DELETE FROM parent WHERE id = 1",
  "constraint_foreign",
);

errorParity(
  "type error in delete predicate",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
  "DELETE FROM t WHERE id = 'abc'",
  "invalid_text_representation",
);

sequenceParity(
  "failed delete leaves table intact",
  [
    "CREATE TABLE parent (id int PRIMARY KEY)",
    "INSERT INTO parent VALUES (1), (2)",
    "CREATE TABLE child (pid int REFERENCES parent(id))",
    "INSERT INTO child VALUES (2)",
  ],
  [{ sql: "DELETE FROM parent" }, { sql: "SELECT id FROM parent ORDER BY id", query: true }],
  { compareFinalState: true },
);
