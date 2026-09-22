import { pgError } from "../errors/error.ts";
import type { EngineCtx } from "../expressions/context.ts";
import type { Datum, TypedValue, TypeId } from "../types/value.ts";
import { tv } from "../types/value.ts";

/** A column of an intermediate or final result relation. */
export interface RelColumn {
  name: string;
  type: TypeId;
  /** range-variable (table alias) the column belongs to; null for computed columns */
  table: string | null;
  /** hidden columns (e.g. ORDER BY helpers) are excluded from final output */
  hidden?: boolean;
}

export interface Relation {
  columns: RelColumn[];
  rows: Datum[][];
}

export function emptyRelation(): Relation {
  return { columns: [], rows: [] };
}

/**
 * Row-level name resolution scope. Chains to an outer scope for correlated
 * subqueries and LATERAL.
 */
export class RowScope {
  constructor(
    readonly columns: RelColumn[],
    public row: Datum[],
    readonly parent: RowScope | null = null,
    /** range variables visible as whole-row references */
    readonly rangeVars: Set<string> = new Set(),
  ) {}

  /** Resolve a (possibly qualified) column reference. undefined = not found. */
  lookup(parts: string[]): TypedValue | undefined {
    if (parts.length === 1) {
      const name = parts[0]!;
      let found: TypedValue | undefined;
      let count = 0;
      for (let i = 0; i < this.columns.length; i++) {
        const c = this.columns[i]!;
        if (c.name === name && !c.hidden) {
          count++;
          if (count > 1) {
            throw pgError("ambiguous_column", `column reference "${name}" is ambiguous`);
          }
          found = tv(c.type, this.row[i] ?? null);
        }
      }
      if (found !== undefined) return found;
      // whole-row reference to a range variable
      if (this.rangeVars.has(name)) {
        return this.wholeRow(name);
      }
      return this.parent?.lookup(parts);
    }
    const table = parts[parts.length - 2]!;
    const name = parts[parts.length - 1]!;
    let found: TypedValue | undefined;
    let count = 0;
    // qualified lookups see hidden columns (per-side copies of USING columns)
    for (let i = 0; i < this.columns.length; i++) {
      const c = this.columns[i]!;
      if (c.table === table && c.name === name) {
        count++;
        if (count > 1) {
          throw pgError("ambiguous_column", `column reference "${name}" is ambiguous`);
        }
        found = tv(c.type, this.row[i] ?? null);
      }
    }
    if (found !== undefined) return found;
    return this.parent?.lookup(parts);
  }

  /** Build a record value from all columns belonging to a range variable. */
  wholeRow(rangeVar: string): TypedValue | undefined {
    const types: TypeId[] = [];
    const values: Datum[] = [];
    const names: string[] = [];
    // include hidden columns: per-side USING copies are real columns of the range var
    for (let i = 0; i < this.columns.length; i++) {
      const c = this.columns[i]!;
      if (c.table === rangeVar) {
        types.push(c.type);
        values.push(this.row[i] ?? null);
        names.push(c.name);
      }
    }
    if (types.length === 0) return undefined;
    return tv("record", { kind: "pgrecord", types, values, names });
  }

  hasRangeVar(name: string): boolean {
    if (this.rangeVars.has(name)) return true;
    return this.parent?.hasRangeVar(name) ?? false;
  }
}

/** Environment threaded through statement execution. */
export interface ExecEnv {
  ctx: EngineCtx;
  params: TypedValue[] | null;
  /** CTE results by name (WITH clause); shadowed inner-to-outer */
  ctes: Map<string, Relation>;
  outer: RowScope | null;
}

export function childEnv(env: ExecEnv, outer: RowScope | null): ExecEnv {
  return { ctx: env.ctx, params: env.params, ctes: env.ctes, outer };
}

export function withCtes(env: ExecEnv, ctes: Map<string, Relation>): ExecEnv {
  return { ctx: env.ctx, params: env.params, ctes, outer: env.outer };
}

/** Final result surfaced by the API layer. */
export interface ExecResult {
  columns: Array<{ name: string; type: TypeId }>;
  rows: Datum[][];
  command: string;
  rowCount: number;
}

export function relationResult(rel: Relation, command: string): ExecResult {
  const visible = rel.columns.map((c, i) => ({ i, c })).filter(({ c }) => !c.hidden);
  return {
    columns: visible.map(({ c }) => ({ name: c.name, type: c.type })),
    rows: rel.rows.map((r) => visible.map(({ i }) => r[i] ?? null)),
    command,
    rowCount: rel.rows.length,
  };
}

export function commandResult(command: string, rowCount: number): ExecResult {
  return { columns: [], rows: [], command, rowCount };
}

/** column name PG infers for an expression without an alias */
export function inferColumnName(e: import("../ast/nodes.ts").Expr): string {
  switch (e.type) {
    case "colref":
      return e.parts[e.parts.length - 1]!;
    case "func":
      return e.name[e.name.length - 1]!;
    case "cast": {
      const inner = inferColumnName(e.expr);
      if (inner !== "?column?") return inner;
      return e.target.parts[e.target.parts.length - 1]!;
    }
    case "collate":
      return inferColumnName(e.expr);
    case "case":
      return "case";
    case "array_ctor":
    case "array_query":
      return "array";
    case "row":
      return "row";
    case "subquery_expr":
      return e.kind === "exists" ? "exists" : "?column?";
    case "bool_lit":
      return "bool";
    case "extract":
      return "extract";
    case "position":
      return "position";
    case "substring_sql":
      return "substring";
    case "overlay":
      return "overlay";
    case "trim":
      return e.side === "leading" ? "ltrim" : e.side === "trailing" ? "rtrim" : "btrim";
    case "field_select":
      return e.field === "*" ? "?column?" : e.field;
    case "at_time_zone":
      return "timezone";
    case "grouping_func":
      return "grouping";
    case "subscript":
      return inferColumnName(e.base);
    default:
      return "?column?";
  }
}

export type { EngineCtx };
