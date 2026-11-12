import { triggerScope } from "./triggers-scope.ts";
import { pgError, unsupported } from "../errors/error.ts";
import type { TableData, TriggerMeta } from "../storage/database-state.ts";
import type { Datum } from "../types/value.ts";
import { callPlpgsqlTrigger } from "./plpgsql.ts";
import type { ExecEnv } from "./relation.ts";
import { evalPredicate } from "./select.ts";
import { setTriggerExecutor, type TriggerEvent } from "./triggers.ts";

/**
 * Trigger executor: runs the trigger's plpgsql function on the same interpreter as every other
 * plpgsql function, with NEW / OLD and the `TG_*` variables declared.
 */
function executeTrigger(
  env: ExecEnv,
  table: TableData,
  trigger: TriggerMeta,
  event: TriggerEvent,
  oldRow: Datum[] | null,
  newRow: Datum[] | null,
): Datum[] | null {
  const state = env.ctx.state;
  if (trigger.when !== null && !evalPredicate(env, triggerScope(table, newRow, oldRow), trigger.when)) {
    return newRow ?? oldRow; // WHEN false: trigger does not fire; row passes through unchanged
  }
  const fns = state.schemas.get(trigger.funcSchema)?.functions.get(trigger.funcName);
  const fn = fns?.find((f) => f.argTypes.length === 0) ?? fns?.[0];
  if (!fn) {
    throw pgError("undefined_function", `function ${trigger.funcSchema}.${trigger.funcName}() does not exist`, "42883");
  }
  if (fn.language !== "plpgsql") throw unsupported(`trigger functions in LANGUAGE ${fn.language}`);
  const saved = new Map(state.localSettings);
  for (const [name, value] of Object.entries(fn.settings ?? {})) state.localSettings.set(name, value);
  try {
    return callPlpgsqlTrigger(env, fn, {
      table: {
        name: table.name,
        schema: table.schema,
        oid: table.oid,
        columns: table.columns.map((c) => ({ name: c.name, type: c.type.id })),
      },
      name: trigger.name,
      when: trigger.timing === "before" ? "BEFORE" : trigger.timing === "after" ? "AFTER" : "INSTEAD OF",
      level: trigger.forEachRow ? "ROW" : "STATEMENT",
      op: event === "insert" ? "INSERT" : event === "update" ? "UPDATE" : "DELETE",
      args: trigger.funcArgs,
      oldRow,
      newRow,
      // a statement trigger reads its transition tables; a row trigger sees none of the statement's CTEs
      ctes: trigger.forEachRow ? new Map() : env.ctes,
    });
  } finally {
    state.localSettings = saved;
  }
}

setTriggerExecutor(executeTrigger);
