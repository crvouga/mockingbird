import type { FromJsonTable, JsonTableBehavior, JsonTableColumn } from "../ast/nodes.ts";
import { PostgresError, pgError } from "../errors/error.ts";
import { datumToJsonb } from "../functions/json-fns.ts";
import { castTo } from "../types/cast.ts";
import { type JsonbValue, jsonbText, parseJsonText } from "../types/jsonb.ts";
import { jsonpathExists, jsonpathQuery } from "../types/jsonpath.ts";
import { numericText } from "../types/numeric.ts";
import { resolveTypeName } from "../types/resolve.ts";
import {
  type ColumnType,
  type Datum,
  isArrayType,
  isJsonbWrap,
  type JsonbWrap,
  type TypedValue,
  tv,
  wrapJsonb,
} from "../types/value.ts";
import type { ExecEnv, RelColumn, Relation, RowScope } from "./relation.ts";
import { evalScalar } from "./select.ts";

/**
 * `JSON_TABLE(context, path [AS name] [PASSING ...] COLUMNS (...) [ON ERROR])` (PostgreSQL 17):
 * one row per item the row path selects, each column a JSON_VALUE / JSON_QUERY / EXISTS of that
 * item, `FOR ORDINALITY` counters, and `NESTED PATH` children joined to their parent row as a left
 * outer join (sibling NESTED paths are unioned).
 */

interface Leaf {
  readonly column: Exclude<JsonTableColumn, { kind: "nested" }>;
  readonly type: ColumnType;
  readonly index: number;
}

interface Plan {
  readonly leaves: Leaf[];
  readonly nested: Array<{ readonly path: string; readonly plan: Plan }>;
  /** every output column index this plan (and its children) fills */
  readonly span: number[];
}

function buildPlan(env: ExecEnv, columns: JsonTableColumn[], out: RelColumn[], names: Set<string>): Plan {
  const leaves: Leaf[] = [];
  const nested: Plan["nested"] = [];
  const span: number[] = [];
  for (const column of columns) {
    if (column.kind === "nested") {
      if (column.pathName !== null) claimName(names, column.pathName);
      const plan = buildPlan(env, column.columns, out, names);
      nested.push({ path: column.path, plan });
      span.push(...plan.span);
      continue;
    }
    claimName(names, column.name);
    const type: ColumnType =
      column.kind === "ordinality" ? { id: "int4", mod: null } : resolveTypeName(env.ctx.state, column.typeName).column;
    const index = out.length;
    out.push({ name: column.name, type: type.id, mod: type.mod, table: null });
    leaves.push({ column, type, index });
    span.push(index);
  }
  return { leaves, nested, span };
}

function claimName(names: Set<string>, name: string): void {
  if (names.has(name)) {
    throw pgError("duplicate_object", `duplicate JSON_TABLE column or path name: ${name}`, "42712");
  }
  names.add(name);
}

function jsonContext(value: TypedValue): JsonbValue | null {
  if (value.v === null) return null;
  if (value.t === "jsonb" || isJsonbWrap(value.v)) return (value.v as JsonbWrap).value;
  if (value.t === "json" || value.t === "text" || value.t === "unknown" || value.t === "varchar") {
    return parseJsonText(value.v as string);
  }
  throw pgError("datatype_mismatch", `JSON_TABLE() context item must be of type jsonb, not ${value.t}`, "42804");
}

/** A JSON_VALUE result: a scalar item in the column's type. */
function scalarValue(env: ExecEnv, item: JsonbValue, leaf: Leaf, name: string): Datum {
  const target = leaf.type;
  const assign = (value: TypedValue): Datum =>
    castTo(env.ctx, value, target.id, { explicit: true, mod: target.mod, assignment: true }).v;
  switch (item.j) {
    case "null":
      return null;
    case "str":
      return assign(tv("unknown", item.v));
    // a number or boolean goes through its SQL output text into the column type's input
    case "num":
      return assign(tv("unknown", numericText(item.v)));
    case "bool":
      return assign(tv("unknown", item.v ? "t" : "f"));
    default:
      throw pgError(
        "data_exception",
        `JSON path expression for column "${name}" should return single scalar item`,
        "2203F",
      );
  }
}

/** A JSON_QUERY result: the item(s) as JSON text in the column's type. */
function queryValue(
  env: ExecEnv,
  items: JsonbValue[],
  leaf: Leaf,
  column: Extract<JsonTableColumn, { kind: "regular" }>,
): Datum {
  let value: JsonbValue;
  const wrap =
    column.wrapper === "unconditional" ||
    (column.wrapper === "conditional" && !(items.length === 1 && items[0]!.j !== "arr" && items[0]!.j !== "obj"));
  if (wrap) value = { j: "arr", v: items };
  else {
    if (items.length > 1) {
      throw pgError(
        "data_exception",
        `JSON path expression for column "${column.name}" should return single item without wrapper`,
        "22034",
      );
    }
    value = items[0]!;
  }
  const target = leaf.type;
  const assign = (typed: TypedValue): Datum =>
    castTo(env.ctx, typed, target.id, { explicit: true, mod: target.mod, assignment: true }).v;
  if (value.j === "str" && column.quotes === "omit") return assign(tv("unknown", value.v));
  if (target.id === "jsonb") return wrapJsonb(value);
  return assign(tv("unknown", jsonbText(value)));
}

