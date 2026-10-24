import { expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { sequenceParity } from "../helpers.ts";

test("range candidates retain the prior heap order before volatile projection", () => {
  const db = new Database();
  try {
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY); CREATE SEQUENCE calls; INSERT INTO t VALUES (50),(2),(1),(10)");
    expect(db.query("SELECT id, nextval('calls') AS n FROM t WHERE id >= 0 AND id < 51")).toEqual([
      { id: 50, n: 1n },
      { id: 2, n: 2n },
      { id: 1, n: 3n },
      { id: 10, n: 4n },
    ]);
  } finally {
    db.close();
  }
});

for (const type of ["INTEGER", "SMALLINT", "BIGINT", "DOUBLE PRECISION"]) {
  const predicates = [
    "id >= -5 AND id < 5",
    "id > -5 AND id <= 5",
    "-5 <= x.id AND 5 > x.id",
    "x.id >= 5 AND x.id < -5",
    "x.id >= 0 AND x.id <= 0",
    "id >= $1 AND id < $2",
    "id >= -5 AND id < 5 AND id <> 0",
  ];
  sequenceParity(
    `bounded ${type} index access retains endpoint, alias, parameter and fallback semantics`,
    [
      `CREATE TABLE t(id ${type} UNIQUE, payload TEXT)`,
      "INSERT INTO t VALUES (-10,'a'),(-5,'b'),(0,'c'),(5,'d'),(10,'e'),(NULL,'null')",
    ],
    [
      ...predicates.map((predicate) => ({
        sql: `SELECT id, payload FROM t x WHERE ${predicate} ORDER BY id`,
        query: true,
        params: predicate.includes("$") ? [-5, 5] : undefined,
      })),
      { sql: "BEGIN; UPDATE t SET id = 3 WHERE id = 0" },
      { sql: "SELECT id FROM t WHERE id >= -5 AND id < 5 ORDER BY id", query: true },
      { sql: "SAVEPOINT nested; DELETE FROM t WHERE id = 3; INSERT INTO t VALUES (1,'new')" },
      { sql: "SELECT id FROM t WHERE id >= -5 AND id < 5 ORDER BY id", query: true },
      { sql: "ROLLBACK TO nested; RELEASE nested; ROLLBACK" },
      { sql: "SELECT id FROM t WHERE id >= -5 AND id < 5 ORDER BY id", query: true },
    ],
    { compareFinalState: true },
  );
}
