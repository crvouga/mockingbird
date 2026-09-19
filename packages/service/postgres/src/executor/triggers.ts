import { unsupported } from "../errors/error.ts";
import type { TableData, TriggerMeta } from "../storage/database-state.ts";
import type { Datum } from "../types/value.ts";
import type { ExecEnv } from "./relation.ts";

export type TriggerEvent = "insert" | "update" | "delete";

export interface TriggerFireResult {
  /** null = row operation skipped (BEFORE trigger returned NULL) */
  row: Datum[] | null;
}

function matches(t: TriggerMeta, event: TriggerEvent): boolean {
  return t.events.some((e) => e.event === event);
}

/**
 * Fire row-level triggers for one row. Trigger function bodies execute via
 * the plpgsql-lite interpreter in triggers-exec.ts (registered lazily).
 */
export type TriggerExecutor = (
  env: ExecEnv,
  table: TableData,
  trigger: TriggerMeta,
  event: TriggerEvent,
  oldRow: Datum[] | null,
  newRow: Datum[] | null,
) => Datum[] | null;

let executor: TriggerExecutor | null = null;

export function setTriggerExecutor(e: TriggerExecutor): void {
  executor = e;
}

export function fireRowTriggers(
  env: ExecEnv,
  table: TableData,
  timing: "before" | "after" | "instead_of",
  event: TriggerEvent,
  oldRow: Datum[] | null,
  newRow: Datum[] | null,
): TriggerFireResult {
  let row = newRow ?? oldRow;
  for (const t of table.triggers) {
    if (t.timing !== timing || !matches(t, event) || !t.forEachRow) continue;
    if (!executor) throw unsupported(`trigger "${t.name}" execution`);
    const result = executor(env, table, t, event, oldRow, timing === "before" ? row : newRow);
    if (timing === "before") {
      if (result === null) return { row: null };
      row = result;
    }
  }
  return { row };
}

export function hasRowTriggers(
  table: TableData,
  timing: "before" | "after" | "instead_of",
  event: TriggerEvent,
): boolean {
  return table.triggers.some((t) => t.timing === timing && matches(t, event) && t.forEachRow);
}
