import { EngineCtx } from "../expressions/context.ts";
import { replicaRole } from "../storage/guc.ts";
import { pgError } from "../errors/error.ts";
import type { SetConstraintsStmt } from "../ast/nodes.ts";
import { flushDeferredForeignKeys } from "../constraints/enforce.ts";
import type { DatabaseState, SchemaData } from "../storage/database-state.ts";
import { evalPredicate } from "./select.ts";
import { triggerScope } from "./triggers-scope.ts";
import { unsupported } from "../errors/error.ts";
import type { TableData, TriggerMeta } from "../storage/database-state.ts";
import type { Datum } from "../types/value.ts";
import type { ExecEnv, Relation } from "./relation.ts";

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
  if (replicaRole(env.ctx.state)) return { row };
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
    // NEW is NULL in a DELETE trigger; a BEFORE trigger sees the row as earlier BEFORE triggers left it
    const triggerNew = event === "delete" ? null : timing === "before" ? row : newRow;
    const result = executor(env, table, t, event, oldRow, triggerNew);
    if (timing === "before") {
      if (result === null) return { row: null };
      if (event !== "delete") row = result;
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

/** The rows a statement changed, as the `REFERENCING` transition tables of its AFTER statement triggers. */
export interface TransitionRows {
  /** rows before the change (UPDATE, DELETE) */
  oldRows: Datum[][];
  /** rows after the change (INSERT, UPDATE); position-aligned with `oldRows` for UPDATE */
  newRows: Datum[][];
}

function transitionRelation(table: TableData, name: string, rows: Datum[][]): Relation {
  return {
    columns: table.columns.map((c) => ({ name: c.name, type: c.type.id, table: name })),
    rows,
  };
}

/**
 * Fire the statement-level triggers of `table` for `event`, once, in trigger-name order. AFTER triggers
 * that declare transition tables read them as relations named by their `REFERENCING` clause; the
 * function body sees nothing else of the statement (no outer CTEs, parameters or scope).
 */
export function fireStatementTriggers(
  env: ExecEnv,
  table: TableData,
  timing: "before" | "after",
  event: TriggerEvent,
  transitions?: TransitionRows,
): void {
  if (replicaRole(env.ctx.state)) return;
  const fired = table.triggers
    .filter((t) => !t.forEachRow && t.timing === timing && matches(t, event))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const t of fired) {
    if (!executor) throw unsupported(`trigger "${t.name}" execution`);
    const ctes = new Map<string, Relation>();
    if (t.oldTable !== undefined)
      ctes.set(t.oldTable, transitionRelation(table, t.oldTable, transitions?.oldRows ?? []));
    if (t.newTable !== undefined)
      ctes.set(t.newTable, transitionRelation(table, t.newTable, transitions?.newRows ?? []));
    // Statement triggers run inside the statement that fired them: its row count is not theirs to change.
    const changes = env.ctx.state.changes;
    try {
      executor({ ctx: env.ctx, params: null, ctes, outer: null }, table, t, event, null, null);
    } finally {
      env.ctx.state.changes = changes;
    }
  }
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
  // Constraint triggers and foreign keys share SET CONSTRAINTS; both are looked up by name per schema.
  const matches: Array<{ schema: string; name: string; deferrable: boolean }> = [];
  const candidates = (schema: SchemaData) =>
    [...schema.tables.values()].flatMap((table) => [
      ...table.triggers
        .filter((t) => t.constraint)
        .map((t) => ({ schema: schema.name, name: t.name, deferrable: t.deferrable === true })),
      ...table.constraints
        .filter((c) => c.kind === "foreign_key")
        .map((c) => ({ schema: schema.name, name: c.name, deferrable: c.deferrable === true })),
    ]);
  if (stmt.names) {
    for (const name of stmt.names) {
      const schemas = name.length > 1 ? [name[name.length - 2]!] : state.effectiveSearchPath();
      let found = false;
      for (const schemaName of schemas) {
        const schema = state.schemas.get(schemaName);
        const items = schema ? candidates(schema).filter((c) => c.name === name[name.length - 1]) : [];
        if (items.length) {
          matches.push(...items);
          found = true;
          break;
        }
      }
      if (!found) throw pgError("undefined_object", `constraint "${name.join(".")}" does not exist`, "42704");
    }
  } else {
    for (const schema of state.schemas.values()) matches.push(...candidates(schema).filter((c) => c.deferrable));
  }
  for (const match of matches)
    if (stmt.deferred && !match.deferrable)
      throw pgError("misuse", `constraint "${match.name}" is not deferrable`, "55000");
  const previous = new Map(state.constraintModes);
  for (const { schema, name } of matches) state.constraintModes.set(keyOf(schema, name), stmt.deferred);
  try {
    if (!stmt.deferred) {
      flushConstraintTriggers(state);
      flushDeferredForeignKeys(state);
    }
  } catch (error) {
    state.constraintModes = previous;
    throw error;
  }
}
