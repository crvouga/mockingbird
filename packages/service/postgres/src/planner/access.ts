import type { Expr, FromItem } from "../ast/nodes.ts";
import { type ExecEnv, RowScope } from "../executor/relation.ts";
import { evalExpr } from "../expressions/eval.ts";
import { makeEvalScope } from "../executor/select.ts";
import { indexStoreFor } from "../indexes/maintain.ts";
import type { TableData } from "../storage/database-state.ts";
import { castTo } from "../types/cast.ts";
import { datumCompare, datumKey } from "../types/compare.ts";
import { type Datum, tv, type TypeId } from "../types/value.ts";
import { type UniqueSpec, uniqueKeyOf, uniqueSpecsFor } from "../constraints/enforce.ts";

function isRowIndependentExpr(expr: Expr): boolean {
  return expr.type !== "colref";
}

export interface ConstEquality {
  column: string;
  valueExpr: Expr;
}

export function equalityAgainstConst(expr: Expr): ConstEquality | null {
  if (expr.type !== "binop" || expr.op !== "=") return null;
  if (expr.left.type === "colref" && isRowIndependentExpr(expr.right)) {
    const parts = expr.left.parts;
    const column = parts[parts.length - 1]!;
    return { column, valueExpr: expr.right };
  }
  if (expr.right.type === "colref" && isRowIndependentExpr(expr.left)) {
    const parts = expr.right.parts;
    const column = parts[parts.length - 1]!;
    return { column, valueExpr: expr.left };
  }
  return null;
}

export function conjunctions(expr: Expr): Expr[] {
  if (expr.type === "binop" && expr.op === "and") {
    return [...conjunctions(expr.left), ...conjunctions(expr.right)];
  }
  return [expr];
}

/** Single-table PK / unique equality lookup: returns matching rows or null to scan. */
export function tryIndexedTableRows(env: ExecEnv, table: TableData, alias: string, where: Expr): Datum[][] | null {
  const parts = conjunctions(where);
  const eqs: ConstEquality[] = [];
  for (const part of parts) {
    const eq = equalityAgainstConst(part);
    if (!eq) return null;
    eqs.push(eq);
  }
  if (eqs.length === 0) return null;

  let spec: UniqueSpec | null = null;
  for (const candidate of uniqueSpecsFor(env, table)) {
    if (candidate.keys.length !== eqs.length) continue;
    const names = candidate.columnNames;
    if (eqs.every((eq, i) => names[i] === eq.column)) {
      spec = candidate;
      break;
    }
  }
  if (!spec) return null;

  const probeRow: Datum[] = table.columns.map(() => null);
  const scope = new RowScope(
    table.columns.map((c) => ({ name: c.name, type: c.type.id, table: alias })),
    probeRow,
    env.outer,
    new Set([alias]),
  );
  for (let i = 0; i < eqs.length; i++) {
    const k = spec.keys[i]!;
    if (k.expr) return null;
    const colIdx = k.colIdx;
    const v = evalExpr(env.ctx, makeEvalScope(env, scope), eqs[i]!.valueExpr);
    probeRow[colIdx] = castTo(env.ctx, v, table.columns[colIdx]!.type.id, {}).v;
  }

  const key = uniqueKeyOf(env, table, spec, probeRow);
  if (key === null) return [];
  const hits = indexStoreFor(env, table, spec).lookup(key);
  return hits.map((i) => table.rowAt(i));
}

export function tryIndexedFromItem(env: ExecEnv, item: FromItem, where: Expr | null): Datum[][] | null {
  if (!where || item.type !== "from_table") return null;
  const state = env.ctx.state;
  const table = state.findTable(item.name);
  if (!table) return null;
  const alias = item.alias ?? item.name[item.name.length - 1]!;
  table.materializeSlab();
  return tryIndexedTableRows(env, table, alias, where);
}

export function joinKeyFromRow(
  row: Datum[],
  colIdxs: number[],
  srcTypes: TypeId[],
  unifiedTypes: TypeId[],
  ctx: import("../expressions/context.ts").EngineCtx,
): string | null {
  const parts: string[] = [];
  for (let i = 0; i < colIdxs.length; i++) {
    const v = row[colIdxs[i]!] ?? null;
    if (v === null) return null;
    const cast = castTo(ctx, tv(srcTypes[i]!, v), unifiedTypes[i]!, {}).v;
    if (cast === null) return null;
    parts.push(datumKey(unifiedTypes[i]!, cast));
  }
  return parts.join("\u0001");
}

export function rowsMatchEqKeys(
  ctx: import("../expressions/context.ts").EngineCtx,
  left: Datum[],
  right: Datum[],
  leftIdxs: number[],
  rightIdxs: number[],
  leftTypes: TypeId[],
  rightTypes: TypeId[],
  unifiedTypes: TypeId[],
): boolean {
  for (let k = 0; k < leftIdxs.length; k++) {
    const lv = left[leftIdxs[k]!] ?? null;
    const rv = right[rightIdxs[k]!] ?? null;
    if (lv === null || rv === null) return false;
    const lc = castTo(ctx, tv(leftTypes[k]!, lv), unifiedTypes[k]!, {}).v;
    const rc = castTo(ctx, tv(rightTypes[k]!, rv), unifiedTypes[k]!, {}).v;
    if (lc === null || rc === null) return false;
    if (datumCompare(unifiedTypes[k]!, lc, rc, ctx) !== 0) return false;
  }
  return true;
}
