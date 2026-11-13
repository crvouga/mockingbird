import type { CommonTableExpr, Expr, FromItem, SelectCore, SelectStmt, SetOp } from "../ast/nodes.ts";
import { pgError } from "../errors/error.ts";
import { datumEquals, datumKey } from "../types/compare.ts";
import { castTo, unifyTypes } from "../types/cast.ts";
import { type Datum, makeArray, type PgArray, type PgRecord, type TypeId, tv, UNKNOWN } from "../types/value.ts";
import type { ExecEnv, Relation } from "./relation.ts";

const MAX_RECURSION_ITERATIONS = 200_000;
const MAX_RECURSION_ROWS = 5_000_000;

const syntax = (message: string, code = "42601") => pgError("syntax", message, code);
const notSupported = (message: string) => pgError("feature_not_supported", message, "0A000");

interface Helpers {
  executeBody: (env: ExecEnv, body: SetOp["left"]) => Relation;
  evalConst: (env: ExecEnv, e: Expr) => { t: TypeId; v: Datum };
}

/** The CTE's own name in the recursive term's FROM list (joins included), or null when it is not there. */
function selfReference(items: readonly FromItem[], name: string): string | null {
  for (const item of items) {
    if (item.type === "from_table" && item.name.length === 1 && item.name[0] === name) return item.alias ?? name;
    if (item.type === "from_join") {
      const found = selfReference([item.left, item.right], name);
      if (found !== null) return found;
    }
  }
  return null;
}

function columnPositions(what: "search" | "cycle", names: readonly string[], columns: readonly string[]): number[] {
  const seen = new Set<string>();
  return names.map((name) => {
    const at = columns.indexOf(name);
    if (at === -1) throw syntax(`${what} column "${name}" not in WITH query column list`);
    if (seen.has(name)) throw syntax(`${what} column "${name}" specified more than once`, "42701");
    seen.add(name);
    return at;
  });
}

/**
 * A recursive CTE with `SEARCH` and/or `CYCLE` (rewriteSearchCycle): the non-recursive term starts the
 * sequence column (`ARRAY[ROW(cols)]` depth first, `ROW(0, cols)` breadth first), the mark column (its
 * DEFAULT) and the path (`ARRAY[ROW(cols)]`); each recursive row extends them from the row it came
 * from. A row marked as a cycle is emitted but not recursed from.
 */
