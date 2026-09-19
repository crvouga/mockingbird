import { pgError, unsupported } from "../errors/error.ts";
import type { TableData, TriggerMeta } from "../storage/database-state.ts";
import { castTo } from "../types/cast.ts";
import type { Datum } from "../types/value.ts";
import { compileTriggerBody, type PlStmt } from "./plpgsql.ts";
import { type ExecEnv, RowScope } from "./relation.ts";
import { evalPredicate, evalScalar, runStatement } from "./select.ts";
import { parse } from "../parser/index.ts";
import type { Statement } from "../ast/nodes.ts";
import { setTriggerExecutor, type TriggerEvent } from "./triggers.ts";

/**
 * Trigger executor: runs plpgsql-lite bodies against NEW/OLD rows.
 * Parsing is shared with UDF plpgsql in plpgsql.ts.
 */

class ReturnSignal {
  constructor(readonly row: Datum[] | null) {}
}

function runTriggerBody(
  env: ExecEnv,
  table: TableData,
  stmts: PlStmt[],
  vars: { newRow: Datum[] | null; oldRow: Datum[] | null },
): void {
  const scope = (): RowScope => triggerScope(table, vars.newRow, vars.oldRow);

  for (const stmt of stmts) {
    switch (stmt.kind) {
      case "assign": {
        if (stmt.target.length !== 2 || stmt.target[0] !== "new") {
          throw unsupported(`trigger body: assignment to "${stmt.target.join(".")}"`);
        }
        if (vars.newRow === null) {
          throw pgError("object_not_in_prerequisite_state", `record "new" is not assigned yet`, "55000");
        }
        const colName = stmt.target[1]!;
        const idx = table.columns.findIndex((c) => c.name === colName);
        if (idx === -1) {
          throw pgError("undefined_column", `record "new" has no field "${colName}"`, "42703");
        }
        const v = evalScalar(env, scope(), stmt.expr);
        vars.newRow = vars.newRow.slice();
        vars.newRow[idx] =
          v.v === null ? null : castTo(env.ctx, v, table.columns[idx]!.type.id, { assignment: true }).v;
        break;
      }
      case "return_new":
        throw new ReturnSignal(vars.newRow);
      case "return_old":
        throw new ReturnSignal(vars.oldRow);
      case "return_empty":
        throw new ReturnSignal(null);
      case "return_expr": {
        const v = evalScalar(env, scope(), stmt.expr);
        if (v.v === null) throw new ReturnSignal(null);
        throw unsupported("trigger body: RETURN expression");
      }
      case "if": {
        let taken = false;
        for (const b of stmt.branches) {
          if (evalPredicate(env, scope(), b.cond)) {
            runTriggerBody(env, table, b.body, vars);
            taken = true;
            break;
          }
        }
        if (!taken) runTriggerBody(env, table, stmt.elseBody, vars);
        break;
      }
      case "null":
        break;
      case "raise":
        throw pgError("raise_exception", stmt.message, "P0001");
      case "block": {
        try {
          runTriggerBody(env, table, stmt.body, vars);
        } catch (e) {
          if (e instanceof ReturnSignal) throw e;
          if (stmt.handler === null) throw e;
          runTriggerBody(env, table, stmt.handler, vars);
        }
        break;
      }
      case "sql": {
        const stmts = parse(stmt.text);
        if (stmts.length !== 1) throw unsupported(`trigger body SQL: ${stmt.text}`);
        runStatement(env, stmts[0]! as Statement);
        break;
      }
      default:
        throw unsupported(`trigger body: ${stmt.kind}`);
    }
  }
}

function triggerScope(table: TableData, newRow: Datum[] | null, oldRow: Datum[] | null): RowScope {
  const cols: Array<{ name: string; type: import("../types/value.ts").TypeId; table: string | null }> = [];
  const row: Datum[] = [];
  const rangeVars = new Set<string>();
  if (newRow) {
    rangeVars.add("new");
    for (let i = 0; i < table.columns.length; i++) {
      cols.push({ name: table.columns[i]!.name, type: table.columns[i]!.type.id, table: "new" });
      row.push(newRow[i] ?? null);
    }
  }
  if (oldRow) {
    rangeVars.add("old");
    for (let i = 0; i < table.columns.length; i++) {
      cols.push({ name: table.columns[i]!.name, type: table.columns[i]!.type.id, table: "old" });
      row.push(oldRow[i] ?? null);
    }
  }
  return new RowScope(cols, row, null, rangeVars);
}

function executeTrigger(
  env: ExecEnv,
  table: TableData,
  trigger: TriggerMeta,
  _event: TriggerEvent,
  oldRow: Datum[] | null,
  newRow: Datum[] | null,
): Datum[] | null {
  const state = env.ctx.state;
  if (trigger.when !== null && !evalPredicate(env, triggerScope(table, newRow, oldRow), trigger.when)) {
    return newRow; // WHEN false: trigger does not fire; row passes through unchanged
  }
  const fns = state.schemas.get(trigger.funcSchema)?.functions.get(trigger.funcName);
  const fn = fns?.[0];
  if (!fn) {
    throw pgError("undefined_function", `function ${trigger.funcSchema}.${trigger.funcName}() does not exist`, "42883");
  }
  const raw = fn.rawBody;
  if (raw === null) throw unsupported(`trigger function ${fn.name} has no body`);
  const stmts = compileTriggerBody(raw);
  const vars = { newRow: newRow ? newRow.slice() : null, oldRow };
  try {
    runTriggerBody(env, table, stmts, vars);
  } catch (e) {
    if (e instanceof ReturnSignal) return e.row;
    throw e;
  }
  throw pgError("invalid_function_definition", `control reached end of trigger procedure without RETURN`, "2F005");
}

setTriggerExecutor(executeTrigger);
