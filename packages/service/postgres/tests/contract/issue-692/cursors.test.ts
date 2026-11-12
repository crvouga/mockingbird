import { expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { errorParity, sequenceParity } from "../helpers.ts";

// #692: SQL cursors — DECLARE / FETCH / MOVE / CLOSE, WITH HOLD, SCROLL, pg_cursors.

const q = (sql: string) => ({ sql, query: true });

sequenceParity(
  "the issue's cursor example",
  [],
  [
    { sql: "BEGIN" },
    { sql: "DECLARE cur CURSOR FOR SELECT generate_series(1, 5) AS n" },
    q("FETCH 2 FROM cur"),
    q("FETCH NEXT FROM cur"),
    q("FETCH ALL FROM cur"),
    q("FETCH ALL FROM cur"),
    { sql: "COMMIT" },
  ],
);

sequenceParity(
  "every FETCH direction on a scrollable cursor",
  ["CREATE TABLE t (n int)", "INSERT INTO t SELECT generate_series(1, 5)"],
  [
    { sql: "BEGIN" },
    { sql: "DECLARE cur SCROLL CURSOR FOR SELECT n FROM t ORDER BY n" },
    q("FETCH FORWARD 2 FROM cur"),
    q("FETCH PRIOR FROM cur"),
    q("FETCH BACKWARD 5 FROM cur"),
    q("FETCH ABSOLUTE 3 FROM cur"),
    q("FETCH ABSOLUTE -1 FROM cur"),
    q("FETCH ABSOLUTE 9 FROM cur"),
    q("FETCH RELATIVE -2 FROM cur"),
    q("FETCH RELATIVE 0 FROM cur"),
    q("FETCH FIRST FROM cur"),
    q("FETCH LAST IN cur"),
    q("FETCH -2 FROM cur"),
    q("FETCH FORWARD -1 FROM cur"),
    q("FETCH BACKWARD ALL FROM cur"),
    { sql: "MOVE FORWARD 3 IN cur" },
    q("FETCH cur"),
    { sql: "MOVE LAST FROM cur" },
    q("FETCH NEXT FROM cur"),
    { sql: "COMMIT" },
  ],
);

sequenceParity(
  "MOVE reports how many rows it passed",
  ["CREATE TABLE t AS SELECT generate_series(1, 4) AS n"],
  [
    { sql: "BEGIN" },
    { sql: "DECLARE c CURSOR FOR SELECT n FROM t" },
    { sql: "MOVE 2 FROM c" },
    { sql: "MOVE ALL FROM c" },
    { sql: "MOVE NEXT FROM c" },
    { sql: "COMMIT" },
  ],
);

sequenceParity(
  "a cursor sees the rows as of DECLARE",
  ["CREATE TABLE t (n int)", "INSERT INTO t VALUES (1), (2)"],
  [
    { sql: "BEGIN" },
    { sql: "DECLARE c CURSOR FOR SELECT n FROM t ORDER BY n" },
    { sql: "INSERT INTO t VALUES (3)" },
    q("FETCH ALL FROM c"),
    { sql: "COMMIT" },
  ],
);

sequenceParity(
  "pg_cursors and WITH HOLD across COMMIT",
  [],
  [
    { sql: "BEGIN" },
    { sql: "DECLARE h SCROLL CURSOR WITH HOLD FOR SELECT x, x * 2 AS y FROM generate_series(1, 3) x" },
    { sql: "DECLARE nh CURSOR FOR SELECT 1 AS one" },
    { sql: "DECLARE ns NO SCROLL CURSOR FOR SELECT * FROM generate_series(1, 3) g" },
    { sql: "DECLARE bin BINARY CURSOR FOR SELECT x FROM generate_series(1, 2) x" },
    q("SELECT name, statement, is_holdable, is_binary, is_scrollable FROM pg_cursors ORDER BY name"),
    { sql: "COMMIT" },
    q("SELECT name, is_holdable FROM pg_cursors ORDER BY name"),
    q("FETCH 1 FROM h"),
    q("FETCH ABSOLUTE 3 FROM h"),
    { sql: "CLOSE h" },
    q("SELECT count(*) FROM pg_cursors"),
  ],
);

sequenceParity(
  "a WITH HOLD cursor declared outside a transaction block",
  [],
  [
    { sql: "DECLARE h CURSOR WITH HOLD FOR SELECT 1 AS a UNION ALL SELECT 2" },
    q("FETCH 1 FROM h"),
    q("FETCH 1 FROM h"),
    { sql: "CLOSE ALL" },
    q("SELECT count(*) FROM pg_cursors"),
  ],
);

sequenceParity(
  "ROLLBACK closes the cursors the transaction declared",
  [],
  [
    { sql: "BEGIN" },
    { sql: "DECLARE h CURSOR WITH HOLD FOR SELECT 1 AS a" },
    { sql: "DECLARE c CURSOR FOR SELECT 1 AS a" },
    { sql: "ROLLBACK" },
    q("SELECT count(*) FROM pg_cursors"),
  ],
);

errorParity("DECLARE outside a transaction block", [], "DECLARE c CURSOR FOR SELECT 1", "transaction");
errorParity("FETCH from a missing cursor", [], "FETCH 1 FROM nope");
errorParity("CLOSE a missing cursor", [], "CLOSE nope");
errorParity(
  "a cursor's name is taken until it closes",
  ["DECLARE h CURSOR WITH HOLD FOR SELECT 1"],
  "DECLARE h CURSOR WITH HOLD FOR SELECT 2",
);
errorParity(
  "a NO SCROLL cursor cannot go back",
  ["DECLARE h NO SCROLL CURSOR WITH HOLD FOR SELECT * FROM generate_series(1, 3) g", "FETCH 2 FROM h"],
  "FETCH PRIOR FROM h",
);
errorParity(
  "a cursor over a set-returning select list cannot go back unless SCROLL",
  ["DECLARE h CURSOR WITH HOLD FOR SELECT generate_series(1, 5) AS n", "FETCH 2 FROM h"],
  "FETCH PRIOR FROM h",
);
errorParity(
  "a cursor over an aggregate cannot go back unless SCROLL",
  ["DECLARE h CURSOR WITH HOLD FOR SELECT count(*) FROM generate_series(1, 5)", "FETCH 1 FROM h"],
  "FETCH ABSOLUTE 0 FROM h",
);

test("cursors over the engine API: FETCH returns rows with the query's columns", () => {
  const db = new Database();
  db.exec("BEGIN");
  db.exec("DECLARE c CURSOR FOR SELECT g AS n, 'x' || g AS label FROM generate_series(1, 3) g");
  const first = db.query("FETCH 2 FROM c");
  expect(first).toEqual([
    { n: 1, label: "x1" },
    { n: 2, label: "x2" },
  ]);
  expect(db.query("FETCH ALL FROM c")).toEqual([{ n: 3, label: "x3" }]);
  db.exec("COMMIT");
  expect(() => db.query("FETCH 1 FROM c")).toThrow(/cursor "c" does not exist/);
});
