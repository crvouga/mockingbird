import type { Expr, TypeName } from "../ast/nodes.ts";
import { pgError } from "../errors/error.ts";
import type { ParserApi } from "./api.ts";

/**
 * SQL/JSON query functions and the IS JSON predicate (PostgreSQL 16/17):
 *
 *   JSON_VALUE ( ctx [FORMAT JSON], path [PASSING v AS n, ...] [RETURNING type] [b ON EMPTY] [b ON ERROR] )
 *   JSON_QUERY ( ctx [FORMAT JSON], path [PASSING ...] [RETURNING type [FORMAT JSON]]
 *                [WITH|WITHOUT [CONDITIONAL|UNCONDITIONAL] [ARRAY] WRAPPER] [KEEP|OMIT QUOTES [ON SCALAR STRING]]
 *                [b ON EMPTY] [b ON ERROR] )
 *   JSON_EXISTS ( ctx [FORMAT JSON], path [PASSING ...] [b ON ERROR] )
 *   expr IS [NOT] JSON [VALUE|OBJECT|ARRAY|SCALAR] [WITH|WITHOUT UNIQUE [KEYS]]
 *
 * They desugar to internal calls the evaluator recognises (src/expressions/sqljson.ts):
 * `__is_json(expr, 'kind:unique')` and `__json_value(spec, ctx, path, passing..., defaults...)` where
 * `spec` is a JSON string literal of {@link SqlJsonSpec}. DEFAULT expressions ride along as trailing
 * arguments so expression walkers see them, and are evaluated only when their behavior applies.
 */

export type SqlJsonFunction = "json_value" | "json_query" | "json_exists";

export type SqlJsonBehaviorKind =
  | "error"
  | "null"
  | "empty_array"
  | "empty_object"
  | "true"
  | "false"
  | "unknown"
  | "default";

/** an ON EMPTY / ON ERROR behavior; `arg` is the call-argument index of a DEFAULT expression */
export interface SqlJsonBehavior {
  readonly kind: SqlJsonBehaviorKind;
  readonly arg?: number;
}

export interface SqlJsonSpec {
  readonly fn: SqlJsonFunction;
  /** PASSING names, parallel to the call arguments that follow ctx and path */
  readonly passing: string[];
  readonly returning: TypeName | null;
  readonly wrapper: "without" | "conditional" | "unconditional" | null;
  readonly quotes: "keep" | "omit" | null;
  readonly onEmpty: SqlJsonBehavior | null;
  readonly onError: SqlJsonBehavior | null;
}

/** The internal function names the SQL/JSON constructs desugar to. */
export const SQLJSON_INTERNAL: Record<string, SqlJsonFunction> = {
  __json_value: "json_value",
  __json_query: "json_query",
  __json_exists: "json_exists",
};

/** PostgreSQL's bare `syntax error at or near "x"` at the current token. */
const syntaxErrorHere = (p: ParserApi): never => {
  const token = p.peek();
  const near = token.type === "eof" ? "end of input" : `"${token.value}"`;
  throw pgError("syntax", `syntax error at or near ${near}`, "42601");
};

/** `FORMAT JSON [ENCODING name]` after a context or PASSING value, or a RETURNING type */
function formatJson(p: ParserApi): boolean {
  if (!(p.atKw("format") && p.atKw("json", 1))) return false;
  p.pos += 2;
  if (p.eatKw("encoding")) p.ident(true);
  return true;
}

const BEHAVIORS: Record<SqlJsonFunction, { empty: Set<SqlJsonBehaviorKind>; error: Set<SqlJsonBehaviorKind> }> = {
  json_value: { empty: new Set(["error", "null", "default"]), error: new Set(["error", "null", "default"]) },
  json_query: {
    empty: new Set(["error", "null", "empty_array", "empty_object", "default"]),
    error: new Set(["error", "null", "empty_array", "empty_object", "default"]),
  },
  json_exists: { empty: new Set(), error: new Set(["error", "true", "false", "unknown"]) },
};

/** DEFAULT takes a constant expression: no column, subquery or window reference. */
function checkDefault(expr: Expr): void {
  const bad = (): never => {
    throw pgError(
      "datatype_mismatch",
      "can only specify a constant, non-aggregate function, or operator expression for DEFAULT",
      "42804",
    );
  };
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    const type = record.type;
    if (type === "colref" || type === "subquery_expr" || type === "array_query") bad();
    if (type === "in_expr" && record.query) bad();
    if (type === "func" && (record.over || record.star || record.filter)) bad();
    for (const value of Object.values(record)) visit(value);
  };
  visit(expr);
}