export function executeSearchCycleCte(
  env: ExecEnv,
  cte: CommonTableExpr,
  query: SelectStmt,
  helpers: Helpers,
): Relation {
  const { search, cycle } = cte;
  const body = query.body as SetOp;
  const right = body.right;
  if (right.type !== "select_core") {
    throw notSupported("with a SEARCH or CYCLE clause, the right side of the UNION must be a SELECT");
  }
  const label = selfReference(right.from, cte.name);
  if (label === null) {
    throw notSupported(
      `with a SEARCH or CYCLE clause, the recursive reference to WITH query "${cte.name}" must be at the top level of its right-hand SELECT`,
    );
  }
  if (query.orderBy.length > 0) throw notSupported("ORDER BY in a recursive query is not implemented");
  if (query.limit || query.offset) throw notSupported("LIMIT in a recursive query is not implemented");

  const base = helpers.executeBody(env, body.left);
  const names = base.columns.map((c, i) => cte.columns?.[i] ?? c.name);
  if (cte.columns && cte.columns.length > base.columns.length) {
    throw syntax(
      `WITH query "${cte.name}" has ${base.columns.length} columns available but ${cte.columns.length} columns specified`,
      "42P10",
    );
  }
  const types = base.columns.map((c) => (c.type === UNKNOWN ? ("text" as TypeId) : c.type));
  const searchAt = search ? columnPositions("search", search.columns, names) : [];
  const cycleAt = cycle ? columnPositions("cycle", cycle.columns, names) : [];
  if (cycle && cycle.mark === cycle.path) {
    throw syntax("cycle mark column name and cycle path column name are the same");
  }
  if (search && cycle && search.set === cycle.mark) {
    throw syntax("search sequence column name and cycle mark column name are the same");
  }
  if (search && cycle && search.set === cycle.path) {
    throw syntax("search sequence column name and cycle path column name are the same");
  }

  // the cycle mark's values: TO / DEFAULT, or boolean true / false
  let markType: TypeId = "bool";
  let markValue: Datum = true;
  let markDefault: Datum = false;
  if (cycle?.value && cycle.default) {
    const value = helpers.evalConst(env, cycle.value);
    const fallback = helpers.evalConst(env, cycle.default);
    const unified = unifyTypes(value.t, fallback.t);
    if (unified === null) {
      throw pgError("datatype_mismatch", `CYCLE types ${value.t} and ${fallback.t} cannot be matched`, "42804");
    }
    markType = unified;
    markValue = castTo(env.ctx, tv(value.t, value.v), unified, {}).v;
    markDefault = castTo(env.ctx, tv(fallback.t, fallback.v), unified, {}).v;
  }

  const record = (row: Datum[], at: number[], prefix?: { t: TypeId; v: Datum }): PgRecord => ({
    kind: "pgrecord",
    types: [...(prefix ? [prefix.t] : []), ...at.map((i) => types[i]!)],
    values: [...(prefix ? [prefix.v] : []), ...at.map((i) => row[i] ?? null)],
  });
  const appendTo = (array: Datum, item: PgRecord): PgArray => {
    const items = array === null ? [] : (array as PgArray).items;
    return makeArray("record", [...items, item]);
  };
  // ROW(cols) = ANY(path): equal field by field; a NULL field makes the comparison not true
  const onPath = (path: Datum, item: PgRecord): boolean =>
    path !== null &&
    (path as PgArray).items.some((seen) => {
      const other = seen as PgRecord;
      return item.values.every((v, i) => {
        const w = other.values[i] ?? null;
        return v !== null && w !== null && datumEquals(item.types[i]!, v, w);
      });
    });

  const extraColumns: Array<{ name: string; type: TypeId }> = [];
  if (search) extraColumns.push({ name: search.set, type: search.breadth ? "record" : "record[]" });
  if (cycle) extraColumns.push({ name: cycle.mark, type: markType }, { name: cycle.path, type: "record[]" });
  const columns = [
    ...names.map((name, i) => ({ name, type: types[i]!, table: null as string | null })),
    ...extraColumns.map((c) => ({ ...c, table: null as string | null })),
  ];
  const width = names.length;

  /** The extra columns of a row, from the row it was produced from (null for the non-recursive term). */
  const extend = (row: Datum[], previous: Datum[] | null): Datum[] => {
    const out = row.slice(0, width);
    let at = width;
    if (search) {
      const prev = previous ? (previous[at] ?? null) : null;
      if (search.breadth) {
        const depth = prev === null ? 0n : BigInt((prev as PgRecord).values[0] as bigint) + 1n;
        out.push(record(row, searchAt, { t: "int8", v: depth }));
      } else {
        out.push(appendTo(prev, record(row, searchAt)));
      }
      at++;
    }
    if (cycle) {
      const prevPath = previous ? (previous[at + 1] ?? null) : null;
      const item = record(row, cycleAt);
      out.push(previous && onPath(prevPath, item) ? markValue : markDefault);
      out.push(appendTo(prevPath, item));
    }
    return out;
  };

  const seen = new Set<string>();
  const keyOf = (row: Datum[]) => row.map((v, i) => datumKey(columns[i]!.type, v)).join("\u0001");
  const admit = (row: Datum[]): boolean => {
    if (body.all) return true;
    const key = keyOf(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  let result: Datum[][] = [];
  let working: Datum[][] = [];
  for (const row of base.rows) {
    const extended = extend(row, null);
    if (!admit(extended)) continue;
    result.push(extended);
    working.push(extended);
  }

  // the recursive term also carries the extra columns of the row it reads
  const extraRefs = extraColumns.map((c) => ({
    expr: { type: "colref", parts: [label, c.name] } as Expr,
    alias: null,
  }));
  const recursive: SelectCore = { ...right, targets: [...right.targets, ...extraRefs] };
  const markAt = search ? width + 1 : width;

  let iterations = 0;
  for (;;) {
    // a row marked as a cycle ends its branch
    if (cycle) working = working.filter((row) => !datumEquals(markType, row[markAt] ?? null, markValue));
    if (working.length === 0) break;
    if (++iterations > MAX_RECURSION_ITERATIONS) {
      throw pgError("program_limit_exceeded", "recursive query iteration limit exceeded", "54000");
    }
    const ctes = new Map(env.ctes);
    ctes.set(cte.name, { columns, rows: working });
    const step = helpers.executeBody({ ...env, ctes }, recursive);
    if (step.columns.length !== columns.length) {
      throw syntax("each UNION query must have the same number of columns");
    }
    const next: Datum[][] = [];
    for (const raw of step.rows) {
      const row = raw.slice(0, width).map((v, i) => {
        if (v === null) return null;
        const source = step.columns[i]!.type;
        return castTo(env.ctx, tv(source === UNKNOWN ? "text" : source, v), types[i]!, {}).v;
      });
      const extended = extend(row, [...row, ...raw.slice(width)]);
      if (!admit(extended)) continue;
      next.push(extended);
    }
    result = result.concat(next);
    if (result.length > MAX_RECURSION_ROWS) {
      throw pgError("program_limit_exceeded", "recursive query result too large", "54000");
    }
    working = next;
  }
  return { columns, rows: result };
}
