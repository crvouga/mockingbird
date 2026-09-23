import { deepCompareResults } from "../../harness/normalize.ts";
import { fuzzSeed } from "../config.ts";
import { compareOrReport, compareOutcomeOrReport, compareStateOrReport, withDatabases } from "../helpers.ts";
import { bootstrapDdl } from "./actions.ts";
import type { WalkStep } from "./model.ts";
import { buildTraceOnly, type RunWalkOptions, runWalk } from "./runner.ts";

async function compareWalkWrite(
  label: string,
  sql: string,
  setup: unknown,
  memory: Awaited<ReturnType<import("../../harness/types.ts").ContractDb["exec"]>>,
  postgres: Awaited<ReturnType<import("../../harness/types.ts").ContractDb["exec"]>>,
): Promise<void> {
  if (memory.ok && postgres.ok) {
    const comparison = deepCompareResults(memory, postgres, {
      messageTier: "B",
      ignoreErrorPhase: true,
      ignoreWriteCounters: true,
    });
    if (comparison.equal) return;
    throw new Error(`Differential mismatch (${label}): ${comparison.reason}\nSQL: ${sql}`);
  }
  compareOutcomeOrReport(label, sql, setup, memory, postgres);
}

export async function replayTrace(
  steps: readonly WalkStep[],
  options?: { dumpAfterEveryStep?: boolean },
): Promise<void> {
  const dump = options?.dumpAfterEveryStep ?? true;
  await withDatabases(async (memory, postgres) => {
    const ddl = bootstrapDdl();
    compareOutcomeOrReport("replay-ddl", ddl, {}, await memory.exec(ddl), await postgres.exec(ddl));
    if (dump) await compareStateOrReport("replay-ddl-dump", {}, memory, postgres);

    for (const [index, step] of steps.entries()) {
      if (step.checkpoint) {
        if (!memory.inTransaction()) {
          const snap = memory.snapshot();
          memory.restore(snap);
          await compareStateOrReport(`replay-checkpoint-${index}`, step, memory, postgres);
        }
        continue;
      }
      if (step.beginFirst) {
        compareOutcomeOrReport(
          `replay-begin-${index}`,
          "BEGIN",
          step,
          await memory.exec("BEGIN"),
          await postgres.exec("BEGIN"),
        );
        if (dump) await compareStateOrReport(`replay-begin-dump-${index}`, step, memory, postgres);
      }
      const tag = `replay-${step.kind}-${index}`;
      if (step.mode === "rows") {
        compareOrReport(tag, step.sql, step, await memory.query(step.sql), await postgres.query(step.sql));
      } else if (step.mode === "write") {
        await compareWalkWrite(tag, step.sql, step, await memory.exec(step.sql), await postgres.exec(step.sql));
      } else if (step.mode === "error") {
        const mem = await memory.exec(step.sql);
        const ora = await postgres.exec(step.sql);
        if (mem.ok || ora.ok) throw new Error(`Expected error on both engines (${tag}): ${step.sql}`);
        compareOutcomeOrReport(tag, step.sql, step, mem, ora);
      } else {
        compareOutcomeOrReport(tag, step.sql, step, await memory.exec(step.sql), await postgres.exec(step.sql));
      }
      if (dump) await compareStateOrReport(`replay-dump-${index}`, { step, index }, memory, postgres);
    }
  });
}

export type FailureCheck = (steps: readonly WalkStep[]) => Promise<boolean>;

export async function minimizeTrace(
  steps: readonly WalkStep[],
  stillFails: FailureCheck,
  options?: { maxAttempts?: number },
): Promise<WalkStep[]> {
  const maxAttempts = options?.maxAttempts ?? 80;
  let current = [...steps];
  let attempts = 0;
  let progress = true;

  while (progress && attempts < maxAttempts) {
    progress = false;
    for (let i = current.length - 1; i >= 0 && attempts < maxAttempts; i--) {
      const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
      attempts++;
      if (await stillFails(candidate)) {
        current = candidate;
        progress = true;
      }
    }
  }
  return current;
}

export function formatWalkRepro(steps: readonly WalkStep[], seed: number, depth: number): string {
  const lines: string[] = [
    `-- minimized random-walk repro (seed=${seed}, depth=${depth})`,
    `-- Replay: POSTGRES_MEM_FUZZ_SEED=${seed} POSTGRES_MEM_WALK_STEPS=${depth} bun test tests/fuzz/random-walk.test.ts`,
    `${bootstrapDdl()};`,
  ];
  for (const step of steps) {
    if (step.checkpoint) {
      lines.push("-- checkpoint (PGMM snapshot / restore on memory)");
      continue;
    }
    if (step.beginFirst) lines.push("BEGIN;");
    if (step.mode === "error") lines.push(`-- expect error: ${step.expect ?? "unknown"}`);
    lines.push(`${step.sql};`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runWalkOrMinimize(ints: readonly number[], options: RunWalkOptions): Promise<WalkStep[]> {
  try {
    return await runWalk(ints, options);
  } catch (error) {
    const built = buildTraceOnly(ints, options.depth);
    const stillFails = async (candidate: readonly WalkStep[]): Promise<boolean> => {
      try {
        await replayTrace(candidate, { dumpAfterEveryStep: true });
        return false;
      } catch {
        return true;
      }
    };
    const minimized = await minimizeTrace(built, stillFails, { maxAttempts: 80 });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n\n${formatWalkRepro(minimized, fuzzSeed(), options.depth)}`);
  }
}
