import type { ContractDb } from "../../harness/types.ts";
import {
  compareOrReport,
  compareOutcomeOrReport,
  compareStateOrReport,
  compareWriteOrReport,
  withDatabases,
} from "../helpers.ts";
import { assertProbeResultsEqual, captureProbeResults, probesForState } from "../snapshot-helpers.ts";
import {
  DEFAULT_SCHEMA,
  OUTCOME_KINDS,
  QUERY_KINDS,
  READ_ONLY_QUERY_KINDS,
  SIMPLE_SCHEMA,
  type DmlOp,
  type MixedOp,
  type SchemaKind,
  type SimState,
  initialSimState,
  resolveOp,
  schemaFor,
} from "./ops.ts";

export interface RunSequenceOptions {
  label: string;
  schema?: string;
  schemaKind?: SchemaKind;
  /** Use bound-parameter DML path (O3 stateful). */
  boundDml?: boolean;
  dumpAfterEveryStep?: boolean;
  finalizeCommit?: boolean;
}

function shouldDumpState(state: SimState): boolean {
  // FTS shadow/aux tables differ in logical dump vs bun:sqlite (intentional divergence).
  return !state.hasFts;
}

function applyResolved(
  label: string,
  index: number,
  op: MixedOp | DmlOp,
  sql: string,
  isQuery: boolean,
  memory: ContractDb,
  sqlite: ContractDb,
  useOutcome: boolean,
): void {
  const tag = `${label}-${op.kind}-${index}`;
  if (isQuery) {
    compareOrReport(tag, sql, op, memory.query(sql), sqlite.query(sql));
    return;
  }
  if (useOutcome) {
    compareOutcomeOrReport(tag, sql, op, memory.exec(sql), sqlite.exec(sql));
    return;
  }
  compareWriteOrReport(tag, sql, op, memory.exec(sql), sqlite.exec(sql));
}

function runCheckpoint(
  label: string,
  index: number,
  op: MixedOp,
  memory: ContractDb,
  sqlite: ContractDb,
  state: SimState,
): void {
  if (memory.inTransaction()) {
    return;
  }
  const probes = probesForState(state);
  const before = captureProbeResults(memory, probes);

  const snap = memory.snapshot();
  state.snap = snap;
  if (state.hasIndex) {
    memory.exec("DROP INDEX IF EXISTS t_a");
  }
  memory.exec("DELETE FROM t WHERE 1");
  memory.restore(snap);

  const after = captureProbeResults(memory, probes);
  assertProbeResultsEqual(`${label}-checkpoint-probes-${index}`, before, after);
  compareStateOrReport(`${label}-checkpoint-${index}`, { op, index, sqlLog: state.sqlLog }, memory, sqlite);
}

/**
 * Dual-engine dump-after-each simulation for a mixed (or DML-only) op sequence.
 */
