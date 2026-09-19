import { InMemoryAdapter } from "../adapters/in-memory.ts";
import { deepCompareResults, type CompareOptions } from "../harness/normalize.ts";
import { createOracleAdapter } from "../harness/oracle.ts";
import { dumpLogicalState } from "../harness/state-dump.ts";
import type { ContractDb, QueryResult, SqlValue } from "../harness/types.ts";
import { fuzzSeed } from "./config.ts";

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Render a JS value as a PostgreSQL literal for generated SQL. */
export function sqlLiteral(value: SqlValue): string {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "0";
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  return `'\\x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}'::bytea`;
}

function replayHint(): string {
  return `Replay: POSTGRES_MEM_FUZZ_SEED=${fuzzSeed()} bun test tests/fuzz`;
}

export function compareOrReport(
  label: string,
  sql: string,
  setup: unknown,
  memory: QueryResult,
  postgres: QueryResult,
  options?: CompareOptions,
): void {
  const comparison = deepCompareResults(memory, postgres, {
    messageTier: "B",
    ignoreErrorPhase: true,
    ignoreWriteCounters: (memory.columns?.length ?? 0) > 0 || (postgres.columns?.length ?? 0) > 0,
    ...options,
  });
  if (comparison.equal) return;

  throw new Error(
    [
      `Differential mismatch (${label})`,
      `seed=${fuzzSeed()}`,
      replayHint(),
      `SQL: ${sql}`,
      `Setup: ${JSON.stringify(setup)}`,
      `Reason: ${comparison.reason}`,
      `memory: ${JSON.stringify(memory)}`,
      `postgres: ${JSON.stringify(postgres)}`,
    ].join("\n"),
  );
}

/**
 * Outcome-only compare for cases where PostgreSQL does not specify which
 * constraint error is reported first. Prefer compareOrReport otherwise.
 */
export function compareOutcomeOrReport(
  label: string,
  sql: string,
  setup: unknown,
  memory: QueryResult,
  postgres: QueryResult,
): void {
  const sameOutcome = memory.ok === postgres.ok && (memory.ok || memory.error?.category === postgres.error?.category);
  if (sameOutcome) return;

  throw new Error(
    [
      `Differential outcome mismatch (${label})`,
      `seed=${fuzzSeed()}`,
      replayHint(),
      `SQL: ${sql}`,
      `Setup: ${JSON.stringify(setup)}`,
      `memory: ${JSON.stringify(memory)}`,
      `postgres: ${JSON.stringify(postgres)}`,
    ].join("\n"),
  );
}

/** Full compare on success; category-only on failure (constraint races). */
export function compareWriteOrReport(
  label: string,
  sql: string,
  setup: unknown,
  memory: QueryResult,
  postgres: QueryResult,
): void {
  if (memory.ok && postgres.ok) {
    compareOrReport(label, sql, setup, memory, postgres);
    return;
  }
  compareOutcomeOrReport(label, sql, setup, memory, postgres);
}

export async function compareStateOrReport(
  label: string,
  setup: unknown,
  memory: ContractDb,
  postgres: ContractDb,
): Promise<void> {
  compareOrReport(
    label,
    "<logical-state-dump>",
    setup,
    await dumpLogicalState(memory),
    await dumpLogicalState(postgres),
  );
}

export async function withDatabases(run: (memory: ContractDb, postgres: ContractDb) => Promise<void>): Promise<void> {
  const memory = new InMemoryAdapter();
  const postgres = createOracleAdapter();
  try {
    await run(memory, postgres);
  } finally {
    await memory.close();
    await postgres.close();
  }
}
