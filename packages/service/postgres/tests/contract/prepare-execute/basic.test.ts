import { sequenceParity } from "../helpers.ts";

sequenceParity(
  "PREPARE with a typed parameter and EXECUTE",
  [],
  [{ sql: "PREPARE p1 (int) AS SELECT $1 + 1 AS v" }, { sql: "EXECUTE p1(41)", query: true }],
);

sequenceParity(
  "PREPARE without declared types infers from usage",
  [],
  [{ sql: "PREPARE p1 AS SELECT $1::int + $2::int AS v" }, { sql: "EXECUTE p1(1, 2)", query: true }],
);

sequenceParity(
  "PREPARE with multiple typed parameters",
  [],
  [{ sql: "PREPARE p1 (int, text) AS SELECT $1 AS n, $2 AS s" }, { sql: "EXECUTE p1(7, 'hello')", query: true }],
);

sequenceParity(
  "text parameter concatenation",
  [],
  [{ sql: "PREPARE p1 (text) AS SELECT $1 || '!' AS v" }, { sql: "EXECUTE p1('hi')", query: true }],
);

sequenceParity(
  "EXECUTE can run multiple times",
  [],
  [
    { sql: "PREPARE p1 (int) AS SELECT $1 * 2 AS v" },
    { sql: "EXECUTE p1(1)", query: true },
    { sql: "EXECUTE p1(2)", query: true },
    { sql: "EXECUTE p1(3)", query: true },
  ],
);

sequenceParity(
  "prepared SELECT over a table",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')"],
  [
    { sql: "PREPARE p1 (int) AS SELECT id, v FROM t WHERE id > $1 ORDER BY id" },
    { sql: "EXECUTE p1(0)", query: true },
    { sql: "EXECUTE p1(1)", query: true },
    { sql: "EXECUTE p1(99)", query: true },
  ],
);

sequenceParity(
  "prepared INSERT writes rows",
  ["CREATE TABLE t (id int, v text)"],
  [
    { sql: "PREPARE ins (int, text) AS INSERT INTO t VALUES ($1, $2)" },
    { sql: "EXECUTE ins(1, 'a')" },
    { sql: "EXECUTE ins(2, 'b')" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "prepared UPDATE and DELETE",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (2, 'b')"],
  [
    { sql: "PREPARE upd (text, int) AS UPDATE t SET v = $1 WHERE id = $2" },
    { sql: "EXECUTE upd('z', 1)" },
    { sql: "PREPARE del (int) AS DELETE FROM t WHERE id = $1" },
    { sql: "EXECUTE del(2)" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "DEALLOCATE removes the prepared statement",
  [],
  [
    { sql: "PREPARE p1 AS SELECT 1 AS v" },
    { sql: "EXECUTE p1", query: true },
    { sql: "DEALLOCATE p1" },
    { sql: "EXECUTE p1", query: true },
  ],
);

sequenceParity(
  "re-PREPARE after DEALLOCATE with a new definition",
  [],
  [
    { sql: "PREPARE p1 AS SELECT 1 AS v" },
    { sql: "EXECUTE p1", query: true },
    { sql: "DEALLOCATE p1" },
    { sql: "PREPARE p1 AS SELECT 2 AS v" },
    { sql: "EXECUTE p1", query: true },
  ],
);

sequenceParity(
  "DEALLOCATE PREPARE keyword form",
  [],
  [{ sql: "PREPARE p1 AS SELECT 1 AS v" }, { sql: "DEALLOCATE PREPARE p1" }, { sql: "EXECUTE p1", query: true }],
);
