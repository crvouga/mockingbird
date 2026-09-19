import { SqliteError } from "../errors/index.ts";
import type { ErrorCategory } from "../errors/index.ts";

/** True when an error is an expected fast-path miss (fall through to full executor). */
export function isExpectedFastPathMiss(
  error: unknown,
  categories: readonly ErrorCategory[] = ["no_such_table"],
): boolean {
  return error instanceof SqliteError && categories.includes(error.category);
}
