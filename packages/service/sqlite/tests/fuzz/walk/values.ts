import type { SqlValue } from "../../harness/types.ts";
import { sqlLiteral } from "../helpers.ts";
import type { ChoiceSource } from "./choice.ts";

/** Edge-case integers (safe for SQLite affinity; no i64-only bigint in INSERT literals by default). */
export const INT_POOL: readonly number[] = [
  0, 1, -1, 2, -2, 42, -42, 100, -100, 1000, -1000, 2_147_483_647, -2_147_483_648,
];

/** Non-integer finite floats (avoids integer/real typeof flakes). */
export const REAL_POOL: readonly number[] = [0.5, -0.5, 1.25, -1.25, 123.456, -123.456, 1e-7, -1e-7, 1e15, -1e15];

export const TEXT_POOL: readonly string[] = [
  "",
  "a",
  "ab",
  "hello",
  "world",
  "O'Brien",
  "foo'bar",
  "  spaced  ",
  "\t",
  "café",
  "日本語",
  "x".repeat(64),
  "y".repeat(200),
];

export const BLOB_POOL: readonly Uint8Array[] = [
  new Uint8Array([]),
  new Uint8Array([0]),
  new Uint8Array([0xff]),
  new Uint8Array([1, 2, 3]),
  new Uint8Array([0, 0, 0, 1]),
];

export type WalkSqlValue = null | number | string | Uint8Array;

export function pickInt(c: ChoiceSource): number {
  return c.fromPool(INT_POOL);
}

export function pickReal(c: ChoiceSource): number {
  return c.fromPool(REAL_POOL);
}

export function pickText(c: ChoiceSource): string {
  return c.fromPool(TEXT_POOL);
}

export function pickBlob(c: ChoiceSource): Uint8Array {
  return c.fromPool(BLOB_POOL);
}

/** Nullable scalar for INT affinity columns. */
export function pickIntOrNull(c: ChoiceSource): number | null {
  if (c.chance(15)) return null;
  return pickInt(c);
}

/** Nullable scalar for TEXT affinity columns. */
export function pickTextOrNull(c: ChoiceSource): string | null {
  if (c.chance(15)) return null;
  return pickText(c);
}

/** Nullable REAL (non-integer). */
export function pickRealOrNull(c: ChoiceSource): number | null {
  if (c.chance(15)) return null;
  return pickReal(c);
}

export function renderLiteral(value: WalkSqlValue | SqlValue): string {
  return sqlLiteral(value as SqlValue);
}

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
