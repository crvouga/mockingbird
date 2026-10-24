import type { Expr, FromItem } from "../ast/nodes.ts";
import { type UniqueSpec, uniqueKeyOf, uniqueSpecsFor } from "../constraints/enforce.ts";
import { type ExecEnv, RowScope } from "../executor/relation.ts";
import { makeEvalScope } from "../executor/select.ts";
import { evalExpr } from "../expressions/eval.ts";
import { indexStoreFor } from "../indexes/maintain.ts";
import type { TableData } from "../storage/database-state.ts";
import { castTo } from "../types/cast.ts";
import { datumCompare, datumKey } from "../types/compare.ts";
import { type Datum, type TypeId, tv } from "../types/value.ts";

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

/**
 * Conservative point access for DML and allocation-free SELECT sources. No casts, volatile
 * expressions or partial/expression indexes: unsupported shapes retain the existing executor.
 * Index statistics are left to the caller (DML historically does not increment SELECT scans).
 */
export function tryPointRowIndices(
  env: ExecEnv,
  table: TableData,
  alias: string,
  where: Expr,
): { indices: readonly number[]; indexName: string } | null {
  const eqs: ConstEquality[] = [];
  for (const part of conjunctions(where)) {
    const eq = equalityAgainstConst(part);
    if (!eq || !["param", "number_lit", "string_lit", "bool_lit", "null_lit"].includes(eq.valueExpr.type)) return null;
    if (part.type !== "binop") return null;
    const column = part.left.type === "colref" ? part.left : part.right;
    if (column.type !== "colref") return null;
    if (column.parts.length > 1 && column.parts[column.parts.length - 2] !== alias) return null;
    eqs.push(eq);
  }
  for (const spec of uniqueSpecsFor(env, table)) {
    if (
      spec.where ||
      spec.keys.length !== eqs.length ||
      spec.keys.some((key) => key.expr) ||
      !eqs.every((eq, index) => eq.column === spec.columnNames[index])
    )
      continue;
    const values: Datum[] = table.columns.map(() => null);
    let matches = true;
    for (let index = 0; index < spec.keys.length; index++) {
      const key = spec.keys[index]!;
      const column = table.columns[key.colIdx];
      const eq = eqs[index];
      if (!column || !eq || column.domain) {
        matches = false;
        break;
      }
      // These expression forms cannot inspect a row or invoke user code.
      const value = evalExpr(env.ctx, makeEvalScope(env, null), eq.valueExpr);
      if (
        value.t !== column.type.id &&
        !(column.type.id === "text" && value.t === "unknown" && typeof value.v === "string")
      ) {
        matches = false;
        break;
      }
      values[key.colIdx] = value.v;
    }
    if (!matches) continue;
    const key = uniqueKeyOf(env, table, spec, values);
    return { indices: key === null ? [] : indexStoreFor(env, table, spec).lookup(key), indexName: spec.name };
  }
  return null;
}

export function recordIndexScan(env: ExecEnv, table: TableData, name: string): void {
  const schema = env.ctx.state.schemas.get(table.schema);
  const index = schema?.indexes.get(name);
  if (schema && index) {
    const lastScan = env.ctx.state.clock().getTime();
    schema.indexes.set(name, { ...index, scans: (index.scans ?? 0n) + 1n, lastScan });
  }
}

/** Bounded integer ranges; all other expressions retain their existing execution order. */
export function tryRangeRowIndices(
  env: ExecEnv,
  table: TableData,
  alias: string,
  where: Expr,
): { indices: readonly number[]; indexName: string } | null {
  const parts = conjunctions(where);
  if (parts.length !== 2) return null;
  const bounds: { column: string; op: string; value: Expr }[] = [];
  for (const part of parts) {
    if (part.type !== "binop" || ![">", ">=", "<", "<="].includes(part.op)) return null;
    const column = part.left.type === "colref" ? part.left : part.right;
    const value = part.left.type === "colref" ? part.right : part.left;
    if (
      column.type !== "colref" ||
      column.parts.length > 2 ||
      (column.parts.length === 2 && column.parts[0] !== alias) ||
      !["param", "number_lit"].includes(value.type)
    )
      return null;
    const op = part.left === column ? part.op : { ">": "<", ">=": "<=", "<": ">", "<=": ">=" }[part.op]!;
    bounds.push({ column: column.parts.at(-1)!, op, value });
  }
  const lower = bounds.find((bound) => bound.op === ">" || bound.op === ">=");
  const upper = bounds.find((bound) => bound.op === "<" || bound.op === "<=");
  if (!lower || !upper || lower.column !== upper.column) return null;
  const column = table.columns.find((column) => column.name === lower.column);
  if (!column || column.domain || !["int2", "int4"].includes(column.type.id)) return null;
  for (const spec of uniqueSpecsFor(env, table)) {
    if (spec.where || spec.keys.length !== 1 || spec.keys[0]!.expr || spec.columnNames[0] !== lower.column) continue;
    const low = evalExpr(env.ctx, makeEvalScope(env, null), lower.value);
    const high = evalExpr(env.ctx, makeEvalScope(env, null), upper.value);
    if (
      low.t !== column.type.id ||
      high.t !== column.type.id ||
      typeof low.v !== "number" ||
      typeof high.v !== "number"
    )
      return null;
    return {
      indices: indexStoreFor(env, table, spec).integerRange(low.v, high.v, lower.op === ">=", upper.op === "<="),
      indexName: spec.name,
    };
  }
  return null;
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
  recordIndexScan(env, table, spec.name);
  return hits.map((i) => table.rowAt(i));
}

export function tryIndexedFromItem(env: ExecEnv, item: FromItem, where: Expr | null): Datum[][] | null {
  if (!where || item.type !== "from_table") return null;
  const state = env.ctx.state;
  const table = state.findTable(item.name);
  if (!table) return null;
  const alias = item.alias ?? item.name[item.name.length - 1]!;
  table.materializeSlab();
  return tryIndexedTableRows(env, table, alias, where)?.map((row) => [...row, table.rowXmins.get(row) ?? 2]) ?? null;
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