function behaviorValue(
  env: ExecEnv,
  behavior: JsonTableBehavior | null,
  leaf: Leaf,
  fallback: "null" | "false",
  error: unknown,
): Datum {
  const kind = behavior?.kind ?? fallback;
  const target = leaf.type;
  switch (kind) {
    case "error":
      throw error;
    case "null":
    case "unknown":
      return null;
    case "true":
    case "false":
      return castTo(env.ctx, tv("bool", kind === "true"), target.id, { explicit: true }).v;
    case "empty":
    case "empty_array":
      return castTo(env.ctx, tv("unknown", "[]"), target.id, { explicit: true }).v;
    case "empty_object":
      return castTo(env.ctx, tv("unknown", "{}"), target.id, { explicit: true }).v;
    case "default": {
      const expr = (behavior as Extract<JsonTableBehavior, { kind: "default" }>).expr;
      return castTo(env.ctx, evalScalar(env, null, expr), target.id, { explicit: true, mod: target.mod }).v;
    }
  }
}

function leafValue(env: ExecEnv, item: JsonbValue, ordinal: number, leaf: Leaf, vars: Map<string, JsonbValue>): Datum {
  const column = leaf.column;
  if (column.kind === "ordinality") return ordinal;
  const path = column.path ?? `$."${column.name.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  if (column.kind === "exists") {
    try {
      const found = jsonpathExists(item, path, vars, false);
      return castTo(env.ctx, tv("bool", found), leaf.type.id, { explicit: true }).v;
    } catch (error) {
      if (!(error instanceof PostgresError)) throw error;
      return behaviorValue(env, column.onError, leaf, "false", error);
    }
  }
  let items: JsonbValue[];
  try {
    items = jsonpathQuery(item, path, vars, false);
  } catch (error) {
    if (!(error instanceof PostgresError)) throw error;
    return behaviorValue(env, column.onError, leaf, "null", error);
  }
  if (items.length === 0) {
    const empty = pgError(
      "data_exception",
      `no SQL/JSON item found for specified path of column "${column.name}"`,
      "22035",
    );
    return behaviorValue(env, column.onEmpty, leaf, "null", empty);
  }
  const query =
    column.formatJson ||
    column.wrapper !== null ||
    column.quotes !== null ||
    leaf.type.id === "json" ||
    leaf.type.id === "jsonb" ||
    isArrayType(leaf.type.id);
  try {
    if (query) return queryValue(env, items, leaf, column);
    if (items.length > 1) {
      throw pgError(
        "data_exception",
        `JSON path expression for column "${column.name}" should return single scalar item`,
        "22034",
      );
    }
    return scalarValue(env, items[0]!, leaf, column.name);
  } catch (error) {
    if (!(error instanceof PostgresError)) throw error;
    return behaviorValue(env, column.onError, leaf, "null", error);
  }
}

/** The rows `plan` produces for one item, as full-width rows with only its own span filled. */
function planRows(
  env: ExecEnv,
  plan: Plan,
  item: JsonbValue,
  ordinal: number,
  width: number,
  vars: Map<string, JsonbValue>,
): Datum[][] {
  const base: Datum[] = new Array<Datum>(width).fill(null);
  for (const leaf of plan.leaves) base[leaf.index] = leafValue(env, item, ordinal, leaf, vars);
  if (plan.nested.length === 0) return [base];
  const rows: Datum[][] = [];
  for (const child of plan.nested) {
    const childItems = rowItems(child.path, item, vars, false);
    childItems.forEach((childItem, i) => {
      for (const childRow of planRows(env, child.plan, childItem, i + 1, width, vars)) {
        const row = base.slice();
        for (const index of child.plan.span) row[index] = childRow[index] ?? null;
        rows.push(row);
      }
    });
  }
  return rows.length > 0 ? rows : [base];
}

function rowItems(path: string, doc: JsonbValue, vars: Map<string, JsonbValue>, raise: boolean): JsonbValue[] {
  try {
    return jsonpathQuery(doc, path, vars, false);
  } catch (error) {
    if (raise || !(error instanceof PostgresError)) throw error;
    return [];
  }
}

export function materializeJsonTable(env: ExecEnv, item: FromJsonTable, scope: RowScope | null): Relation {
  const evalEnv: ExecEnv = { ...env, outer: scope ?? env.outer };
  const columns: RelColumn[] = [];
  const names = new Set<string>();
  if (item.pathName !== null) claimName(names, item.pathName);
  const plan = buildPlan(env, item.columns, columns, names);
  const vars = new Map<string, JsonbValue>();
  for (const pass of item.passing) {
    const value = evalScalar(evalEnv, evalEnv.outer, pass.expr);
    vars.set(pass.name, value.v === null ? { j: "null" } : datumToJsonb(env.ctx, value.t, value.v));
  }
  const context = jsonContext(evalScalar(evalEnv, evalEnv.outer, item.context));
  if (context === null) return { columns, rows: [] };
  const raise = item.onError?.kind === "error";
  const rows: Datum[][] = [];
  rowItems(item.path, context, vars, raise).forEach((rowItem, i) => {
    rows.push(...planRows(env, plan, rowItem, i + 1, columns.length, vars));
  });
  return { columns, rows };
}
