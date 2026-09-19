import { fuzzSeed } from "../config.ts";
import {
  compareOrReport,
  compareOutcomeOrReport,
  compareStateOrReport,
  compareWriteOrReport,
  withDatabases,
} from "../helpers.ts";
import { bootstrapDdl } from "./actions.ts";
import type { WalkStep } from "./model.ts";
import { buildTraceOnly, type RunWalkOptions, runWalk } from "./runner.ts";

/**
 * Replay a concrete step list (no model) and assert parity after every step.
 */
export function replayTrace(steps: readonly WalkStep[], options?: { dumpAfterEveryStep?: boolean }): void {
  const dump = options?.dumpAfterEveryStep ?? true;
  withDatabases((memory, sqlite) => {
    const ddl = bootstrapDdl();
    compareOutcomeOrReport("replay-ddl", ddl, {}, memory.exec(ddl), sqlite.exec(ddl));
    if (dump) compareStateOrReport("replay-ddl-dump", {}, memory, sqlite);

    for (const [index, step] of steps.entries()) {
      if (step.checkpoint) {
        if (!memory.inTransaction()) {
          const snap = memory.snapshot();
          memory.restore(snap);
          compareStateOrReport(`replay-checkpoint-${index}`, step, memory, sqlite);
        }
        continue;
      }
      if (step.beginFirst) {
        compareOutcomeOrReport(`replay-begin-${index}`, "BEGIN", step, memory.exec("BEGIN"), sqlite.exec("BEGIN"));
        if (dump) compareStateOrReport(`replay-begin-dump-${index}`, step, memory, sqlite);
      }
      const tag = `replay-${step.kind}-${index}`;
      if (step.mode === "rows") {
        compareOrReport(tag, step.sql, step, memory.query(step.sql), sqlite.query(step.sql));
      } else if (step.mode === "write") {
        compareWriteOrReport(tag, step.sql, step, memory.exec(step.sql), sqlite.exec(step.sql));
      } else if (step.mode === "error") {
        const mem = memory.exec(step.sql);
        const ora = sqlite.exec(step.sql);
        if (mem.ok || ora.ok) {
          throw new Error(`Expected error on both engines (${tag}): ${step.sql}`);
        }
        compareOutcomeOrReport(tag, step.sql, step, mem, ora);
      } else {
        compareOutcomeOrReport(tag, step.sql, step, memory.exec(step.sql), sqlite.exec(step.sql));
      }
      if (dump) compareStateOrReport(`replay-dump-${index}`, { step, index }, memory, sqlite);
    }
  });
}

export type FailureCheck = (steps: readonly WalkStep[]) => boolean;

/**
 * Greedy back-to-front removal minimizer (same shape as dst/minimize.ts).
 */
export function minimizeTrace(
  steps: readonly WalkStep[],
  stillFails: FailureCheck,
  options?: { maxAttempts?: number },
): WalkStep[] {
  const maxAttempts = options?.maxAttempts ?? 80;
  let current = [...steps];
  let attempts = 0;
  let progress = true;

  while (progress && attempts < maxAttempts) {
    progress = false;
    for (let i = current.length - 1; i >= 0 && attempts < maxAttempts; i--) {
      const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
      attempts++;
      if (stillFails(candidate)) {
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
    `-- Replay: SQLITE_MEM_FUZZ_SEED=${seed} SQLITE_MEM_WALK_STEPS=${depth} bun test tests/fuzz/random-walk.test.ts`,
    `${bootstrapDdl()};`,
  ];
  for (const step of steps) {
    if (step.checkpoint) {
      lines.push("-- checkpoint (SQLM snapshot / restore on memory)");
      continue;
    }
    if (step.beginFirst) lines.push("BEGIN;");
    if (step.mode === "error") {
      lines.push(`-- expect error: ${step.expect ?? "unknown"}`);
    }
    lines.push(`${step.sql};`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Run a walk; on failure, greedily minimize the concrete step list and append a SQL repro.
 */
export function runWalkOrMinimize(ints: readonly number[], options: RunWalkOptions): WalkStep[] {
  try {
    return runWalk(ints, options);
  } catch (error) {
    const built = buildTraceOnly(ints, options.depth);
    const stillFails = (candidate: readonly WalkStep[]): boolean => {
      try {
        replayTrace(candidate, { dumpAfterEveryStep: true });
        return false;
      } catch {
        return true;
      }
    };
    const minimized = minimizeTrace(built, stillFails, { maxAttempts: 80 });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n\n${formatWalkRepro(minimized, fuzzSeed(), options.depth)}`);
  }
}
