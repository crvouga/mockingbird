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

function compareWalkWrite(
  label: string,
  sql: string,
  setup: unknown,
  memory: QueryResult,
  postgres: QueryResult,
): void {
  if (memory.ok && postgres.ok) {
    const comparison = deepCompareResults(memory, postgres, {
      messageTier: "B",
      ignoreErrorPhase: true,
      ignoreWriteCounters: true,
    });
    if (comparison.equal) return;
    throw new Error(
      [
        `Differential mismatch (${label})`,
        `seed=${fuzzSeed()}`,
        `Replay: POSTGRES_MEM_FUZZ_SEED=${fuzzSeed()} bun test tests/fuzz/random-walk.test.ts`,
        `SQL: ${sql}`,
        `Setup: ${JSON.stringify(setup)}`,
        `Reason: ${comparison.reason}`,
        `memory: ${JSON.stringify(memory)}`,
        `postgres: ${JSON.stringify(postgres)}`,
      ].join("\n"),
    );
  }
  compareOutcomeOrReport(label, sql, setup, memory, postgres);
}

async function execStep(
  label: string,
  index: number,
  step: WalkStep,
  memory: ContractDb,
  postgres: ContractDb,
): Promise<void> {
  const tag = `${label}-${step.kind}-${index}`;

  if (step.beginFirst) {
    compareOutcomeOrReport(`${tag}-begin`, "BEGIN", step, await memory.exec("BEGIN"), await postgres.exec("BEGIN"));
  }

  if (step.mode === "rows") {
    compareOrReport(tag, step.sql, step, await memory.query(step.sql), await postgres.query(step.sql));
    return;
  }
  if (step.mode === "write") {
    compareWalkWrite(tag, step.sql, step, await memory.exec(step.sql), await postgres.exec(step.sql));
    return;
  }
  if (step.mode === "error") {
    const mem = await memory.exec(step.sql);
    const ora = await postgres.exec(step.sql);
    if (mem.ok || ora.ok) {
      throw new Error(
        [
          `Expected error on both engines (${tag})`,
          `seed=${fuzzSeed()}`,
          `SQL: ${step.sql}`,
          `expect=${step.expect ?? "?"}`,
          `memory.ok=${mem.ok} postgres.ok=${ora.ok}`,
          `memory: ${JSON.stringify(mem)}`,
          `postgres: ${JSON.stringify(ora)}`,
        ].join("\n"),
      );
    }
    // Category-only: oracle vs memory syntax/constraint messages are not byte-identical.
    compareOutcomeOrReport(tag, step.sql, step, mem, ora);
    return;
  }
  compareOutcomeOrReport(tag, step.sql, step, await memory.exec(step.sql), await postgres.exec(step.sql));
}

async function runCheckpoint(
  label: string,
  index: number,
  step: WalkStep,
  memory: ContractDb,
  postgres: ContractDb,
  model: WalkModel,
): Promise<void> {
  if (memory.inTransaction()) return;
  const probes = model.probeQueries.slice(-5);
  const before: QueryResult[] = [];
  for (const sql of probes) before.push(await memory.query(sql));

  const snap = memory.snapshot();
  for (const name of model.tableNames()) {
    await memory.exec(`DELETE FROM "${name.replaceAll('"', '""')}"`);
  }
  memory.restore(snap);

  const after: QueryResult[] = [];
  for (const sql of probes) after.push(await memory.query(sql));
  for (let i = 0; i < probes.length; i++) {
    compareOrReport(`${label}-checkpoint-probe-${index}-${i}`, probes[i]!, step, before[i]!, after[i]!);
  }
  await compareStateOrReport(`${label}-checkpoint-${index}`, { step, index, sqlLog: model.sqlLog }, memory, postgres);
}

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

export async function runWalk(ints: readonly number[], options: RunWalkOptions): Promise<WalkStep[]> {
  const depth = options.depth;
  const label = options.label ?? "walk";
  const dump = options.dumpAfterEveryStep ?? true;
  const steps: WalkStep[] = [];

  await withDatabases(async (memory, postgres) => {
    const ddl = bootstrapDdl();
    compareOutcomeOrReport(`${label}-ddl`, ddl, {}, await memory.exec(ddl), await postgres.exec(ddl));
    if (dump) await compareStateOrReport(`${label}-ddl-dump`, {}, memory, postgres);

    const choose = new ChoiceSource(ints);
    const model = initialWalkModel();

    for (let index = 0; index < depth; index++) {
      const enabled = enabledActions(model);
      const kind = choose.pickWeighted(enabled);
      const step = buildStep(kind, model, choose);

      try {
        if (step.checkpoint) {
          await runCheckpoint(label, index, step, memory, postgres, model);
        } else {
          await execStep(label, index, step, memory, postgres);
          if (step.beginFirst) model.sqlLog.push("BEGIN");
          if (step.mode !== "error") model.sqlLog.push(step.sql);
          if (isReadOnly(step)) model.probeQueries.push(step.sql);
          if (dump) await compareStateOrReport(`${label}-dump-${index}`, { step, index }, memory, postgres);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          [
            message,
            `walk-step=${index} kind=${step.kind} depth=${depth}`,
            `seed=${fuzzSeed()}`,
            `Replay: POSTGRES_MEM_FUZZ_SEED=${fuzzSeed()} POSTGRES_MEM_WALK_STEPS=${depth} bun test tests/fuzz/random-walk.test.ts`,
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
      compareOutcomeOrReport(
        `${label}-final-commit`,
        "COMMIT",
        steps,
        await memory.exec("COMMIT"),
        await postgres.exec("COMMIT"),
      );
    }
    if (dump) await compareStateOrReport(`${label}-final-dump`, steps, memory, postgres);
  });

  return steps;
}
