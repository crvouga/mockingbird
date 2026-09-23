import { expect } from "bun:test";
import { type CompareOptions, deepCompareResults } from "./normalize.ts";
import type { QueryResult } from "./types.ts";

export function expectParity(a: QueryResult, b: QueryResult, options?: CompareOptions): void {
  const queryShaped = (a.columns?.length ?? 0) > 0 || (b.columns?.length ?? 0) > 0;
  const bothFailed = a.ok === false && b.ok === false;
  const comparison = deepCompareResults(a, b, {
    // SELECT leftovers: engines report different `changes` bookkeeping after SELECT.
    ignoreWriteCounters: queryShaped,
    // Oracle fails at the protocol level; the engine distinguishes prepare/step.
    ignoreErrorPhase: bothFailed,
    ...options,
  });
  if (!comparison.equal) {
    expect(comparison.reason ?? "results differ").toBe(undefined);
  }
}

/** ts_rank and similar float ranking: order-sensitive compare with tiny epsilon. */
export function expectRankParity(a: QueryResult, b: QueryResult): void {
  expectParity(a, b, { realEpsilon: 1e-12, ignoreWriteCounters: true });
}
