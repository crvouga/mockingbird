import type { MixedOp } from "./ops.ts";

export type FailureCheck = (ops: readonly MixedOp[]) => Promise<boolean>;

export interface MinimizeOptions {
  /** Cap on `stillFails` invocations (each replays the full sequence on both engines). */
  maxAttempts?: number;
}

/**
 * Greedy op-removal minimizer: repeatedly try dropping one op at a time and
 * keep any removal that preserves the failure. Async because each candidate
 * replays against the PGlite oracle. Not a full delta-debugger — enough to
 * hand a small repro to a human.
 */
export async function minimizeOps(
  ops: readonly MixedOp[],
  stillFails: FailureCheck,
  options?: MinimizeOptions,
): Promise<MixedOp[]> {
  const maxAttempts = options?.maxAttempts ?? 80;
  let current = [...ops];
  let attempts = 0;
  let progress = true;

  while (progress && attempts < maxAttempts) {
    progress = false;
    // Walk back-to-front so an in-place removal never shifts unvisited indices.
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
