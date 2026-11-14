import type { Expr } from "../ast/nodes.ts";
import { PostgresError, pgError, unsupported } from "../errors/error.ts";
import { datumToJsonb } from "../functions/json-fns.ts";
import { jsonToColumn } from "../functions/srf.ts";
import type { SqlJsonBehavior, SqlJsonSpec } from "../parser/sqljson.ts";
import { castTo } from "../types/cast.ts";
import { type JsonbValue, jsonbText, parseJsonText } from "../types/jsonb.ts";
import { jsonpathQuery } from "../types/jsonpath.ts";
import { numericText } from "../types/numeric.ts";
import { resolveTypeName } from "../types/resolve.ts";
import {
  type ColumnType,
  isArrayType,
  isCompositeType,
  isJsonbWrap,
  type JsonbWrap,
  type TypedValue,
  tv,
  typeDisplayName,
  UNKNOWN,
  wrapJsonb,
} from "../types/value.ts";
import type { EngineCtx } from "./context.ts";

/**
 * Evaluation of the SQL/JSON constructs the parser desugars in src/parser/sqljson.ts:
 * `expr IS [NOT] JSON ...` and JSON_VALUE / JSON_QUERY / JSON_EXISTS.
 */

type Evaluate = (expr: Expr) => TypedValue;

const TEXT_INPUT_TYPES = new Set([UNKNOWN, "text", "varchar", "bpchar", "name"]);

// --- IS JSON ------------------------------------------------------------------------------------

/** Whether valid JSON text repeats a key within one object (at any depth). */
function hasDuplicateKeys(text: string): boolean {
  const stack: Array<{ keys: Set<string> | null; expectKey: boolean }> = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (c === "[") stack.push({ keys: null, expectKey: false });
    else if (c === "}" || c === "]") stack.pop();
    else if (c === ",") {
      const top = stack[stack.length - 1];
      if (top?.keys) top.expectKey = true;
    } else if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top?.keys && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.keys.has(key)) return true;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j;
    }
  }
  return false;
}

/** `__is_json(value, 'kind:unique|any')`: IS JSON [VALUE|OBJECT|ARRAY|SCALAR] [WITH UNIQUE KEYS]. */
export function evalIsJson(args: Expr[], evaluate: Evaluate): TypedValue {
  const value = evaluate(args[0]!);
  const [kind, unique] = ((args[1] as Extract<Expr, { type: "string_lit" }>).value ?? "value:any").split(":");
  const t = value.t;
  if (!(TEXT_INPUT_TYPES.has(t) || t === "json" || t === "jsonb" || t === "bytea")) {
    throw pgError("datatype_mismatch", `cannot use type ${typeDisplayName(t)} in IS JSON predicate`, "42804");
  }
  if (value.v === null) return tv("bool", null);
  let parsed: JsonbValue;
  let text: string | null = null;
  if (t === "jsonb" || isJsonbWrap(value.v)) parsed = (value.v as JsonbWrap).value;
  else {
    text = t === "bytea" ? new TextDecoder().decode(value.v as Uint8Array) : String(value.v);
    try {
      // json (unlike jsonb) accepts \u0000; validate the text with it swapped for a harmless escape
      parsed = parseJsonText(text.replace(/\\u0000/gi, "\\u0001"));
    } catch (error) {
      if (error instanceof PostgresError) return tv("bool", false);
      throw error;
    }
  }
  const shape =
    kind === "object"
      ? parsed.j === "obj"
      : kind === "array"
        ? parsed.j === "arr"
        : kind === "scalar"
          ? parsed.j !== "obj" && parsed.j !== "arr"
          : true;
  if (!shape) return tv("bool", false);
  if (unique === "unique" && text !== null && hasDuplicateKeys(text)) return tv("bool", false);
  return tv("bool", true);
}

// --- JSON_VALUE / JSON_QUERY / JSON_EXISTS -----------------------------------------------------

/** The context item: jsonb as is, json or text parsed (a parse error is raised, never caught by ON ERROR). */
function contextItem(value: TypedValue): JsonbValue {
  if (value.t === "jsonb" || isJsonbWrap(value.v)) return (value.v as JsonbWrap).value;
  if (value.t === "json" || TEXT_INPUT_TYPES.has(value.t)) return parseJsonText(String(value.v));
  throw pgError("cannot_coerce", `cannot cast type ${typeDisplayName(value.t)} to jsonb`, "42846");
}

