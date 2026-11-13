import type { Expr, ReturningAliases, SelectTarget } from "../ast/nodes.ts";
import { pgError } from "../errors/error.ts";
import type { TableData } from "../storage/database-state.ts";
import { type Datum, type TypedValue, type TypeId, tv, UNKNOWN } from "../types/value.ts";
import { type ExecEnv, type ExecResult, inferColumnName, type RelColumn, RowScope } from "./relation.ts";
import { evalScalar } from "./select.ts";
import { systemColumns, withSystemValues } from "./system-columns.ts";

/**
 * RETURNING lists, with PostgreSQL 18's `old` / `new` row references
 * (https://www.postgresql.org/docs/18/dml-returning.html). Unqualified columns read the new row for
 * INSERT / UPDATE / MERGE and the old row for DELETE; `old.*` is all NULL for an inserted row and
 * `new.*` for a deleted one. `RETURNING WITH (OLD AS o, NEW AS n)` renames them.
 */

/** One row a statement wrote: its version before and after, where it sits, and the `xmax` RETURNING reports. */
export interface ReturningRow {
  readonly old: Datum[] | null;
  readonly new: Datum[] | null;
  readonly position: number;
  /** 0, or the writing transaction for an ON CONFLICT update and a DELETE */
  readonly xmax: number;
  /** MERGE: the source row (all NULL for WHEN NOT MATCHED BY SOURCE) and what `merge_action()` reports */
  readonly source?: Datum[];
  readonly action?: "INSERT" | "UPDATE" | "DELETE";
  /** the partition a row routed through a partitioned table landed in (its `tableoid`) */
  readonly table?: TableData;
}

/** The MERGE source relation RETURNING can also read. */
export interface ReturningSource {
  readonly columns: RelColumn[];
  readonly rangeVars: ReadonlySet<string>;
  /** a bare `*` lists these after the target's columns (UPDATE ... FROM, DELETE ... USING); MERGE puts them first */
  readonly afterTarget?: boolean;
}

const isMergeAction = (node: { type?: unknown; name?: unknown; args?: unknown }): boolean =>
  node.type === "func" &&
  Array.isArray(node.name) &&
  node.name[node.name.length - 1] === "merge_action" &&
  (node.name.length === 1 || node.name[0] === "pg_catalog") &&
  Array.isArray(node.args) &&
  node.args.length === 0;

/** `merge_action()` read as the literal of the row's action. */
function bindMergeAction<T>(node: T, action: string): T {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((item) => bindMergeAction(item, action)) as T;
  if (isMergeAction(node as { type?: unknown })) {
    return {
      type: "cast",
      expr: { type: "string_lit", value: action },
      target: { parts: ["text"], mods: [], arrayDims: 0 },
    } as T;
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, bindMergeAction(v, action)])) as T;
}

/** A scope whose `old` / `new` whole-row reference is NULL when that version does not exist. */
class ReturningScope extends RowScope {
  constructor(
    columns: RelColumn[],
    row: Datum[],
    parent: RowScope | null,
    rangeVars: Set<string>,
    private readonly absent: ReadonlySet<string>,
  ) {
    super(columns, row, parent, rangeVars);
  }

  override wholeRow(rangeVar: string): TypedValue | undefined {
    if (this.absent.has(rangeVar)) return tv("record", null);
    return super.wholeRow(rangeVar);
  }
}

function sideNames(
  label: string,
  aliases: ReturningAliases | null | undefined,
): { old: string | null; new: string | null } {
  // a target table called (or aliased) old / new keeps that name unless WITH renames the row
  const oldName = aliases?.old ?? (label === "old" ? null : "old");
  const newName = aliases?.new ?? (label === "new" ? null : "new");
  if (oldName !== null && oldName === newName) {
    throw pgError("duplicate_object", `table name "${oldName}" specified more than once`, "42712");
  }
  return { old: oldName, new: newName };
}

