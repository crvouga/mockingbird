import * as fc from "fast-check";

/** Draws consumed per walk step (kind + params). Exhaustion wraps modulo. */
export const DRAWS_PER_STEP = 8;

/**
 * Deterministic choice source over a fixed decision vector.
 * Trace = pure function of (seed, path, depth) because the vector length is fixed.
 */
export class ChoiceSource {
  private cursor = 0;

  constructor(private readonly ints: readonly number[]) {
    if (ints.length === 0) {
      throw new Error("ChoiceSource requires a non-empty decision vector");
    }
  }

  /** Next u32 from the vector (wraps). */
  next(): number {
    const v = this.ints[this.cursor % this.ints.length]!;
    this.cursor++;
    return v >>> 0;
  }

  /** Uniform pick in `[0, n)`. Returns 0 when `n <= 0`. */
  pick(n: number): number {
    if (n <= 0) return 0;
    return this.next() % n;
  }

  /** Pick an element from a non-empty array. */
  fromPool<T>(pool: readonly T[]): T {
    if (pool.length === 0) {
      throw new Error("fromPool called with empty pool");
    }
    return pool[this.pick(pool.length)]!;
  }

  /**
   * Weighted pick. Items with weight <= 0 are ignored.
   * Index 0 of the enabled list should be the "simplest" action for shrink friendliness.
   */
  pickWeighted<T>(items: readonly { weight: number; value: T }[]): T {
    const usable = items.filter((i) => i.weight > 0);
    if (usable.length === 0) {
      throw new Error("pickWeighted called with no positive weights");
    }
    let total = 0;
    for (const item of usable) total += item.weight;
    let r = this.pick(total);
    for (const item of usable) {
      if (r < item.weight) return item.value;
      r -= item.weight;
    }
    return usable[usable.length - 1]!.value;
  }

  /** True with probability `pct` percent (0–100). */
  chance(pct: number): boolean {
    if (pct <= 0) return false;
    if (pct >= 100) return true;
    return this.pick(100) < pct;
  }

  /** Inclusive integer in `[min, max]`. */
  int(min: number, max: number): number {
    if (max < min) return min;
    return min + this.pick(max - min + 1);
  }
}

/** Fixed-length decision vector for a walk of `depth` steps. */
export function decisionVectorArb(depth: number): fc.Arbitrary<number[]> {
  const len = Math.max(1, depth) * DRAWS_PER_STEP;
  return fc.array(fc.nat({ max: 0xffffffff }), { minLength: len, maxLength: len });
}

export function walkDepth(envKey: string, defaultDepth: number): number {
  const raw = process.env[envKey];
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new Error(`Invalid ${envKey}: ${raw}`);
    }
    return Math.floor(parsed);
  }
  return defaultDepth;
}
