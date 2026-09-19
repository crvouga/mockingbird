import { deepCompareResults } from "../../harness/normalize.ts";
import type { ContractDb, QueryResult } from "../../harness/types.ts";
import { fuzzSeed } from "../config.ts";
import { compareOrReport, compareOutcomeOrReport, compareStateOrReport, withDatabases } from "../helpers.ts";
import { bootstrapDdl, buildStep } from "./actions.ts";
import { ChoiceSource } from "./choice.ts";
import { enabledActions, initialWalkModel, type WalkModel, type WalkStep } from "./model.ts";

export interface RunWalkOptions {
  depth: number;
  label?: string;
  dumpAfterEveryStep?: boolean;
}

function isReadOnly(step: WalkStep): boolean {
  return (
    step.kind.startsWith("select_") ||
    step.kind === "returning_insert" ||
    step.kind === "returning_update" ||
    step.kind === "returning_delete"
  );
}

/** Write compare that ignores change counters (DO NOTHING / trigger drift); state dump catches data bugs. */
function compareWalkWrite(label: string, sql: string, setup: unknown, memory: QueryResult, sqlite: QueryResult): void {
  if (memory.ok && sqlite.ok) {
    const comparison = deepCompareResults(memory, sqlite, {
      messageTier: "B",
      ignoreErrorPhase: true,
      ignoreWriteCounters: true,
    });
    if (comparison.equal) return;
    throw new Error(
      [
        `Differential mismatch (${label})`,
        `seed=${fuzzSeed()}`,
        `Replay: SQLITE_MEM_FUZZ_SEED=${fuzzSeed()} bun test tests/fuzz/random-walk.test.ts`,
        `SQL: ${sql}`,
        `Setup: ${JSON.stringify(setup)}`,
        `Reason: ${comparison.reason}`,
        `memory: ${JSON.stringify(memory)}`,
        `sqlite: ${JSON.stringify(sqlite)}`,
      ].join("\n"),
    );
  }
  compareOutcomeOrReport(label, sql, setup, memory, sqlite);
}

function execStep(
  label: string,
  index: number,
  step: WalkStep,
  memory: ContractDb,
  sqlite: ContractDb,
  model: WalkModel,
): void {
  const tag = `${label}-${step.kind}-${index}`;

  if (step.beginFirst) {
    compareOutcomeOrReport(`${tag}-begin`, "BEGIN", step, memory.exec("BEGIN"), sqlite.exec("BEGIN"));
  }

  const forceOutcome = model.triggers.size > 0 && step.mode === "write";

  if (step.mode === "rows") {
    compareOrReport(tag, step.sql, step, memory.query(step.sql), sqlite.query(step.sql));
    return;
  }
  if (step.mode === "write" && !forceOutcome) {
    compareWalkWrite(tag, step.sql, step, memory.exec(step.sql), sqlite.exec(step.sql));
    return;
  }
  if (step.mode === "error") {
    const mem = memory.exec(step.sql);
    const ora = sqlite.exec(step.sql);
    if (mem.ok || ora.ok) {
      throw new Error(
        [
          `Expected error on both engines (${tag})`,
          `seed=${fuzzSeed()}`,
          `SQL: ${step.sql}`,
          `expect=${step.expect ?? "?"}`,
          `memory.ok=${mem.ok} sqlite.ok=${ora.ok}`,
          `memory: ${JSON.stringify(mem)}`,
          `sqlite: ${JSON.stringify(ora)}`,
        ].join("\n"),
      );
    }
    // Category-only: message text can differ while categories match.
    compareOutcomeOrReport(tag, step.sql, step, mem, ora);
    return;
  }
  compareOutcomeOrReport(tag, step.sql, step, memory.exec(step.sql), sqlite.exec(step.sql));
}

