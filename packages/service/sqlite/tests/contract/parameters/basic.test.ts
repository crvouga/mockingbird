import { expectParity } from "../../harness/assert.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { setupBoth } from "../helpers.ts";

matrixBoth("positional parameters in expressions", (memory, sqlite) => {
  expectParity(
    memory.query("SELECT ? + ? AS sum, ? AS text", [2, 3, "ok"]),
    sqlite.query("SELECT ? + ? AS sum, ? AS text", [2, 3, "ok"]),
  );
});
matrixBoth("positional parameters in INSERT", (memory, sqlite) => {
  setupBoth(memory, sqlite, ["CREATE TABLE t(id INTEGER,name TEXT)"]);
  expectParity(
    memory.exec("INSERT INTO t VALUES (?,?)", [1, "Ada"]),
    sqlite.exec("INSERT INTO t VALUES (?,?)", [1, "Ada"]),
  );
  expectParity(memory.query("SELECT * FROM t"), sqlite.query("SELECT * FROM t"));
});
matrixBoth("named parameter slots bind by statement order", (memory, sqlite) => {
  expectParity(
    memory.query("SELECT :left + :right AS value", [7, 8]),
    sqlite.query("SELECT :left + :right AS value", [7, 8]),
  );
});
matrixBoth("prepared statements bind and reuse values", (memory, sqlite) => {
  const a = memory.prepare("SELECT ? AS value");
  const b = sqlite.prepare("SELECT ? AS value");
  expectParity(a.all(12), b.all(12));
  expectParity(a.all("twelve"), b.all("twelve"));
});
