import { sequenceParity } from "../helpers.ts";

for (const type of ["INTEGER", "REAL", "NUMERIC", "TEXT"]) {
  sequenceParity(
    `bounded ${type} index access retains affinity, endpoints, residual predicates and parameters`,
    [
      `CREATE TABLE t(id INTEGER PRIMARY KEY, k ${type})`,
      "INSERT INTO t VALUES (1,NULL),(2,-10),(3,-5),(4,0),(5,5),(6,10),(7,0)",
      "CREATE INDEX t_k ON t(k)",
    ],
    [
      ...[
        "k >= -5 AND k < 5",
        "k > -5 AND k <= 5",
        "-5 <= x.k AND 5 > x.k",
        "k >= 5 AND k < -5",
        "k >= 0 AND k <= 0",
        "k BETWEEN -5 AND 5",
        "k >= ? AND k < ?",
        "k >= -5 AND k < 5 AND id <> 4",
      ].map((predicate) => ({
        sql: `SELECT id,k FROM t x WHERE ${predicate} ORDER BY id`,
        query: true,
        params: predicate.includes("?") ? [-5, 5] : undefined,
      })),
      { sql: "BEGIN; UPDATE t SET k = 3 WHERE id = 4" },
      { sql: "SELECT id FROM t WHERE k >= -5 AND k < 5 ORDER BY id", query: true },
      { sql: "ROLLBACK" },
      { sql: "SELECT id FROM t WHERE k >= -5 AND k < 5 ORDER BY id", query: true },
    ],
    { compareFinalState: true },
  );
}
