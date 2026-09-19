import type { Expr } from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import type { ExecutionEnv, ScopeRow } from "../executor/env.ts";
import { pragmaTvfColumns } from "../executor/pragma-engine.ts";
import { evalExpr } from "../expressions/eval.ts";
import { jsonEachRows, jsonTreeRows } from "../json/tvf.ts";
import { toInteger } from "../types/value.ts";
import { ensurePragmaTvfsRegistered } from "./pragma-tvf.ts";
import {
  getTableValuedFunction,
  hasRegisteredTableValuedFunction,
  listRegisteredTableValuedFunctions,
  registerTableValuedFunction,
  type TableValuedResult,
} from "./table-valued-registry.ts";

export type { TableValuedResult };
export { registerTableValuedFunction };

const JSON_TVF_COLUMNS = ["key", "value", "type", "atom", "id", "parent", "fullkey", "path"] as const;

function jsonTvfResult(
  alias: string | null,
  defaultName: string,
  rows: ReturnType<typeof jsonEachRows>,
): TableValuedResult {
  const table = alias ?? defaultName;
  return {
    columns: [...JSON_TVF_COLUMNS],
    rows: rows.map((row) => ({
      cells: JSON_TVF_COLUMNS.map((name) => ({
        table,
        name,
        value: row[name],
      })),
    })),
  };
}

registerTableValuedFunction("generate_series", (args, alias) => {
  if (args.length < 2 || args.length > 3) {
    throw new SqliteError("wrong number of arguments to function generate_series()", "misuse");
  }
  const start = toInteger(args[0] ?? null);
  const stop = toInteger(args[1] ?? null);
  const step = args.length === 3 ? toInteger(args[2] ?? null) : 1n;
  if (start === null || stop === null || step === null) {
    throw new SqliteError("datatype mismatch", "datatype_mismatch");
  }
  if (step === 0n || step === 0) throw new SqliteError("step must not be zero", "misuse");
  const startN = typeof start === "bigint" ? start : BigInt(start);
  const stopN = typeof stop === "bigint" ? stop : BigInt(stop);
  const stepN = typeof step === "bigint" ? step : BigInt(step);
  const table = alias ?? "generate_series";
  const rows: ScopeRow[] = [];
  if (stepN > 0n) {
    for (let value = startN; value <= stopN; value += stepN) {
      rows.push({
        cells: [{ table, name: "value", value: safeInt(value) }],
      });
    }
  } else {
    for (let value = startN; value >= stopN; value += stepN) {
      rows.push({
        cells: [{ table, name: "value", value: safeInt(value) }],
      });
    }
  }
  return { columns: ["value"], rows };
});

registerTableValuedFunction("json_each", (args, alias) => {
  if (args.length < 1 || args.length > 2) {
    throw new SqliteError("wrong number of arguments to function json_each()", "misuse");
  }
  return jsonTvfResult(alias, "json_each", jsonEachRows(args[0]!, args[1]));
});

registerTableValuedFunction("json_tree", (args, alias) => {
  if (args.length < 1 || args.length > 2) {
    throw new SqliteError("wrong number of arguments to function json_tree()", "misuse");
  }
  return jsonTvfResult(alias, "json_tree", jsonTreeRows(args[0]!, args[1]));
});

function safeInt(value: bigint): number | bigint {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value;
}

/**
 * Known output columns for a TVF without evaluating arguments.
 * Prefer this for FROM-item shape analysis when args may be correlated.
 */
export function tableValuedColumns(name: string): string[] | null {
  ensurePragmaTvfsRegistered();
  const lower = name.toLowerCase();
  if (lower === "generate_series") return ["value"];
  if (lower === "json_each" || lower === "json_tree") return [...JSON_TVF_COLUMNS];
  return pragmaTvfColumns(name);
}

export function evaluateTableFunction(
  name: string,
  args: Expr[],
  alias: string | null,
  env: ExecutionEnv,
  scope?: ScopeRow | null,
  parent?: import("../expressions/context.ts").EvalContext,
): TableValuedResult {
  ensurePragmaTvfsRegistered();
  const fn = getTableValuedFunction(name);
  if (!fn) throw new SqliteError(`no such table-valued function: ${name}`, "no_such_table");
  const values = args.map((arg) => evalExpr(arg, env.createEvalContext(scope ?? null, parent)));
  return fn(values, alias, env);
}

export function listTableValuedFunctions(): string[] {
  ensurePragmaTvfsRegistered();
  return listRegisteredTableValuedFunctions();
}

export function hasTableValuedFunction(name: string): boolean {
  ensurePragmaTvfsRegistered();
  return hasRegisteredTableValuedFunction(name);
}
