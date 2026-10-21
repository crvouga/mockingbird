import { pgError } from "../errors/error.ts";
import type { EngineCtx } from "../expressions/context.ts";
import type { Datum, TypedValue, TypeId } from "../types/value.ts";
import { normalizeTypeName, tv, type TypeMod } from "../types/value.ts";

/** A column of an intermediate or final result relation. */
export interface RelColumn {
  name: string;
  type: TypeId;
  /** type modifier (`varchar(32)`, `numeric(10,2)`) of a column read straight from a table or cast to a typed name */
  mod?: TypeMod | null;
  /** range-variable (table alias) the column belongs to; null for computed columns */
  table: string | null;
  /** hidden columns (e.g. ORDER BY helpers) are excluded from final output */
  hidden?: boolean;
  system?: boolean;
  /** the only column of a function in FROM that returns a base type: a whole-row reference to the range variable is this value */
  scalarFunction?: boolean;
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
        if (c.name === name && (!c.hidden || c.system)) {
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
      if (c.table === rangeVar && !c.system) {
        types.push(c.type);
        values.push(this.row[i] ?? null);
        names.push(c.name);
      }
    }
    if (types.length === 0) return undefined;
    const only = this.columns.find((c) => c.table === rangeVar && !c.system);
    if (types.length === 1 && only?.scalarFunction) return tv(types[0]!, values[0] ?? null);
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
  /**
   * CREATE/REFRESH MATERIALIZED VIEW … WITH NO DATA. An unpopulated matview
   * contributes its column shape and no rows, matching PostgreSQL planning.
   */
  allowUnpopulatedMatviews?: boolean;
}

export function childEnv(env: ExecEnv, outer: RowScope | null): ExecEnv {
  return {
    ctx: env.ctx,
    params: env.params,
    ctes: env.ctes,
    outer,
    allowUnpopulatedMatviews: env.allowUnpopulatedMatviews,
  };
}

export function withCtes(env: ExecEnv, ctes: Map<string, Relation>): ExecEnv {
  return {
    ctx: env.ctx,
    params: env.params,
    ctes,
    outer: env.outer,
    allowUnpopulatedMatviews: env.allowUnpopulatedMatviews,
  };
}

/** Final result surfaced by the API layer. */
export interface ExecResult {
  columns: Array<{ name: string; type: TypeId; mod?: TypeMod | null }>;
  rows: Datum[][];
  command: string;
  rowCount: number;
}

export function relationResult(rel: Relation, command: string): ExecResult {
  const visible = rel.columns.map((c, i) => ({ i, c })).filter(({ c }) => !c.hidden);
  return {
    columns: visible.map(({ c }) => ({ name: c.name, type: c.type, mod: c.mod ?? null })),
    rows: rel.rows.map((r) => visible.map(({ i }) => r[i] ?? null)),
    command,
    rowCount: rel.rows.length,
  };
}

export function commandResult(command: string, rowCount: number): ExecResult {
  return { columns: [], rows: [], command, rowCount };
}

/** What the parser calls a function that PostgreSQL's grammar calls something else (or nothing). */
const INTERNAL_FUNCTION_LABELS: Record<string, string> = {
  __any_array: "?column?",
  __all_array: "?column?",
  __overlaps: "overlaps",
};

/**
 * PostgreSQL's FigureColname: the label of an expression and how strongly it names it. A column
 * reference or function call (2) beats the type name of a cast around it (1), which beats nothing (0).
 */
function figureColumnName(e: import("../ast/nodes.ts").Expr): { name: string; strength: number } {
  const named = (name: string, strength = 2) => ({ name, strength });
  switch (e.type) {
    case "colref":
      return named(e.parts[e.parts.length - 1]!);
    case "func": {
      const name = e.name[e.name.length - 1]!;
      return name in INTERNAL_FUNCTION_LABELS ? named(INTERNAL_FUNCTION_LABELS[name]!, 0) : named(name);
    }
    case "cast": {
      const inner = figureColumnName(e.expr);
      if (inner.strength > 1) return inner;
      const last = e.target.parts[e.target.parts.length - 1]!;
      // the grammar spells `int`, `boolean`, `double precision`... as their pg_catalog names (int4, bool, float8)
      return named(e.target.parts.length === 1 ? (normalizeTypeName(last) ?? last) : last, 1);
    }
    case "collate":
      return figureColumnName(e.expr);
    case "case":
      return named("case", 1);
    case "array_ctor":
    case "array_query":
      return named("array");
    case "row":
      return named("row");
    case "subquery_expr":
      return e.kind === "exists" ? named("exists") : named("?column?", 0);
    case "bool_lit":
      return named("bool", 1);
    case "extract":
      return named("extract");
    case "position":
      return named("position");
    case "substring_sql":
      return named("substring");
    case "overlay":
      return named("overlay");
    case "trim":
      return named(e.side === "leading" ? "ltrim" : e.side === "trailing" ? "rtrim" : "btrim");
    case "field_select":
      return e.field === "*" ? named("?column?", 0) : named(e.field);
    case "at_time_zone":
      return named("timezone");
    case "grouping_func":
      return named("grouping");
    case "subscript":
      return figureColumnName(e.base);
    default:
      return named("?column?", 0);
  }
}

/** column name PG infers for an expression without an alias */
export function inferColumnName(e: import("../ast/nodes.ts").Expr): string {
  return figureColumnName(e).name;
}

export type { EngineCtx };
