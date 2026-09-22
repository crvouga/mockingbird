import type { BenchSpec, SuiteTier } from "../harness/types.ts";

export const CI: SuiteTier[] = ["ci", "default", "full"];
export const DEFAULT: SuiteTier[] = ["default", "full"];
export const FULL: SuiteTier[] = ["full"];

export function tiersForSize(n: number): SuiteTier[] {
  if (n <= 100) return CI;
  if (n <= 1000) return DEFAULT;
  return FULL;
}

export function spec(partial: BenchSpec): BenchSpec {
  return partial;
}
