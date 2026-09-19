import { SqliteError } from "../errors/index.ts";
import type { Row } from "../storage/row.ts";
import type { Table } from "../storage/table.ts";

/** Always-on invariant check (Tiger Style — not stripped in production). */
export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new SqliteError(`internal assertion failed: ${message}`, "other");
  }
}

/** Exhaustive switch helper — call when a union case should be impossible. */
export function assertUnreachable(value: never, message = "unreachable"): never {
  throw new SqliteError(`internal assertion failed: ${message} (${String(value)})`, "other");
}

/** Row payload must align with table column count after insert/update. */
export function assertRowShape(table: Table, row: Row): void {
  assert(row.values.length === table.columns.length, `row.values.length !== table.columns.length for ${table.name}`);
}

/** Maximum blob/string length enforced before allocation (matches bun:sqlite TOOBIG). */
export const SQLITE_MAX_LENGTH = 2_147_483_647;

export function assertBlobLength(length: number, _feature: string): void {
  if (!Number.isFinite(length) || length < 0) return;
  if (length >= SQLITE_MAX_LENGTH) {
    throw new SqliteError(`string or blob too big`, "other", "SQLITE_TOOBIG");
  }
}
