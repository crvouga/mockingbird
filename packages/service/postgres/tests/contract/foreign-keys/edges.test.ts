import { errorParity, sequenceParity } from "../helpers.ts";

sequenceParity(
  "composite FK insert and violation-free delete",
  [
    "CREATE TABLE parent (a int, b int, PRIMARY KEY (a, b))",
    "INSERT INTO parent VALUES (1, 1), (1, 2)",
    "CREATE TABLE child (id int, pa int, pb int, FOREIGN KEY (pa, pb) REFERENCES parent(a, b))",
  ],
  [{ sql: "INSERT INTO child VALUES (10, 1, 1)" }, { sql: "SELECT id, pa, pb FROM child ORDER BY id", query: true }],
  { compareFinalState: true },
);

errorParity(
  "composite FK violation",
  [
    "CREATE TABLE parent (a int, b int, PRIMARY KEY (a, b))",
    "INSERT INTO parent VALUES (1, 1)",
    "CREATE TABLE child (pa int, pb int, FOREIGN KEY (pa, pb) REFERENCES parent(a, b))",
  ],
  "INSERT INTO child VALUES (1, 2)",
  "constraint_foreign",
);

sequenceParity(
  "composite FK with one null column passes (MATCH SIMPLE)",
  [
    "CREATE TABLE parent (a int, b int, PRIMARY KEY (a, b))",
    "CREATE TABLE child (pa int, pb int, FOREIGN KEY (pa, pb) REFERENCES parent(a, b))",
  ],
  [{ sql: "INSERT INTO child VALUES (1, NULL)" }, { sql: "SELECT pa, pb FROM child", query: true }],
  { compareFinalState: true },
);

errorParity("FK to missing table", [], "CREATE TABLE child (pid int REFERENCES missing_parent(id))", "undefined_table");
