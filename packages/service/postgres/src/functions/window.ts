/**
 * Window function surface. The executor's window module implements the
 * evaluation; this registry only classifies names so the parser/executor can
 * route OVER() calls, and the inventory gate can enumerate them.
 */

export const WINDOW_FUNCTION_NAMES = new Set([
  "row_number",
  "rank",
  "dense_rank",
  "percent_rank",
  "cume_dist",
  "ntile",
  "lag",
  "lead",
  "first_value",
  "last_value",
  "nth_value",
]);

export function isWindowFunctionName(name: string): boolean {
  return WINDOW_FUNCTION_NAMES.has(name);
}