function callsFunction(expr: Expr): boolean {
  const visit = (node: unknown): boolean => {
    if (node === null || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some(visit);
    if ((node as { type?: unknown }).type === "func") return true;
    return Object.values(node).some(visit);
  };
  return visit(expr);
}

/** A failure the ON ERROR clause handles: a data exception from the path or the result coercion. */
function isSoftError(error: unknown): error is PostgresError {
  return error instanceof PostgresError && error.sqlState.startsWith("22");
}

/** `__json_value / __json_query / __json_exists (spec, ctx, path, passing..., defaults...)` */
export function evalSqlJsonFunction(ctx: EngineCtx, args: Expr[], evaluate: Evaluate): TypedValue {
  const spec = JSON.parse((args[0] as Extract<Expr, { type: "string_lit" }>).value) as SqlJsonSpec;
  const resolved =
    spec.returning === null
      ? null
      : resolveTypeName(ctx.state, spec.returning as Parameters<typeof resolveTypeName>[1]).column;
  const target: ColumnType = resolved ?? {
    id: spec.fn === "json_value" ? "text" : spec.fn === "json_query" ? "jsonb" : "bool",
    mod: null,
  };
  if (isCompositeType(target.id)) throw unsupported(`RETURNING a composite type from ${spec.fn.toUpperCase()}`);
  const nothing = tv(target.id, null);
  const coerceDefault = (arg: number): TypedValue =>
    castTo(ctx, evaluate(args[arg]!), target.id, { explicit: true, mod: target.mod });

  // PostgreSQL folds a constant DEFAULT into the returning type while planning, so a DEFAULT that
  // cannot be coerced fails even when its behavior never applies; a DEFAULT calling a function
  // (which may be volatile) is left to run only when needed
  const defaults = new Map<number, TypedValue>();
  for (const behavior of [spec.onEmpty, spec.onError]) {
    if (behavior?.kind === "default" && !callsFunction(args[behavior.arg!]!)) {
      defaults.set(behavior.arg!, coerceDefault(behavior.arg!));
    }
  }

  const contextValue = evaluate(args[1]!);
  if (!(contextValue.t === "json" || contextValue.t === "jsonb" || TEXT_INPUT_TYPES.has(contextValue.t))) {
    throw pgError("cannot_coerce", `cannot cast type ${typeDisplayName(contextValue.t)} to jsonb`, "42846");
  }
  const pathValue = evaluate(args[2]!);
  const vars = new Map<string, JsonbValue>();
  spec.passing.forEach((name, i) => {
    const value = evaluate(args[3 + i]!);
    vars.set(name, value.v === null ? { j: "null" } : datumToJsonb(ctx, value.t, value.v));
  });
  if (contextValue.v === null || pathValue.v === null) return nothing;
  const doc = contextItem(contextValue);
  const path = castTo(ctx, pathValue, "text", { explicit: true }).v as string;

  /** The datum a behavior stands for (raising for ERROR). */
  const behave = (behavior: SqlJsonBehavior | null, fallback: SqlJsonBehavior["kind"], error: PostgresError) => {
    const kind = behavior?.kind ?? fallback;
    switch (kind) {
      case "error":
        throw error;
      case "null":
      case "unknown":
        return nothing;
      case "true":
      case "false":
        return tv("bool", kind === "true");
      case "empty_array":
      case "empty_object":
        return coerceText(kind === "empty_array" ? "[]" : "{}");
      case "default":
        return defaults.get(behavior!.arg!) ?? coerceDefault(behavior!.arg!);
    }
  };
  /** JSON text (or a string's contents) through the target type's input. */
  const coerceText = (text: string): TypedValue => {
    if (target.id === "jsonb") return tv("jsonb", wrapJsonb(parseJsonText(text)));
    return castTo(ctx, tv(UNKNOWN, text), target.id, { assignment: true, mod: target.mod });
  };

  let items: JsonbValue[];
  try {
    items = jsonpathQuery(doc, path, vars, false);
  } catch (error) {
    if (!isSoftError(error)) throw error;
    return behave(spec.onError, spec.fn === "json_exists" ? "false" : "null", error);
  }
  if (spec.fn === "json_exists") return tv("bool", items.length > 0);

  const name = spec.fn === "json_value" ? "JSON_VALUE" : "JSON_QUERY";
  if (items.length === 0) {
    const empty = pgError("data_exception", "no SQL/JSON item found for specified path", "22035");
    // ERROR ON EMPTY is not caught by ON ERROR
    return behave(spec.onEmpty, "null", empty);
  }
  try {
    if (spec.fn === "json_value") {
      if (items.length > 1) {
        throw pgError("data_exception", `JSON path expression in ${name} must return single scalar item`, "22034");
      }
      const item = items[0]!;
      switch (item.j) {
        case "null":
          return nothing;
        case "arr":
        case "obj":
          throw pgError("data_exception", `JSON path expression in ${name} must return single scalar item`, "2203F");
      }
      if (target.id === "jsonb") return tv("jsonb", wrapJsonb(item));
      if (target.id === "json") return tv("json", jsonbText(item));
      const text = item.j === "str" ? item.v : item.j === "num" ? numericText(item.v) : item.v ? "t" : "f";
      return castTo(ctx, tv(UNKNOWN, text), target.id, { assignment: true, mod: target.mod });
    }
    const wrap = spec.wrapper === "unconditional" || (spec.wrapper === "conditional" && items.length > 1);
    if (!wrap && items.length > 1) {
      throw pgError(
        "data_exception",
        "JSON path expression in JSON_QUERY must return single item when no wrapper is requested",
        "22034",
      );
    }
    const value: JsonbValue = wrap ? { j: "arr", v: items } : items[0]!;
    if (value.j === "str" && spec.quotes === "omit") return coerceText(value.v);
    if (target.id === "jsonb") return tv("jsonb", wrapJsonb(value));
    if (isArrayType(target.id)) {
      if (value.j !== "arr") throw pgError("invalid_text_representation", "expected JSON array", "22P02");
      return tv(target.id, jsonToColumn(ctx, value, target));
    }
    return coerceText(jsonbText(value));
  } catch (error) {
    if (!isSoftError(error)) throw error;
    return behave(spec.onError, "null", error);
  }
}
