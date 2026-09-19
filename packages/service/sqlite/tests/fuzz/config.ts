import * as fc from "fast-check";

/**
 * Global deterministic seed for property tests.
 *
 * Override with env:
 *   SQLITE_MEM_FUZZ_SEED=12345 bun test tests/fuzz
 *
 * On failure, fast-check prints `seed` and `path` — re-run with those values
 * via SQLITE_MEM_FUZZ_SEED / SQLITE_MEM_FUZZ_PATH for an exact replay.
 */
export function fuzzSeed(): number {
  const raw = process.env.SQLITE_MEM_FUZZ_SEED;
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid SQLITE_MEM_FUZZ_SEED: ${raw}`);
    }
    return parsed | 0;
  }
  return 0x5a17e_0e1;
}

export function fuzzPath(): string | undefined {
  const path = process.env.SQLITE_MEM_FUZZ_PATH;
  return path && path.length > 0 ? path : undefined;
}

export function fuzzRuns(defaultRuns: number): number {
  const raw = process.env.SQLITE_MEM_FUZZ_RUNS;
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new Error(`Invalid SQLITE_MEM_FUZZ_RUNS: ${raw}`);
    }
    return Math.floor(parsed);
  }
  return defaultRuns;
}

export function fuzzAssertConfig(numRuns: number): Parameters<typeof fc.assert>[1] {
  const path = fuzzPath();
  return {
    seed: fuzzSeed(),
    numRuns: path ? 1 : fuzzRuns(numRuns),
    verbose: 1,
    endOnFailure: true,
    ...(path ? { path } : {}),
  };
}

/** Safe non-integer finite floats (avoids integer/real typeof flakes vs SQLite). */
export const realArb = fc
  .integer({ min: -1_000_000, max: 1_000_000 })
  .map((n) => n / 1000)
  .filter((n) => !Number.isInteger(n));

export const intArb = fc.integer({ min: -1000, max: 1000 });
export const textArb = fc.string({ maxLength: 24 }).filter((s) => !s.includes("\0") && !s.includes("\uFFFD"));
export const nullArb = fc.constant(null);

export type FuzzSqlValue = null | number | string;

export const valueArb: fc.Arbitrary<FuzzSqlValue> = fc.oneof(nullArb, intArb, realArb, textArb);
