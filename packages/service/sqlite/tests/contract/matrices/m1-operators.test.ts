/** Catalog: EXP-arith-01 EXP-arith-04 EXP-concat-01 EXP-is-01 TYP-cmp-01 TYP-cmp-02 */
import { describe, test } from "bun:test";
import { InMemoryAdapter } from "../../adapters/in-memory.ts";
import { RealSqliteAdapter } from "../../adapters/real-sqlite.ts";
import { deepCompareResults } from "../../harness/normalize.ts";
import { AFFINITY_COLUMNS, BINARY_OPS, CLASS_REPS } from "./values.ts";

function compareCell(label: string, setup: string[], sql: string): void {
  const memory = new InMemoryAdapter();
  const sqlite = new RealSqliteAdapter();
  try {
    for (const stmt of setup) {
      const a = memory.exec(stmt);
      const b = sqlite.exec(stmt);
      if (!a.ok || !b.ok) {
        throw new Error(`${label} setup failed: ${stmt}: ${a.error?.message} / ${b.error?.message}`);
      }
    }
    const ma = memory.query(sql);
    const mb = sqlite.query(sql);
    const result = deepCompareResults(ma, mb, { ignoreWriteCounters: true, messageTier: "B", ignoreErrorPhase: true });
    if (!result.equal) {
      throw new Error(
        `M1 ${label}\nSQL: ${sql}\n${result.reason}\nmem=${JSON.stringify(ma)}\noracle=${JSON.stringify(mb)}`,
      );
    }
  } finally {
    memory.close();
    sqlite.close();
  }
}

describe("M1 operator × class × affinity", () => {
  test("literal operands for every operator and class pair", () => {
    const arith = new Set(["+", "-", "*", "/", "%"]);
    for (const op of BINARY_OPS) {
      for (const left of CLASS_REPS) {
        for (const right of CLASS_REPS) {
          if (arith.has(op) && left.class !== right.class) continue;
          if ((op === "LIKE" || op === "GLOB") && (left.class === "blob" || right.class === "blob")) continue;
          const expr = `${left.sql} ${op} ${right.sql}`;
          const sql = `SELECT (${expr}) AS v`;
          compareCell(`lit ${left.label} ${op} ${right.label}`, [], sql);
        }
      }
    }
  });

  test("column affinity context for comparison and arithmetic ops", () => {
    const decls = AFFINITY_COLUMNS.map((c) => (c.decl ? `${c.name} ${c.decl}` : c.name)).join(", ");
    const setup = [`CREATE TABLE t(${decls})`, "INSERT INTO t(i, t, r, n, b, x) VALUES (1, '12', 1.5, 1, X'00', 'a')"];
    const ops = ["+", "=", "IS"] as const;
    for (const op of ops) {
      for (const left of AFFINITY_COLUMNS) {
        compareCell(
          `col ${left.name} ${op} ${left.name}`,
          setup,
          `SELECT (${left.name} ${op} ${left.name}) AS v FROM t`,
        );
      }
    }
  });
});
