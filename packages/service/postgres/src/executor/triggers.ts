import { EngineCtx } from "../expressions/context.ts";
import { pgError } from "../errors/error.ts";
import type { SetConstraintsStmt } from "../ast/nodes.ts";
import type { DatabaseState } from "../storage/database-state.ts";
import { evalPredicate } from "./select.ts";
import { triggerScope } from "./triggers-scope.ts";
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
    if (t.constraint && timing === "after") {
      // WHEN is evaluated when the row changes, never when the deferred event fires.
      if (t.when && !evalPredicate(env, triggerScope(table, newRow, oldRow), t.when)) continue;
      env.ctx.state.pendingTriggers.push({
        schema: table.schema,
        table: table.name,
        trigger: t.name,
        event,
        oldRow: oldRow?.slice() ?? null,
        newRow: newRow?.slice() ?? null,
      });
      continue;
    }
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

const keyOf = (schema: string, name: string) => JSON.stringify([schema, name]);

export function flushConstraintTriggers(state: DatabaseState, all = false): void {
  const env: ExecEnv = { ctx: new EngineCtx(state), params: null, ctes: new Map(), outer: null };
  for (let i = 0; i < state.pendingTriggers.length; ) {
    const pending = state.pendingTriggers[i]!;
    const table = state.schemas.get(pending.schema)?.tables.get(pending.table);
    const trigger = table?.triggers.find((t) => t.name === pending.trigger);
    if (!table || !trigger) {
      state.pendingTriggers.splice(i, 1);
      continue;
    }
    const deferred =
      trigger.deferrable && (state.constraintModes.get(keyOf(table.schema, trigger.name)) ?? trigger.initiallyDeferred);
    if (!all && state.inTransaction && deferred) {
      i++;
      continue;
    }
    if (!executor) throw unsupported(`trigger "${trigger.name}" execution`);
    // A trigger can execute DML that flushes the queue again. Consume this event
    // before entering its body so nested statements cannot fire it recursively.
    state.pendingTriggers.splice(i, 1);
    const changes = state.changes;
    try {
      executor(env, table, { ...trigger, when: null }, pending.event, pending.oldRow, pending.newRow);
    } catch (error) {
      state.pendingTriggers.splice(i, 0, pending);
      throw error;
    } finally {
      // Nested trigger writes do not replace the outer statement's row count.
      state.changes = changes;
    }
  }
}

export function setConstraints(state: DatabaseState, stmt: SetConstraintsStmt): void {
  if (!state.inTransaction) return;
  const matches: Array<{ schema: string; trigger: TriggerMeta }> = [];
  if (stmt.names) {
    for (const name of stmt.names) {
      const schemas = name.length > 1 ? [name[name.length - 2]!] : state.effectiveSearchPath();
      let found = false;
      for (const schema of schemas) {
        const items = [...(state.schemas.get(schema)?.tables.values() ?? [])].flatMap((table) =>
          table.triggers.filter((t) => t.constraint && t.name === name[name.length - 1]),
        );
        if (items.length) {
          for (const trigger of items) matches.push({ schema, trigger });
          found = true;
          break;
        }
      }
      if (!found) throw pgError("undefined_object", `constraint "${name.join(".")}" does not exist`, "42704");
    }
  } else {
    for (const schema of state.schemas.values())
      for (const table of schema.tables.values())
        for (const trigger of table.triggers)
          if (trigger.constraint && trigger.deferrable) matches.push({ schema: schema.name, trigger });
  }
  for (const { trigger } of matches)
    if (stmt.deferred && !trigger.deferrable)
      throw pgError("misuse", `constraint "${trigger.name}" is not deferrable`, "55000");
  const previous = new Map(state.constraintModes);
  for (const { schema, trigger } of matches) state.constraintModes.set(keyOf(schema, trigger.name), stmt.deferred);
  try {
    if (!stmt.deferred) flushConstraintTriggers(state);
  } catch (error) {
    state.constraintModes = previous;
    throw error;
  }
}
