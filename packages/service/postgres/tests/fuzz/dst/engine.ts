import type { ContractDb } from "../../harness/types.ts";
import { fuzzSeed } from "../config.ts";
import {
  compareOrReport,
  compareOutcomeOrReport,
  compareStateOrReport,
  compareWriteOrReport,
  withDatabases,
} from "../helpers.ts";
import { assertProbeResultsEqual, captureProbeResults, probesForState } from "../snapshot-helpers.ts";
import { minimizeOps } from "./minimize.ts";
import {
  initialSimState,
  type MixedOp,
  OUTCOME_KINDS,
  QUERY_KINDS,
  READ_ONLY_QUERY_KINDS,
  resolveOp,
  type SchemaKind,
  type SimState,
  schemaFor,
} from "./ops.ts";
import { formatReproAdvice } from "./repro.ts";

export interface RunSequenceOptions {
  label: string;
  schemaKind?: SchemaKind;
  /** Explicit schema override (defaults to schemaFor(schemaKind)). */
  schema?: string;
  dumpAfterEveryStep?: boolean;
  finalizeCommit?: boolean;
}

async function applyResolved(
  label: string,
  index: number,
  op: MixedOp,
  sql: string,
  isQuery: boolean,
  memory: ContractDb,
  postgres: ContractDb,
): Promise<void> {
  const tag = `${label}-${op.kind}-${index}`;
  if (isQuery) {
    compareOrReport(tag, sql, op, await memory.query(sql), await postgres.query(sql));
    return;
  }
  if (OUTCOME_KINDS.has(op.kind)) {
    compareOutcomeOrReport(tag, sql, op, await memory.exec(sql), await postgres.exec(sql));
    return;
  }
  compareWriteOrReport(tag, sql, op, await memory.exec(sql), await postgres.exec(sql));
}

/** Memory-only PGMM snapshot round-trip, then full logical state compare vs the oracle. */
async function runCheckpoint(
  label: string,
  index: number,
  op: MixedOp,
  memory: ContractDb,
  postgres: ContractDb,
  state: SimState,
): Promise<void> {
  const probes = probesForState(state);
  const before = await captureProbeResults(memory, probes);

  const snap = memory.snapshot();
  if (state.hasIndex) {
    await memory.exec("DROP INDEX IF EXISTS t_a_idx");
  }
  await memory.exec("DELETE FROM t");
  memory.restore(snap);

  const after = await captureProbeResults(memory, probes);
  assertProbeResultsEqual(`${label}-checkpoint-probes-${index}`, before, after);
  await compareStateOrReport(`${label}-checkpoint-${index}`, { op, index, sqlLog: state.sqlLog }, memory, postgres);
}

/**
 * Dual-engine dump-after-each simulation for a stateful (or mixed) op sequence.
 * Ops resolve against a SimState so every emitted statement is valid-by-construction.
 */
export async function runSequence(ops: readonly MixedOp[], options: RunSequenceOptions): Promise<void> {
  const schemaKind = options.schemaKind ?? "default";
  const schema = options.schema ?? schemaFor(schemaKind);
  const dump = options.dumpAfterEveryStep ?? true;
  const label = options.label;

  await withDatabases(async (memory, postgres) => {
    compareOutcomeOrReport(`${label}-ddl`, schema, ops, await memory.exec(schema), await postgres.exec(schema));
    if (dump) await compareStateOrReport(`${label}-ddl-dump`, ops, memory, postgres);

    const state = initialSimState(schemaKind);
    state.sqlLog.push(schema);

    for (const [index, op] of ops.entries()) {
      if (op.kind === "checkpoint") {
        // restore() is illegal inside an open transaction — checkpoint only between txns.
        if (state.inTxn) continue;
        await runCheckpoint(label, index, op, memory, postgres, state);
        continue;
      }

      const resolved = resolveOp(op, state);
      if (resolved === null) continue;

      if (resolved.beginFirst) {
        compareOutcomeOrReport(
          `${label}-begin-${index}`,
          "BEGIN",
          op,
          await memory.exec("BEGIN"),
          await postgres.exec("BEGIN"),
        );
        state.sqlLog.push("BEGIN");
        if (dump) await compareStateOrReport(`${label}-begin-dump-${index}`, op, memory, postgres);
      }

      const isQuery = resolved.isQuery || QUERY_KINDS.has(op.kind);
      if (READ_ONLY_QUERY_KINDS.has(op.kind)) {
        state.probeQueries.push(resolved.sql);
      }
      await applyResolved(label, index, op, resolved.sql, isQuery, memory, postgres);
      if (!resolved.isQuery) state.sqlLog.push(resolved.sql);
      if (dump) await compareStateOrReport(`${label}-dump-${index}`, { op, index }, memory, postgres);
    }

    if (options.finalizeCommit !== false && state.inTxn) {
      compareOutcomeOrReport(
        `${label}-final-commit`,
        "COMMIT",
        ops,
        await memory.exec("COMMIT"),
        await postgres.exec("COMMIT"),
      );
      state.sqlLog.push("COMMIT");
    }
    await compareStateOrReport(`${label}-final-state`, ops, memory, postgres);
  });
}

/**
 * Run a sequence; on failure, greedily minimize the op list (preserving the
 * failure) and rethrow with a standalone SQL repro script appended.
 */
export async function runSequenceOrMinimize(ops: readonly MixedOp[], options: RunSequenceOptions): Promise<void> {
  try {
    await runSequence(ops, options);
  } catch (error) {
    const stillFails = async (candidate: readonly MixedOp[]): Promise<boolean> => {
      try {
        await runSequence(candidate, options);
        return false;
      } catch {
        return true;
      }
    };
    const minimized = await minimizeOps(ops, stillFails, { maxAttempts: 80 });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n\n${formatReproAdvice(minimized, fuzzSeed(), options.schemaKind ?? "default")}`);
  }
}
