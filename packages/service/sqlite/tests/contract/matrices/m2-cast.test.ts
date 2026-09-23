/** Catalog: TYP-cast-01 TYP-cast-02 TYP-cast-03 TYP-cast-04 TYP-cast-05 TYP-cast-06 TYP-cast-07 TYP-cast-09 */
import { describe, test } from "bun:test";
import { InMemoryAdapter } from "../../adapters/in-memory.ts";
import { RealSqliteAdapter } from "../../adapters/real-sqlite.ts";
import { deepCompareResults } from "../../harness/normalize.ts";
import { CAST_TARGETS, CLASS_REPS, INTEGER_EDGES } from "./values.ts";

function compareCast(label: string, sql: string): void {
  const memory = new InMemoryAdapter();
  const sqlite = new RealSqliteAdapter();
  try {
    const ma = memory.query(sql);
    const mb = sqlite.query(sql);
    const result = deepCompareResults(ma, mb, { ignoreWriteCounters: true, messageTier: "B", ignoreErrorPhase: true });
    if (!result.equal) {
      throw new Error(`M2 ${label}\nSQL: ${sql}\n${result.reason}`);
    }
  } finally {
    memory.close();
    sqlite.close();
  }
}

describe("M2 CAST source × target", () => {
  test("class representatives × declared type names", () => {
    for (const value of CLASS_REPS) {
      for (const target of CAST_TARGETS) {
        if (
          value.class === "blob" &&
          (target === "NUMERIC" || target === "INTEGER" || target === "REAL" || target === "TEXT")
        )
          continue;
        if (value.class === "text_non" && target !== "TEXT" && target !== "BLOB") continue;
        if (value.class === "real" && target === "TEXT") continue;
        const sql = `SELECT CAST(${value.sql} AS ${target}) AS v, typeof(CAST(${value.sql} AS ${target})) AS t`;
        compareCast(`${value.label} AS ${target}`, sql);
      }
    }
  });

  test("integer and real edges × INTEGER/REAL/TEXT", () => {
    for (const sqlVal of [...INTEGER_EDGES, "'0'", "'1'", "'-1'", "'12 '", "' 12'"]) {
      for (const target of ["INTEGER", "REAL", "TEXT"] as const) {
        compareCast(`${sqlVal} AS ${target}`, `SELECT CAST(${sqlVal} AS ${target}) AS v`);
      }
    }
  });
});
