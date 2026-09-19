/** Generated matrix: explicit casts of edge values to every scalar cast target. */
import { describe, test } from "bun:test";
import { InMemoryAdapter } from "../../adapters/in-memory.ts";
import { createOracleAdapter } from "../../harness/oracle.ts";
import { deepCompareResults } from "../../harness/normalize.ts";
import type { ContractDb } from "../../harness/types.ts";
import { CAST_TARGETS, CLASS_REPS, FLOAT_EDGES, INTEGER_EDGES, NUMERIC_EDGES, TEXT_EDGES } from "./values.ts";

async function compareCast(memory: ContractDb, postgres: ContractDb, label: string, sql: string): Promise<void> {
  const ma = await memory.query(sql);
  const mb = await postgres.query(sql);
  const result = deepCompareResults(ma, mb, { ignoreWriteCounters: true, messageTier: "B", ignoreErrorPhase: true });
  if (!result.equal) {
    throw new Error(
      `M2 ${label}\nSQL: ${sql}\n${result.reason}\nmem=${JSON.stringify(ma)}\noracle=${JSON.stringify(mb)}`,
    );
  }
}

describe("M2 cast × value class", () => {
  test("class representatives to every cast target", async () => {
    const memory = new InMemoryAdapter();
    const postgres = createOracleAdapter();
    try {
      for (const target of CAST_TARGETS) {
        for (const rep of CLASS_REPS) {
          const sql = `SELECT (${rep.sql})::${target} AS v`;
          await compareCast(memory, postgres, `${rep.label} :: ${target}`, sql);
        }
      }
    } finally {
      await memory.close();
      await postgres.close();
    }
  }, 120000);

  test("numeric edges to numeric targets", async () => {
    const memory = new InMemoryAdapter();
    const postgres = createOracleAdapter();
    try {
      const numericTargets = ["int2", "int4", "int8", "float4", "float8", "numeric", "numeric(6,2)", "text"];
      for (const target of numericTargets) {
        for (const value of [...INTEGER_EDGES, ...NUMERIC_EDGES, ...FLOAT_EDGES]) {
          const sql = `SELECT (${value})::${target} AS v`;
          await compareCast(memory, postgres, `${value} :: ${target}`, sql);
        }
      }
    } finally {
      await memory.close();
      await postgres.close();
    }
  }, 120000);

  test("text edges to scalar targets", async () => {
    const memory = new InMemoryAdapter();
    const postgres = createOracleAdapter();
    try {
      const targets = ["int4", "int8", "float8", "numeric", "bool", "text"];
      for (const target of targets) {
        for (const value of TEXT_EDGES) {
          const sql = `SELECT (${value})::${target} AS v`;
          await compareCast(memory, postgres, `${value} :: ${target}`, sql);
        }
      }
    } finally {
      await memory.close();
      await postgres.close();
    }
  }, 120000);
});
