import { expectParity } from "../../harness/assert.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { parity, setupBoth } from "../helpers.ts";

parity("numbered parameters ?2 ?1 reorder binds", [], "SELECT ?2 AS a, ?1 AS b", [10, 20]);

parity("numbered parameters with gaps use highest index as count", [], "SELECT ?3 AS c, ?1 AS a", [1, 2, 3]);

matrixBoth("numbered parameters in INSERT match oracle", (memory, sqlite) => {
  setupBoth(memory, sqlite, ["CREATE TABLE t(a INT, b INT, c INT)"]);
  expectParity(
    memory.exec("INSERT INTO t VALUES (?3, ?1, ?2)", [10, 20, 30]),
    sqlite.exec("INSERT INTO t VALUES (?3, ?1, ?2)", [10, 20, 30]),
  );
  expectParity(memory.query("SELECT a,b,c FROM t"), sqlite.query("SELECT a,b,c FROM t"));
});
