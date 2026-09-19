import { expectParity } from "../../harness/assert.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { parity, setupBoth } from "../helpers.ts";

parity(
  "NOT IN (SELECT) with NULL row is unknown for all candidates",
  ["CREATE TABLE s(v INTEGER)", "INSERT INTO s VALUES (1),(NULL)"],
  "SELECT 1 NOT IN (SELECT v FROM s) AS a, 2 NOT IN (SELECT v FROM s) AS b",
);

parity(
  "NOT IN (SELECT) empty subquery is true",
  ["CREATE TABLE s(v INTEGER)"],
  "SELECT 1 NOT IN (SELECT v FROM s) AS a",
);

parity(
  "IN (SELECT) with NULL matches only exact values",
  [
    "CREATE TABLE s(v INTEGER)",
    "INSERT INTO s VALUES (1),(NULL)",
    "CREATE TABLE t(v INTEGER)",
    "INSERT INTO t VALUES (1),(2),(NULL)",
  ],
  "SELECT t.v FROM t WHERE t.v IN (SELECT v FROM s) ORDER BY t.v",
);

matrixBoth("multi-statement exec updates changes and total_changes like oracle", (memory, sqlite) => {
  setupBoth(memory, sqlite, ["CREATE TABLE t(id INTEGER PRIMARY KEY)"]);
  expectParity(
    memory.exec("INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); INSERT INTO t VALUES (3);"),
    sqlite.exec("INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); INSERT INTO t VALUES (3);"),
  );
  expectParity(
    memory.query("SELECT changes() AS c, total_changes() AS tc, last_insert_rowid() AS id"),
    sqlite.query("SELECT changes() AS c, total_changes() AS tc, last_insert_rowid() AS id"),
  );
  expectParity(
    memory.exec("UPDATE t SET id = id + 10 WHERE id <= 2; DELETE FROM t WHERE id = 11;"),
    sqlite.exec("UPDATE t SET id = id + 10 WHERE id <= 2; DELETE FROM t WHERE id = 11;"),
  );
  expectParity(
    memory.query("SELECT changes() AS c, total_changes() AS tc"),
    sqlite.query("SELECT changes() AS c, total_changes() AS tc"),
  );
  expectParity(memory.query("SELECT id FROM t ORDER BY id"), sqlite.query("SELECT id FROM t ORDER BY id"));
});