export function runSequence(ops: readonly MixedOp[], options: RunSequenceOptions): void {
  const schemaKind = options.schemaKind ?? "plain";
  const schema = options.schema ?? schemaFor(schemaKind);
  const dump = options.dumpAfterEveryStep ?? true;
  const label = options.label;

  withDatabases((memory, sqlite) => {
    compareOutcomeOrReport(`${label}-ddl`, schema, ops, memory.exec(schema), sqlite.exec(schema));
    if (dump) compareStateOrReport(`${label}-ddl-dump`, ops, memory, sqlite);

    const state = initialSimState(schemaKind);
    state.sqlLog.push(schema);

    for (const [index, op] of ops.entries()) {
      if (op.kind === "checkpoint") {
        // SQLM snapshot intentionally omits triggers / ATTACH / FTS (snapshot-exclusions).
        if (state.hasTrigger || state.hasAttach || state.hasFts) continue;
        runCheckpoint(label, index, op, memory, sqlite, state);
        continue;
      }

      const resolved = resolveOp(op, state);
      if (resolved === null) continue;

      if (resolved.extraSql) {
        for (const [extraIndex, extra] of resolved.extraSql.entries()) {
          compareOutcomeOrReport(
            `${label}-extra-${index}-${extraIndex}`,
            extra,
            op,
            memory.exec(extra),
            sqlite.exec(extra),
          );
          state.sqlLog.push(extra);
          if (dump && shouldDumpState(state))
            compareStateOrReport(`${label}-extra-dump-${index}-${extraIndex}`, op, memory, sqlite);
        }
      }

      if (resolved.beginFirst) {
        compareOutcomeOrReport(`${label}-begin-${index}`, "BEGIN", op, memory.exec("BEGIN"), sqlite.exec("BEGIN"));
        state.sqlLog.push("BEGIN");
        if (dump && shouldDumpState(state)) compareStateOrReport(`${label}-begin-dump-${index}`, op, memory, sqlite);
      }

      const useOutcome = OUTCOME_KINDS.has(op.kind) || state.hasTrigger || state.hasFts;
      const isQuery = resolved.isQuery || QUERY_KINDS.has(op.kind);
      if (READ_ONLY_QUERY_KINDS.has(op.kind) && resolved.sql !== "<checkpoint>") {
        state.probeQueries.push(resolved.sql);
      }
      applyResolved(label, index, op, resolved.sql, isQuery, memory, sqlite, useOutcome);
      if (!resolved.isQuery && resolved.sql !== "<checkpoint>") {
        state.sqlLog.push(resolved.sql);
      }
      if (dump && shouldDumpState(state)) compareStateOrReport(`${label}-dump-${index}`, { op, index }, memory, sqlite);
    }

    if (options.finalizeCommit !== false && state.inTxn) {
      compareOutcomeOrReport(`${label}-final-commit`, "COMMIT", ops, memory.exec("COMMIT"), sqlite.exec("COMMIT"));
      state.sqlLog.push("COMMIT");
      if (dump && shouldDumpState(state)) compareStateOrReport(`${label}-final-dump`, ops, memory, sqlite);
    }
  });
}

/** O3-style bound DML dump-after-each on a simple schema. */
export function runBoundDmlSequence(ops: readonly DmlOp[], options: Omit<RunSequenceOptions, "boundDml">): void {
  const schema = options.schema ?? SIMPLE_SCHEMA;
  const label = options.label;
  const dump = options.dumpAfterEveryStep ?? true;

  withDatabases((memory, sqlite) => {
    compareOrReport(`${label}-ddl`, schema, ops, memory.exec(schema), sqlite.exec(schema));
    if (dump) compareStateOrReport(`${label}-ddl-dump`, ops, memory, sqlite);

    let nextId = 1;
    for (const [index, op] of ops.entries()) {
      if (op.kind === "insert") {
        const sql = "INSERT INTO t(id, a, b) VALUES (?, ?, ?)";
        const params = [nextId++, op.a, op.b];
        compareWriteOrReport(`${label}-insert-${index}`, sql, op, memory.exec(sql, params), sqlite.exec(sql, params));
      } else if (op.kind === "update") {
        const sql = "UPDATE t SET a = ?, b = ? WHERE id = (SELECT max(id) FROM t)";
        compareWriteOrReport(
          `${label}-update-${index}`,
          sql,
          op,
          memory.exec(sql, [op.a, op.b]),
          sqlite.exec(sql, [op.a, op.b]),
        );
      } else if (op.kind === "delete") {
        const sql = "DELETE FROM t WHERE a = ?";
        compareWriteOrReport(`${label}-delete-${index}`, sql, op, memory.exec(sql, [op.a]), sqlite.exec(sql, [op.a]));
      } else {
        const sql = "SELECT id, a, b FROM t ORDER BY id";
        compareOrReport(`${label}-select-${index}`, sql, op, memory.query(sql), sqlite.query(sql));
      }
      if (dump) compareStateOrReport(`${label}-step-dump-${index}`, op, memory, sqlite);
    }
  });
}

export { DEFAULT_SCHEMA, SIMPLE_SCHEMA };
