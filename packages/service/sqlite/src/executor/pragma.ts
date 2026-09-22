import type { Expr } from "../ast/nodes.ts";
import type { ExecutionEnv } from "./env.ts";
import {
  coercePragmaInt,
  coercePragmaTruthy,
  evalPragmaArgs,
  evalPragmaSetValue,
  queryPragma,
} from "./pragma-engine.ts";
import { emptyResult, type ResultSet, valuesToResult } from "./result.ts";

export function executePragma(name: string, expr: Expr | null, env: ExecutionEnv): ResultSet {
  const key = name.toLowerCase();

  // Writable statement forms
  if (key === "foreign_keys" && expr !== null) {
    const value = evalPragmaSetValue(expr, env);
    if (!env.transactions.inTransaction) env.state.foreignKeysEnabled = coercePragmaTruthy(value);
    return emptyResult(0, env.state.lastInsertRowid);
  }
  if (key === "case_sensitive_like" && expr !== null) {
    const value = evalPragmaSetValue(expr, env);
    env.state.caseSensitiveLike = coercePragmaTruthy(value);
    return emptyResult(0, env.state.lastInsertRowid);
  }
  if ((key === "user_version" || key === "schema_version") && expr !== null) {
    const value = evalPragmaSetValue(expr, env);
    const num = coercePragmaInt(value);
    if (key === "user_version") env.state.userVersion = num;
    else env.state.schemaVersion = num;
    return emptyResult(0, env.state.lastInsertRowid);
  }

  const args = evalPragmaArgs(expr, env);
  const result = queryPragma(key, args, env);
  if (result.columns.length === 0 && result.rows.length === 0) {
    return emptyResult(0, env.state.lastInsertRowid);
  }
  return valuesToResult(result.columns, result.rows, 0, env.state.lastInsertRowid);
}
