import { expectParity } from "../../harness/assert.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { dumpLogicalState } from "../../harness/state-dump.ts";
import { setupBoth } from "../helpers.ts";

matrixBoth("failed UNIQUE leaves prior rows intact", (memory, sqlite) => {
  setupBoth(memory, sqlite, [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT UNIQUE)",
    "INSERT INTO t VALUES (1, 'a')",
  ]);
  expectParity(memory.exec("INSERT INTO t VALUES (2, 'a')"), sqlite.exec("INSERT INTO t VALUES (2, 'a')"));
  expectParity(memory.query("SELECT id, name FROM t ORDER BY id"), sqlite.query("SELECT id, name FROM t ORDER BY id"));
  expectParity(dumpLogicalState(memory), dumpLogicalState(sqlite));
});

matrixBoth("rollback after failed statement restores prior state", (memory, sqlite) => {
  setupBoth(memory, sqlite, ["CREATE TABLE t(id INTEGER PRIMARY KEY)", "INSERT INTO t VALUES (1)"]);
  for (const db of [memory, sqlite]) {
    db.exec("BEGIN");
    db.exec("INSERT INTO t VALUES (2)");
    db.exec("INSERT INTO t VALUES (1)"); // conflict
    db.exec("ROLLBACK");
  }
  expectParity(memory.query("SELECT id FROM t ORDER BY id"), sqlite.query("SELECT id FROM t ORDER BY id"));
});
