import type { SqlValue } from "../../harness/types.ts";
import { sqlLiteral } from "../helpers.ts";
import type { ChoiceSource } from "./choice.ts";

export const INT_POOL: readonly number[] = [
  0, 1, -1, 2, -2, 42, -42, 100, -100, 1000, -1000, 2_147_483_647, -2_147_483_648,
];

export const REAL_POOL: readonly number[] = [0.5, -0.5, 1.25, -1.25, 123.456, -123.456, 1e-7, -1e-7];

export const TEXT_POOL: readonly string[] = [
  "",
  "a",
  "ab",
  "hello",
  "world",
  "O'Brien",
  "foo'bar",
  "  spaced  ",
  "café",
  "日本語",
  "x".repeat(64),
  "y".repeat(120),
];

export const NUMERIC_POOL: readonly string[] = ["0", "1", "-1", "0.5", "123.45", "999999999.999"];

export type WalkSqlValue = null | number | string | boolean;

export function pickInt(c: ChoiceSource): number {
  return c.fromPool(INT_POOL);
}

export function pickReal(c: ChoiceSource): number {
  return c.fromPool(REAL_POOL);
}

export function pickText(c: ChoiceSource): string {
  return c.fromPool(TEXT_POOL);
}

export function pickIntOrNull(c: ChoiceSource): number | null {
  if (c.chance(15)) return null;
  return pickInt(c);
}

export function pickTextOrNull(c: ChoiceSource): string | null {
  if (c.chance(15)) return null;
  return pickText(c);
}

export function pickRealOrNull(c: ChoiceSource): number | null {
  if (c.chance(15)) return null;
  return pickReal(c);
}

export function pickNumericLiteral(c: ChoiceSource): string {
  return c.fromPool(NUMERIC_POOL);
}

export function renderLiteral(value: WalkSqlValue | SqlValue): string {
  return sqlLiteral(value as SqlValue);
}

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
