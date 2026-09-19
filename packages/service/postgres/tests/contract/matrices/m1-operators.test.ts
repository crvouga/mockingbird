/** Generated matrix: every binary operator applied to every pair of type-class representatives. */
import { describe, test } from "bun:test";
import { InMemoryAdapter } from "../../adapters/in-memory.ts";
import { createOracleAdapter } from "../../harness/oracle.ts";
import { deepCompareResults } from "../../harness/normalize.ts";
import type { ContractDb } from "../../harness/types.ts";
import { BINARY_OPS, CLASS_REPS } from "./values.ts";

async function compareCell(memory: ContractDb, postgres: ContractDb, label: string, sql: string): Promise<void> {
  const ma = await memory.query(sql);
  const mb = await postgres.query(sql);
  const result = deepCompareResults(ma, mb, { ignoreWriteCounters: true, messageTier: "B", ignoreErrorPhase: true });
  if (!result.equal) {
    throw new Error(
      `M1 ${label}\nSQL: ${sql}\n${result.reason}\nmem=${JSON.stringify(ma)}\noracle=${JSON.stringify(mb)}`,
    );
  }
}

describe("M1 operator × class × class", () => {
  test("literal operands for every operator and class pair", async () => {
    const memory = new InMemoryAdapter();
    const postgres = createOracleAdapter();
    try {
      for (const op of BINARY_OPS) {
        for (const left of CLASS_REPS) {
          for (const right of CLASS_REPS) {
            const expr = `${left.sql} ${op} ${right.sql}`;
            const sql = `SELECT (${expr}) AS v`;
            await compareCell(memory, postgres, `lit ${left.label} ${op} ${right.label}`, sql);
          }
        }
      }
    } finally {
      await memory.close();
      await postgres.close();
    }
  }, 120000);

  test("unary operators for every class", async () => {
    const memory = new InMemoryAdapter();
    const postgres = createOracleAdapter();
    try {
      for (const op of ["-", "+", "NOT "]) {
        for (const operand of CLASS_REPS) {
          const sql = `SELECT (${op}${operand.sql}) AS v`;
          await compareCell(memory, postgres, `unary ${op}${operand.label}`, sql);
        }
      }
    } finally {
      await memory.close();
      await postgres.close();
    }
  }, 60000);
});
