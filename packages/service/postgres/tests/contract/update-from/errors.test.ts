import { errorParity } from "../helpers.ts";

errorParity(
  "undefined source table in FROM",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
  "UPDATE t SET id = s.id FROM missing_source AS s WHERE t.id = s.id",
  "undefined_table",
);

errorParity(
  "constraint violation via UPDATE FROM",
  [
    "CREATE TABLE t (id int, n int NOT NULL)",
    "INSERT INTO t VALUES (1, 1)",
    "CREATE TABLE s (tid int, x int)",
    "INSERT INTO s VALUES (1, NULL)",
  ],
  "UPDATE t SET n = s.x FROM s WHERE t.id = s.tid",
  "constraint_notnull",
);

errorParity(
  "undefined source table in DELETE USING",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
  "DELETE FROM t USING missing_source AS s WHERE t.id = s.id",
  "undefined_table",
);