export function evalReturning(
  env: ExecEnv,
  table: TableData,
  label: string,
  targets: SelectTarget[],
  aliases: ReturningAliases | null | undefined,
  rows: ReturningRow[],
  command: "INSERT" | "UPDATE" | "DELETE" | "MERGE",
  source?: ReturningSource,
): ExecResult {
  const names = sideNames(label, aliases);
  const width = table.columns.length;
  const tableCols = (rangeVar: string, hidden: boolean): RelColumn[] =>
    table.columns.map((c) => ({ name: c.name, type: c.type.id, mod: c.type.mod, table: rangeVar, hidden }));
  const columnsOf = [
    ...tableCols(label, false),
    ...systemColumns(label),
    ...(names.old !== null ? tableCols(names.old, true) : []),
    ...(names.new !== null ? tableCols(names.new, true) : []),
    ...(source?.columns ?? []),
  ];
  const rangeVars = new Set([
    label,
    ...(names.old ? [names.old] : []),
    ...(names.new ? [names.new] : []),
    ...(source?.rangeVars ?? []),
  ]);

  interface Item {
    name: string;
    expr: Expr | null;
    /** offset into the scope row for a star-expanded column */
    offset: number;
    type: TypeId;
  }
  const oldOffset = width + systemColumns(null).length;
  const newOffset = oldOffset + (names.old !== null ? width : 0);
  const sourceOffset = newOffset + (names.new !== null ? width : 0);
  const items: Item[] = [];
  const pushSource = (rangeVar: string | null): void => {
    source?.columns.forEach((c, i) => {
      if (!c.hidden && (rangeVar === null || c.table === rangeVar)) {
        items.push({ name: c.name, expr: null, offset: sourceOffset + i, type: c.type });
      }
    });
  };
  for (const t of targets) {
    if (t.expr.type === "star") {
      const qualifier = t.expr.table?.[t.expr.table.length - 1] ?? null;
      if (qualifier !== null && source?.rangeVars.has(qualifier)) {
        pushSource(qualifier);
        continue;
      }
      let base = 0;
      if (qualifier !== null && qualifier === names.old) base = oldOffset;
      else if (qualifier !== null && qualifier === names.new) base = newOffset;
      else if (qualifier !== null && qualifier !== label) {
        throw pgError("undefined_table", `missing FROM-clause entry for table "${qualifier}"`, "42P01");
      }
      // a bare * covers the source columns too, in the join's FROM order: ahead of the target's in MERGE
      if (qualifier === null && !source?.afterTarget) pushSource(null);
      for (let i = 0; i < width; i++) {
        items.push({ name: table.columns[i]!.name, expr: null, offset: base + i, type: table.columns[i]!.type.id });
      }
      if (qualifier === null && source?.afterTarget) pushSource(null);
      continue;
    }
    items.push({ name: t.alias ?? inferColumnName(t.expr), expr: t.expr, offset: -1, type: UNKNOWN });
  }

  const columns = items.map((it) => ({ name: it.name, type: it.type }));
  const nulls: Datum[] = table.columns.map(() => null);
  const outRows: Datum[][] = [];
  const bound = new Map<string, (Expr | null)[]>();
  const exprsFor = (action: string | undefined): (Expr | null)[] => {
    if (action === undefined) return items.map((it) => it.expr);
    let exprs = bound.get(action);
    if (!exprs) {
      exprs = items.map((it) => (it.expr === null ? null : bindMergeAction(it.expr, action)));
      bound.set(action, exprs);
    }
    return exprs;
  };
  for (const entry of rows) {
    const current = command === "DELETE" ? entry.old : (entry.new ?? entry.old);
    const scopeRow = [
      ...withSystemValues(entry.table ?? table, current ?? nulls, entry.position, entry.xmax),
      ...(names.old !== null ? (entry.old ?? nulls) : []),
      ...(names.new !== null ? (entry.new ?? nulls) : []),
      ...(source ? (entry.source ?? source.columns.map(() => null)) : []),
    ];
    const exprs = exprsFor(entry.action);
    const absent = new Set<string>();
    if (entry.old === null && names.old !== null) absent.add(names.old);
    if (entry.new === null && names.new !== null) absent.add(names.new);
    const scope = new ReturningScope(columnsOf, scopeRow, env.outer, rangeVars, absent);
    const out: Datum[] = [];
    for (let k = 0; k < items.length; k++) {
      const it = items[k]!;
      if (it.expr === null) {
        out.push(scopeRow[it.offset] ?? null);
        continue;
      }
      const v = evalScalar(env, scope, exprs[k]!);
      if (columns[k]!.type === UNKNOWN) columns[k]!.type = v.t;
      out.push(v.v);
    }
    outRows.push(out);
  }
  for (const c of columns) {
    if (c.type === UNKNOWN) c.type = "text";
  }
  return { columns, rows: outRows, command, rowCount: rows.length };
}