/** `{ ERROR | NULL | TRUE | FALSE | UNKNOWN | EMPTY [ARRAY | OBJECT] | DEFAULT expr } ON { EMPTY | ERROR }` */
function behavior(
  p: ParserApi,
  args: Expr[],
): { behavior: SqlJsonBehavior; on: "empty" | "error"; start: number } | null {
  const start = p.pos;
  let kind: SqlJsonBehaviorKind;
  let arg: number | undefined;
  if (p.eatKw("error")) kind = "error";
  else if (p.eatKw("null")) kind = "null";
  else if (p.eatKw("true")) kind = "true";
  else if (p.eatKw("false")) kind = "false";
  else if (p.eatKw("unknown")) kind = "unknown";
  else if (p.eatKw("empty")) {
    if (p.eatKw("object")) kind = "empty_object";
    else {
      p.eatKw("array");
      kind = "empty_array";
    }
  } else if (p.atKw("default")) {
    p.pos++;
    const expr = p.parseExpr();
    checkDefault(expr);
    kind = "default";
    arg = args.length + 1; // the spec literal goes first
    args.push(expr);
  } else return null;
  if (!p.eatKw("on")) syntaxErrorHere(p);
  let on: "empty" | "error";
  if (p.eatKw("empty")) on = "empty";
  else {
    p.expectKw("error");
    on = "error";
  }
  return { behavior: arg === undefined ? { kind } : { kind, arg }, on, start };
}

/** `JSON_VALUE(...)` / `JSON_QUERY(...)` / `JSON_EXISTS(...)`, positioned at the function name. */
export function parseSqlJsonFunction(p: ParserApi, fn: SqlJsonFunction): Expr {
  p.pos++;
  p.expectPunct("(");
  const context = p.parseExpr();
  formatJson(p);
  if (!p.eatPunct(",")) syntaxErrorHere(p);
  const path = p.parseExpr();
  const args: Expr[] = [context, path];
  const passing: string[] = [];
  if (p.eatKw("passing")) {
    do {
      const value = p.parseExpr();
      formatJson(p);
      p.expectKw("as");
      passing.push(p.ident(true));
      args.push(value);
    } while (p.eatPunct(","));
  }
  let returning: TypeName | null = null;
  if (fn !== "json_exists" && p.eatKw("returning")) {
    returning = p.parseTypeName();
    if (formatJson(p) && fn === "json_value") {
      throw pgError("syntax", "cannot specify FORMAT JSON in RETURNING clause of JSON_VALUE()", "42601");
    }
  }
  let wrapper: SqlJsonSpec["wrapper"] = null;
  let quotes: SqlJsonSpec["quotes"] = null;
  if (fn === "json_query") {
    if (p.eatKw("without")) {
      p.eatKw("array");
      p.expectKw("wrapper");
      wrapper = "without";
    } else if (p.eatKw("with")) {
      wrapper = p.eatKw("conditional") ? "conditional" : "unconditional";
      if (wrapper === "unconditional") p.eatKw("unconditional");
      p.eatKw("array");
      p.expectKw("wrapper");
    }
    if (p.atKw("keep") || p.atKw("omit")) {
      quotes = p.next().value === "keep" ? "keep" : "omit";
      p.expectKw("quotes");
      if (p.eatKw("on")) {
        p.expectKw("scalar");
        p.expectKw("string");
      }
    }
    if (quotes === "omit" && (wrapper === "conditional" || wrapper === "unconditional")) {
      throw pgError("syntax", "SQL/JSON QUOTES behavior must not be specified when WITH WRAPPER is used", "42601");
    }
  }
  let onEmpty: SqlJsonBehavior | null = null;
  let onError: SqlJsonBehavior | null = null;
  const first = behavior(p, args);
  if (first) {
    if (first.on === "empty") {
      if (fn === "json_exists") {
        p.pos = first.start;
        while (!p.atKw("empty")) p.pos++;
        syntaxErrorHere(p);
      }
      onEmpty = first.behavior;
      const second = behavior(p, args);
      if (second) {
        if (second.on !== "error") {
          p.pos = second.start;
          syntaxErrorHere(p);
        }
        onError = second.behavior;
      }
    } else onError = first.behavior;
  }
  if (onEmpty && !BEHAVIORS[fn].empty.has(onEmpty.kind)) {
    throw pgError("syntax", "invalid ON EMPTY behavior", "42601");
  }
  if (onError && !BEHAVIORS[fn].error.has(onError.kind)) {
    throw pgError("syntax", "invalid ON ERROR behavior", "42601");
  }
  if (!p.eatPunct(")")) syntaxErrorHere(p);
  const spec: SqlJsonSpec = { fn, passing, returning, wrapper, quotes, onEmpty, onError };
  return {
    type: "func",
    name: [`__${fn}`],
    args: [{ type: "string_lit", value: JSON.stringify(spec) }, ...args],
  };
}

/** The rest of `expr IS [NOT] JSON ...`, positioned after JSON. */
export function parseIsJson(p: ParserApi, operand: Expr, not: boolean): Expr {
  let kind = "value";
  for (const candidate of ["value", "object", "array", "scalar"]) {
    if (p.eatKw(candidate)) {
      kind = candidate;
      break;
    }
  }
  let unique = false;
  if ((p.atKw("with") || p.atKw("without")) && p.atKw("unique", 1)) {
    unique = p.next().value === "with";
    p.pos++;
    p.eatKw("keys");
  }
  if (p.atKw("format")) syntaxErrorHere(p);
  const test: Expr = {
    type: "func",
    name: ["__is_json"],
    args: [operand, { type: "string_lit", value: `${kind}:${unique ? "unique" : "any"}` }],
  };
  return not ? { type: "unop", op: "not", operand: test } : test;
}