function runCheckpoint(
  label: string,
  index: number,
  step: WalkStep,
  memory: ContractDb,
  sqlite: ContractDb,
  model: WalkModel,
): void {
  if (memory.inTransaction()) return;
  const probes = model.probeQueries.slice(-5);
  const before: QueryResult[] = probes.map((sql) => memory.query(sql));

  const snap = memory.snapshot();
  for (const name of model.tableNames()) {
    memory.exec(`DELETE FROM "${name.replaceAll('"', '""')}"`);
  }
  memory.restore(snap);

  const after: QueryResult[] = probes.map((sql) => memory.query(sql));
  for (let i = 0; i < probes.length; i++) {
    compareOrReport(`${label}-checkpoint-probe-${index}-${i}`, probes[i]!, step, before[i]!, after[i]!);
  }
  compareStateOrReport(`${label}-checkpoint-${index}`, { step, index, sqlLog: model.sqlLog }, memory, sqlite);
}

/**
 * Build a walk trace from a decision vector without touching databases (determinism check).
 */
export function buildTraceOnly(ints: readonly number[], depth: number): WalkStep[] {
  const choose = new ChoiceSource(ints);
  const model = initialWalkModel();
  const steps: WalkStep[] = [];
  for (let i = 0; i < depth; i++) {
    const enabled = enabledActions(model);
    const kind = choose.pickWeighted(enabled);
    const step = buildStep(kind, model, choose);
    step.apply(model);
    if (step.beginFirst) model.sqlLog.push("BEGIN");
    if (!step.checkpoint) model.sqlLog.push(step.sql);
    if (isReadOnly(step) && !step.checkpoint) model.probeQueries.push(step.sql);
    steps.push(step);
  }
  return steps;
}

/**
 * Dual-engine dump-after-each random walk.
 */
export function runWalk(ints: readonly number[], options: RunWalkOptions): WalkStep[] {
  const depth = options.depth;
  const label = options.label ?? "walk";
  const dump = options.dumpAfterEveryStep ?? true;
  const steps: WalkStep[] = [];

  withDatabases((memory, sqlite) => {
    const ddl = bootstrapDdl();
    compareOutcomeOrReport(`${label}-ddl`, ddl, {}, memory.exec(ddl), sqlite.exec(ddl));
    if (dump) compareStateOrReport(`${label}-ddl-dump`, {}, memory, sqlite);

    const choose = new ChoiceSource(ints);
    const model = initialWalkModel();

    for (let index = 0; index < depth; index++) {
      const enabled = enabledActions(model);
      const kind = choose.pickWeighted(enabled);
      const step = buildStep(kind, model, choose);

      try {
        if (step.checkpoint) {
          runCheckpoint(label, index, step, memory, sqlite, model);
        } else {
          execStep(label, index, step, memory, sqlite, model);
          if (step.beginFirst) model.sqlLog.push("BEGIN");
          if (step.mode !== "error") model.sqlLog.push(step.sql);
          if (isReadOnly(step)) model.probeQueries.push(step.sql);
          if (dump) compareStateOrReport(`${label}-dump-${index}`, { step, index }, memory, sqlite);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          [
            message,
            `walk-step=${index} kind=${step.kind} depth=${depth}`,
            `seed=${fuzzSeed()}`,
            `Replay: SQLITE_MEM_FUZZ_SEED=${fuzzSeed()} SQLITE_MEM_WALK_STEPS=${depth} bun test tests/fuzz/random-walk.test.ts`,
            `SQL: ${step.sql}`,
            `trace-so-far:`,
            ...steps.map((s, i) => `  ${i}: ${s.kind} :: ${s.sql}`),
            `  ${index}: ${step.kind} :: ${step.sql}`,
          ].join("\n"),
        );
      }

      step.apply(model);
      steps.push(step);
      model.trace.push(step);
    }

    if (model.inTxn) {
      compareOutcomeOrReport(`${label}-final-commit`, "COMMIT", steps, memory.exec("COMMIT"), sqlite.exec("COMMIT"));
      if (dump) compareStateOrReport(`${label}-final-dump`, steps, memory, sqlite);
    }
  });

  return steps;
}
