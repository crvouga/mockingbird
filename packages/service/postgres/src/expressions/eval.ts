import type {
  ArrayCtor,
  BetweenExpr,
  CaseExpr,
  Expr,
  FuncCall,
  InExpr,
  LikeExpr,
  RowExpr,
  SelectStmt,
  SubqueryExpr,
  SubscriptExpr,
  TypeName,
} from "../ast/nodes.ts";
import { pgError, unsupported } from "../errors/error.ts";
import { extractDatePart } from "../functions/datetime-fns.ts";
import { callScalarFunction, hasScalarFunction } from "../functions/scalar.ts";
import { castTo, isTextType, UTC_CAST_ENV as UTC_LIT_ENV, unifyTypes } from "../types/cast.ts";
import { datumCompare, datumEquals } from "../types/compare.ts";
import type { JsonbValue } from "../types/jsonb.ts";
import { resolveTypeName } from "../types/resolve.ts";
import {
  arrayElemType,
  arrayTypeOf,
  type Datum,
  INT4_MAX,
  INT4_MIN,
  isArrayType,
  isJsonbWrap,
  isPgArray,
  type JsonbWrap,
  makeArray,
  type PgArray,
  type PgRecord,
  type TypedValue,
  type TypeId,
  tv,
  typeDisplayName,
  UNKNOWN,
  wrapJsonb,
} from "../types/value.ts";
import type { EngineCtx } from "./context.ts";
import { evalBinary, evalUnary } from "./operators.ts";
import { likeToRegex, similarToRegex } from "./pattern.ts";

/**
 * Environment the executor provides for expression evaluation: column
 * resolution, parameter binding, subquery execution, aggregate / window
 * result lookup, and user-defined function invocation.
 */
export interface EvalScope {
  lookupColumn(parts: string[]): TypedValue | undefined;
  /**
   * Whole-expression interception (GROUP BY expression matching). Checked
   * before normal evaluation of every node.
   */
  exprOverride?(node: Expr): TypedValue | undefined;
  param?(index: number): TypedValue;
  execScalarSubquery?(q: SelectStmt): TypedValue;
  execExistsSubquery?(q: SelectStmt): boolean;
  /** rows with a single projected column for IN / ANY / ALL / ARRAY(...) */
  execColumnSubquery?(q: SelectStmt): { type: TypeId; values: Datum[] };
  /** precomputed aggregate results (keyed by AST node identity) */
  aggValue?(node: FuncCall): TypedValue | undefined;
  /** precomputed window function results */
  windowValue?(node: FuncCall): TypedValue | undefined;
  groupingValue?(node: Expr): TypedValue | undefined;
  callUserFunction?(name: string[], args: TypedValue[], node: FuncCall): TypedValue | undefined;
  /** sequence functions et al need state mutation; provided by executor */
  callStatefulFunction?(name: string, args: TypedValue[]): TypedValue | undefined;
}

export function evalExpr(ctx: EngineCtx, scope: EvalScope, e: Expr): TypedValue {
  if (scope.exprOverride) {
    const o = scope.exprOverride(e);
    if (o !== undefined) return o;
  }
  switch (e.type) {
    case "null_lit":
      return tv(UNKNOWN, null);
    case "string_lit":
      return tv(UNKNOWN, e.value);
    case "number_lit":
      return numberLitValue(e.raw);
    case "bool_lit":
      return tv("bool", e.value);
    case "bitstring_lit":
      return bitstringValue(e.value);
    case "param": {
      if (!scope.param) throw pgError("undefined_parameter", `there is no parameter $${e.index}`);
      return scope.param(e.index);
    }
    case "colref": {
      const v = scope.lookupColumn(e.parts);
      if (v === undefined) {
        throw pgError("undefined_column", `column "${e.parts.join(".")}" does not exist`);
      }
      return v;
    }
    case "star":
      throw pgError("syntax", "unexpected *");
    case "binop":
      return evalBinaryNode(ctx, scope, e.op, e.left, e.right);
    case "unop": {
      if (e.op === "not") {
        const b = boolArg(ctx, "NOT", evalExpr(ctx, scope, e.operand));
        return tv("bool", b === null ? null : !b);
      }
      return evalUnary(ctx, e.op, evalExpr(ctx, scope, e.operand));
    }
    case "cast":
      return evalCast(ctx, scope, e.expr, e.target);
    case "collate":
      return evalExpr(ctx, scope, e.expr);
    case "func":
      return evalFuncCall(ctx, scope, e);
    case "case":
      return evalCase(ctx, scope, e);
    case "subquery_expr":
      return evalSubquery(ctx, scope, e);
    case "in_expr":
      return evalIn(ctx, scope, e);
    case "between":
      return evalBetween(ctx, scope, e);
    case "is_null": {
      const v = evalExpr(ctx, scope, e.expr);
      const isNull = isPgRecordValue(v) ? recordAllNull(v.v as PgRecord, e.not) : v.v === null;
      return tv("bool", e.not ? !isNull : isNull);
    }
    case "bool_test": {
      const v = toBool(ctx, evalExpr(ctx, scope, e.expr));
      const result = e.test === "unknown" ? v === null : v === (e.test === "true");
      return tv("bool", e.not ? !result : result);
    }
    case "is_distinct": {
      const l = evalExpr(ctx, scope, e.left);
      const r = evalExpr(ctx, scope, e.right);
      const unified = unifyTypes(l.t, r.t);
      if (unified === null) {
        throw pgError(
          "undefined_function",
          `operator does not exist: ${typeDisplayName(l.t)} = ${typeDisplayName(r.t)}`,
        );
      }
      const t = unified;
      const lc = castTo(ctx, l, t, {});
      const rc = castTo(ctx, r, t, {});
      let distinct: boolean;
      if (lc.v === null && rc.v === null) distinct = false;
      else if (lc.v === null || rc.v === null) distinct = true;
      else distinct = !datumEquals(t, lc.v, rc.v, ctx);
      return tv("bool", e.not ? !distinct : distinct);
    }
    case "row":
      return evalRow(ctx, scope, e);
    case "array_ctor":
      return evalArrayCtor(ctx, scope, e);
    case "array_query": {
      if (!scope.execColumnSubquery) throw unsupported("subqueries in this context");
      const { type, values } = scope.execColumnSubquery(e.query);
      const elem = type === UNKNOWN ? "text" : type;
      return tv(`${elem}[]`, makeArray(elem, values));
    }
    case "subscript":
      return evalSubscript(ctx, scope, e);
    case "field_select": {
      const base = evalExpr(ctx, scope, e.base);
      return evalFieldSelect(ctx, base, e.field);
    }
    case "at_time_zone": {
      const v = evalExpr(ctx, scope, e.expr);
      const zone = evalExpr(ctx, scope, e.zone);
      return callScalarFunction(ctx, "timezone", [zone, v]);
    }
    case "like":
      return evalLike(ctx, scope, e);
    case "position": {
      const needle = evalExpr(ctx, scope, e.needle);
      const hay = evalExpr(ctx, scope, e.haystack);
      return callScalarFunction(ctx, "strpos", [hay, needle]);
    }
    case "substring_sql": {
      const src = evalExpr(ctx, scope, e.source);
      if (e.similar !== null) {
        const pat = evalExpr(ctx, scope, e.similar);
        const esc = e.escape ? evalExpr(ctx, scope, e.escape) : tv("text", "\\");
        return callScalarFunction(ctx, "substring_similar", [src, pat, esc]);
      }
      const args = [src];
      if (e.from) args.push(evalExpr(ctx, scope, e.from));
      else args.push(tv("int4", 1));
      if (e.forLen) args.push(evalExpr(ctx, scope, e.forLen));
      return callScalarFunction(ctx, "substring", [...args]);
    }
    case "overlay": {
      const args = [evalExpr(ctx, scope, e.source), evalExpr(ctx, scope, e.placing), evalExpr(ctx, scope, e.from)];
      if (e.forLen) args.push(evalExpr(ctx, scope, e.forLen));
      return callScalarFunction(ctx, "overlay", args);
    }
    case "trim": {
      const src = evalExpr(ctx, scope, e.source);
      const chars = e.chars ? evalExpr(ctx, scope, e.chars) : tv("text", " ");
      const name = e.side === "leading" ? "ltrim" : e.side === "trailing" ? "rtrim" : "btrim";
      return callScalarFunction(ctx, name, [src, chars]);
    }
    case "extract": {
      const src = evalExpr(ctx, scope, e.source);
      return extractDatePart(ctx, e.field, src, true);
    }
    case "grouping_func": {
      const v = scope.groupingValue?.(e);
      if (v === undefined) throw pgError("grouping_error", "GROUPING must appear in GROUP BY context");
      return v;
    }
    case "default_expr":
      throw pgError("syntax", "DEFAULT is not allowed in this context");
  }
}

// --- literals -------------------------------------------------------------------

export function numberLitValue(raw: string): TypedValue {
  let text = raw;
  let negative = false;
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1);
  }
  const isInteger =
    /^\d+$/.test(text) || /^0[xX][0-9a-fA-F]+$/.test(text) || /^0[oO][0-7]+$/.test(text) || /^0[bB][01]+$/.test(text);
  if (isInteger) {
    const big = BigInt(text) * (negative ? -1n : 1n);
    if (big >= BigInt(INT4_MIN) && big <= BigInt(INT4_MAX)) return tv("int4", Number(big));
    if (big >= -9223372036854775808n && big <= 9223372036854775807n) return tv("int8", big);
    return castTo(UTC_LIT_ENV, tv(UNKNOWN, (negative ? "-" : "") + text), "numeric");
  }
  return castTo(UTC_LIT_ENV, tv(UNKNOWN, raw), "numeric");
}

function bitstringValue(value: string): TypedValue {
  const kind = value[0]!.toLowerCase();
  const digits = value.slice(1);
  if (kind === "b") {
    if (!/^[01]*$/.test(digits))
      throw pgError("invalid_text_representation", `"${digits}" is not a valid binary digit`);
    return tv("bit", digits);
  }
  // hex: expand each digit into 4 bits
  let bits = "";
  for (const c of digits) {
    const n = Number.parseInt(c, 16);
    if (Number.isNaN(n)) throw pgError("invalid_text_representation", `"${c}" is not a valid hexadecimal digit`);
    bits += n.toString(2).padStart(4, "0");
  }
  return tv("bit", bits);
}

// --- boolean logic --------------------------------------------------------------

export function toBool(ctx: EngineCtx, v: TypedValue): boolean | null {
  if (v.v === null) return null;
  if (v.t === "bool") return v.v as boolean;
  const cast = castTo(ctx, v, "bool", {});
  return cast.v as boolean | null;
}

/** AND/OR/NOT arguments must already be boolean (or unknown); PG raises 42804 otherwise */
function boolArg(ctx: EngineCtx, kind: string, v: TypedValue): boolean | null {
  if (v.t !== "bool" && v.t !== "unknown") {
    throw pgError("datatype_mismatch", `argument of ${kind} must be type boolean, not type ${typeDisplayName(v.t)}`);
  }
  return toBool(ctx, v);
}

/** WHERE/HAVING/ON/etc. predicates must already be boolean (or unknown); null → false. */
export function evalAsPredicate(ctx: EngineCtx, kind: string, v: TypedValue): boolean {
  return boolArg(ctx, kind, v) === true;
}

/** Plan-time: validate AND/OR/NOT operands are boolean (PG 42804), including short-circuited branches. */
export function checkBoolExprType(ctx: EngineCtx, scope: EvalScope, e: Expr, kind: string): void {
  if (e.type === "binop" && e.op === "and") {
    boolArg(ctx, "AND", evalExpr(ctx, scope, e.left));
    boolArg(ctx, "AND", evalExpr(ctx, scope, e.right));
    return;
  }
  if (e.type === "binop" && e.op === "or") {
    boolArg(ctx, "OR", evalExpr(ctx, scope, e.left));
    boolArg(ctx, "OR", evalExpr(ctx, scope, e.right));
    return;
  }
  if (e.type === "unop" && e.op === "not") {
    boolArg(ctx, "NOT", evalExpr(ctx, scope, e.operand));
    return;
  }
  if (e.type === "cast") {
    checkBoolExprType(ctx, scope, e.expr, kind);
    return;
  }
  if (e.type === "case") {
    validateSearchedCaseTree(ctx, scope, e);
    return;
  }
  const v = evalExpr(ctx, scope, e);
  if (v.t !== "bool" && v.t !== "unknown") {
    throw pgError("datatype_mismatch", `argument of ${kind} must be type boolean, not type ${typeDisplayName(v.t)}`);
  }
}

/** mimic plan-time typing of a short-circuited operand: PG type-checks every branch */
function checkSkippedBoolArg(ctx: EngineCtx, scope: EvalScope, kind: string, e: Expr): void {
  boolArg(ctx, kind, evalExpr(ctx, scope, e));
}

function evalBinaryNode(ctx: EngineCtx, scope: EvalScope, op: string, leftE: Expr, rightE: Expr): TypedValue {
  if (op === "and") {
    const l = boolArg(ctx, "AND", evalExpr(ctx, scope, leftE));
    if (l === false) {
      checkSkippedBoolArg(ctx, scope, "AND", rightE);
      return tv("bool", false);
    }
    const r = boolArg(ctx, "AND", evalExpr(ctx, scope, rightE));
    if (r === false) return tv("bool", false);
    return tv("bool", l === null || r === null ? null : true);
  }
  if (op === "or") {
    const l = boolArg(ctx, "OR", evalExpr(ctx, scope, leftE));
    if (l === true) {
      checkSkippedBoolArg(ctx, scope, "OR", rightE);
      return tv("bool", true);
    }
    const r = boolArg(ctx, "OR", evalExpr(ctx, scope, rightE));
    if (r === true) return tv("bool", true);
    return tv("bool", l === null || r === null ? null : false);
  }
  const l = evalExpr(ctx, scope, leftE);
  const r = evalExpr(ctx, scope, rightE);
  // row-wise comparison: (a,b) = (c,d)
  if (isPgRecordValue(l) && isPgRecordValue(r) && ["=", "<>", "!=", "<", "<=", ">", ">="].includes(op)) {
    return rowCompare(ctx, op, l.v as PgRecord, r.v as PgRecord);
  }
  return evalBinary(ctx, op, l, r);
}

function isPgRecordValue(v: TypedValue): boolean {
  return v.t === "record" && v.v !== null;
}

function recordAllNull(rec: PgRecord, wantNotNull: boolean): boolean {
  // (r) IS NULL is true iff all fields null; IS NOT NULL iff all fields not null
  if (wantNotNull) return rec.values.some((f) => f === null);
  return rec.values.every((f) => f === null);
}

function rowCompare(ctx: EngineCtx, op: string, l: PgRecord, r: PgRecord): TypedValue {
  if (l.values.length !== r.values.length) {
    throw pgError("cardinality_violation", "unequal number of entries in row expressions");
  }
  if (op === "=" || op === "<>" || op === "!=") {
    let sawNull = false;
    for (let i = 0; i < l.values.length; i++) {
      const t = unifyTypes(l.types[i]!, r.types[i]!) ?? "text";
      const a = l.values[i]!;
      const b = r.values[i]!;
      if (a === null || b === null) {
        sawNull = true;
        continue;
      }
      if (!datumEquals(t, a, b, ctx)) return tv("bool", op !== "=");
    }
    if (sawNull) return tv("bool", null);
    return tv("bool", op === "=");
  }
  // ordering comparisons: lexicographic
  for (let i = 0; i < l.values.length; i++) {
    const t = unifyTypes(l.types[i]!, r.types[i]!) ?? "text";
    const a = l.values[i]!;
    const b = r.values[i]!;
    if (a === null || b === null) return tv("bool", null);
    const c = datumCompare(t, a, b, ctx);
    if (c !== 0) {
      switch (op) {
        case "<":
          return tv("bool", c < 0);
        case "<=":
          return tv("bool", c < 0);
        case ">":
          return tv("bool", c > 0);
        case ">=":
          return tv("bool", c > 0);
      }
    }
  }
  return tv("bool", op === "<=" || op === ">=");
}

// --- CAST -----------------------------------------------------------------------

function evalCast(ctx: EngineCtx, scope: EvalScope, inner: Expr, target: TypeName): TypedValue {
  const resolved = resolveTypeName(ctx.state, target);
  const v = evalExpr(ctx, scope, inner);
  const result = castTo(ctx, v, resolved.column.id, { explicit: true, mod: resolved.column.mod });
  if (resolved.domain !== null) {
    applyDomainChecks(ctx, resolved.domain, result);
  }
  return result;
}

/** Domain NOT NULL + CHECK constraints, with VALUE bound to the cast result. */
export function applyDomainChecks(ctx: EngineCtx, domainKey: string, value: TypedValue): void {
  const dot = domainKey.indexOf(".");
  const domain = ctx.state.findDomain(dot === -1 ? [domainKey] : [domainKey.slice(0, dot), domainKey.slice(dot + 1)]);
  if (!domain) return;
  if (domain.notNull && value.v === null) {
    throw pgError("not_null_violation", `domain ${domain.name} does not allow null values`);
  }
  const scope: EvalScope = {
    lookupColumn: (parts) => (parts.length === 1 && parts[0] === "value" ? value : undefined),
  };
  for (const check of domain.checks) {
    const ok = toBool(ctx, evalExpr(ctx, scope, check.expr));
    if (ok === false) {
      throw pgError("check_violation", `value for domain ${domain.name} violates check constraint "${check.name}"`);
    }
  }
}

// --- CASE -----------------------------------------------------------------------

/** Plan-time (PG 42804): every searched CASE/WHEN must be boolean before any branch runs. */
function validateSearchedCaseTree(ctx: EngineCtx, scope: EvalScope, e: CaseExpr): void {
  if (e.operand !== null) return;
  for (const { when, then } of e.whens) {
    boolArg(ctx, "CASE/WHEN", evalExpr(ctx, scope, when));
    validateCaseSubExpr(ctx, scope, then);
  }
  if (e.elseExpr !== null) validateCaseSubExpr(ctx, scope, e.elseExpr);
}

function validateCaseSubExpr(ctx: EngineCtx, scope: EvalScope, e: Expr): void {
  switch (e.type) {
    case "case":
      validateSearchedCaseTree(ctx, scope, e);
      return;
    case "binop":
      if (e.op === "and") {
        boolArg(ctx, "AND", evalExpr(ctx, scope, e.left));
        boolArg(ctx, "AND", evalExpr(ctx, scope, e.right));
      } else if (e.op === "or") {
        boolArg(ctx, "OR", evalExpr(ctx, scope, e.left));
        boolArg(ctx, "OR", evalExpr(ctx, scope, e.right));
      }
      validateCaseSubExpr(ctx, scope, e.left);
      validateCaseSubExpr(ctx, scope, e.right);
      return;
    case "unop":
      if (e.op === "not") {
        boolArg(ctx, "NOT", evalExpr(ctx, scope, e.operand));
      }
      validateCaseSubExpr(ctx, scope, e.operand);
      return;
    case "cast":
    case "collate":
      validateCaseSubExpr(ctx, scope, e.expr);
      return;
    case "func":
      for (const arg of e.args) validateCaseSubExpr(ctx, scope, arg);
      return;
    case "row":
      for (const item of e.items) validateCaseSubExpr(ctx, scope, item);
      return;
    case "array_ctor":
      for (const item of e.items) validateCaseSubExpr(ctx, scope, item);
      return;
    default:
      return;
  }
}

function evalCase(ctx: EngineCtx, scope: EvalScope, e: CaseExpr): TypedValue {
  validateSearchedCaseTree(ctx, scope, e);
  let chosen: Expr | null = null;
  if (e.operand !== null) {
    const operand = evalExpr(ctx, scope, e.operand);
    for (const { when, then } of e.whens) {
      const w = evalExpr(ctx, scope, when);
      const cmp = evalBinary(ctx, "=", operand, w);
      if (cmp.v === true) {
        chosen = then;
        break;
      }
    }
  } else {
    for (const { when, then } of e.whens) {
      const w = evalExpr(ctx, scope, when);
      if (boolArg(ctx, "CASE/WHEN", w) === true) {
        chosen = then;
        break;
      }
    }
  }
  const resultExpr = chosen ?? e.elseExpr;
  if (resultExpr === null) return tv(UNKNOWN, null);
  return evalExpr(ctx, scope, resultExpr);
}

// --- IN / BETWEEN ---------------------------------------------------------------

function evalIn(ctx: EngineCtx, scope: EvalScope, e: InExpr): TypedValue {
  const left = evalExpr(ctx, scope, e.left);
  let sawNull = false;
  let found = false;
  if (e.list) {
    for (const item of e.list) {
      const r = evalExpr(ctx, scope, item);
      const cmp = evalBinary(ctx, "=", left, r);
      if (cmp.v === true) {
        found = true;
        break;
      }
      if (cmp.v === null) sawNull = true;
    }
  } else if (e.query) {
    if (!scope.execColumnSubquery) throw unsupported("subqueries in this context");
    const { type, values } = scope.execColumnSubquery(e.query);
    for (const value of values) {
      const cmp = evalBinary(ctx, "=", left, tv(type, value));
      if (cmp.v === true) {
        found = true;
        break;
      }
      if (cmp.v === null) sawNull = true;
    }
  }
  let result: boolean | null;
  // an empty set makes IN false even for a NULL needle; a NULL needle over a
  // non-empty set yields NULL comparisons (sawNull) per element
  if (found) result = true;
  else if (sawNull) result = null;
  else result = false;
  if (e.not) result = result === null ? null : !result;
  return tv("bool", result);
}

function evalBetween(ctx: EngineCtx, scope: EvalScope, e: BetweenExpr): TypedValue {
  const v = evalExpr(ctx, scope, e.left);
  let low = evalExpr(ctx, scope, e.low);
  let high = evalExpr(ctx, scope, e.high);
  if (e.symmetric) {
    const cmp = evalBinary(ctx, ">", low, high);
    if (cmp.v === true) [low, high] = [high, low];
  }
  const geLow = toBool(ctx, evalBinary(ctx, ">=", v, low));
  const leHigh = toBool(ctx, evalBinary(ctx, "<=", v, high));
  let result: boolean | null;
  if (geLow === false || leHigh === false) result = false;
  else if (geLow === null || leHigh === null) result = null;
  else result = true;
  if (e.not) result = result === null ? null : !result;
  return tv("bool", result);
}

// --- subqueries -----------------------------------------------------------------

function evalSubquery(ctx: EngineCtx, scope: EvalScope, e: SubqueryExpr): TypedValue {
  switch (e.kind) {
    case "scalar": {
      if (!scope.execScalarSubquery) throw unsupported("subqueries in this context");
      return scope.execScalarSubquery(e.query);
    }
    case "exists": {
      if (!scope.execExistsSubquery) throw unsupported("subqueries in this context");
      const exists = scope.execExistsSubquery(e.query);
      return tv("bool", e.not ? !exists : exists);
    }
    case "any":
    case "all": {
      if (!scope.execColumnSubquery) throw unsupported("subqueries in this context");
      const left = evalExpr(ctx, scope, e.left!);
      const { type, values } = scope.execColumnSubquery(e.query);
      return anyAllCompare(
        ctx,
        e.op ?? "=",
        left,
        values.map((v) => tv(type, v)),
        e.kind,
      );
    }
  }
}

export function anyAllCompare(
  ctx: EngineCtx,
  op: string,
  left: TypedValue,
  rights: TypedValue[],
  kind: "any" | "all",
): TypedValue {
  let sawNull = false;
  if (kind === "any") {
    for (const r of rights) {
      const cmp = toBool(ctx, evalBinary(ctx, op, left, r));
      if (cmp === true) return tv("bool", true);
      if (cmp === null) sawNull = true;
    }
    return tv("bool", sawNull ? null : false);
  }
  for (const r of rights) {
    const cmp = toBool(ctx, evalBinary(ctx, op, left, r));
    if (cmp === false) return tv("bool", false);
    if (cmp === null) sawNull = true;
  }
  return tv("bool", sawNull ? null : true);
}

// --- rows / arrays / subscripts ---------------------------------------------------

function evalRow(ctx: EngineCtx, scope: EvalScope, e: RowExpr): TypedValue {
  const values: Datum[] = [];
  const types: TypeId[] = [];
  for (const item of e.items) {
    const v = evalExpr(ctx, scope, item);
    values.push(v.v);
    types.push(v.t);
  }
  const rec: PgRecord = { kind: "pgrecord", types, values };
  return tv("record", rec);
}

function evalArrayCtor(ctx: EngineCtx, scope: EvalScope, e: ArrayCtor): TypedValue {
  const items = e.items.map((item) => evalExpr(ctx, scope, item));
  // nested ARRAY[ARRAY[..]] → multidimensional
  if (items.length > 0 && items.every((i) => isArrayType(i.t) && i.v !== null)) {
    const elem = items
      .map((i) => arrayElemType(i.t))
      .reduce<TypeId | null>((acc, t) => (acc === null ? t : (unifyTypes(acc, t) ?? acc)), null)!;
    const inner = items.map((i) => castTo(ctx, i, `${elem}[]`, {}).v as PgArray);
    const innerDims = inner[0]!.dims;
    for (const arr of inner) {
      if (arr.dims.join(",") !== innerDims.join(",")) {
        throw pgError(
          "array_subscript_error",
          "multidimensional arrays must have array expressions with matching dimensions",
        );
      }
    }
    const values: Datum[] = [];
    for (const arr of inner) values.push(...arr.items);
    return tv(`${elem}[]`, makeArray(elem, values, [items.length, ...innerDims], [1, ...inner[0]!.lbs]));
  }
  let elem: TypeId | null = null;
  for (const item of items) {
    if (item.t === UNKNOWN) continue;
    elem = elem === null ? item.t : (unifyTypes(elem, item.t) ?? elem);
  }
  const finalElem = elem ?? "text";
  const values = items.map((i) => castTo(ctx, i, finalElem, {}).v);
  return tv(`${finalElem}[]`, makeArray(finalElem, values));
}

function evalSubscript(ctx: EngineCtx, scope: EvalScope, e: SubscriptExpr): TypedValue {
  const base = evalExpr(ctx, scope, e.base);
  if (base.t === "jsonb" || (base.t === UNKNOWN && isJsonbWrap(base.v))) {
    return evalJsonbSubscript(ctx, scope, base, e);
  }
  if (!isArrayType(base.t)) {
    throw pgError("datatype_mismatch", `cannot subscript type ${base.t} because it does not support subscripting`);
  }
  if (base.v === null) return tv(arrayElemType(base.t), null);
  const arr = base.v as PgArray;
  const anySlice = e.indexes.some((i) => i.slice);
  if (anySlice) {
    return evalArraySlice(ctx, scope, base.t, arr, e);
  }
  const idx: number[] = [];
  for (const sub of e.indexes) {
    const v = evalExpr(ctx, scope, sub.lower ?? sub.upper!);
    const cast = castTo(ctx, v, "int4", {});
    if (cast.v === null) return tv(arrayElemType(base.t), null);
    idx.push(cast.v as number);
  }
  const dims = arr.dims.length > 0 ? arr.dims : [arr.items.length];
  const lbs = arr.lbs.length > 0 ? arr.lbs : [1];
  if (idx.length !== dims.length) return tv(arrayElemType(base.t), null);
  let flat = 0;
  for (let d = 0; d < dims.length; d++) {
    const i = idx[d]! - lbs[d]!;
    if (i < 0 || i >= dims[d]!) return tv(arrayElemType(base.t), null);
    flat = flat * dims[d]! + i;
  }
  return tv(arrayElemType(base.t), arr.items[flat] ?? null);
}

function evalArraySlice(ctx: EngineCtx, scope: EvalScope, t: TypeId, arr: PgArray, e: SubscriptExpr): TypedValue {
  const dims = arr.dims.length > 0 ? arr.dims : [arr.items.length];
  const lbs = arr.lbs.length > 0 ? arr.lbs : [1];
  if (e.indexes.length !== dims.length) return tv(t, makeArray(arrayElemType(t), []));
  const ranges: Array<{ lo: number; hi: number }> = [];
  for (let d = 0; d < dims.length; d++) {
    const sub = e.indexes[d]!;
    let lo = lbs[d]!;
    let hi = lbs[d]! + dims[d]! - 1;
    if (sub.lower) {
      const v = castTo(ctx, evalExpr(ctx, scope, sub.lower), "int4", {});
      if (v.v === null) return tv(t, null);
      lo = Math.max(lo, v.v as number);
    }
    if (sub.upper && sub.slice) {
      const v = castTo(ctx, evalExpr(ctx, scope, sub.upper), "int4", {});
      if (v.v === null) return tv(t, null);
      hi = Math.min(hi, v.v as number);
    } else if (sub.upper && !sub.lower && !sub.slice) {
      const v = castTo(ctx, evalExpr(ctx, scope, sub.upper), "int4", {});
      if (v.v === null) return tv(t, null);
      lo = v.v as number;
      hi = v.v as number;
    }
    if (hi < lo) return tv(t, makeArray(arrayElemType(t), []));
    ranges.push({ lo, hi });
  }
  const outDims = ranges.map((r) => r.hi - r.lo + 1);
  const out: Datum[] = [];
  const walk = (d: number, offset: number): void => {
    const stride = dims.slice(d + 1).reduce((a, b) => a * b, 1);
    for (let i = ranges[d]!.lo - lbs[d]!; i <= ranges[d]!.hi - lbs[d]!; i++) {
      if (d === dims.length - 1) out.push(arr.items[offset + i] ?? null);
      else walk(d + 1, offset + i * stride);
    }
  };
  walk(0, 0);
  return tv(
    t,
    makeArray(
      arrayElemType(t),
      out,
      outDims,
      outDims.map(() => 1),
    ),
  );
}

function evalJsonbSubscript(ctx: EngineCtx, scope: EvalScope, base: TypedValue, e: SubscriptExpr): TypedValue {
  if (base.v === null) return tv("jsonb", null);
  let current: JsonbValue | null = (base.v as JsonbWrap).value;
  for (const sub of e.indexes) {
    if (current === null) return tv("jsonb", null);
    if (sub.slice) throw pgError("datatype_mismatch", "jsonb subscript does not support slices");
    const k = evalExpr(ctx, scope, sub.lower ?? sub.upper!);
    if (k.v === null) return tv("jsonb", null);
    if (current.j === "obj") {
      const key = String(castTo(ctx, k, "text", { explicit: true }).v);
      current = current.v.get(key) ?? null;
    } else if (current.j === "arr") {
      const cast = castTo(ctx, k, "int4", { explicit: true });
      let i = cast.v as number;
      if (i < 0) i += current.v.length;
      current = current.v[i] ?? null;
    } else {
      return tv("jsonb", null);
    }
  }
  return current === null ? tv("jsonb", null) : tv("jsonb", wrapJsonb(current));
}

function evalFieldSelect(ctx: EngineCtx, base: TypedValue, field: string): TypedValue {
  void ctx;
  if (base.t === "record" && base.v !== null) {
    const rec = base.v as PgRecord;
    if (rec.names) {
      const idx = rec.names.indexOf(field);
      if (idx >= 0) return tv(rec.types[idx]!, rec.values[idx]!);
    }
    throw pgError("undefined_column", `could not identify column "${field}" in record data type`);
  }
  if (base.v === null) return tv(UNKNOWN, null);
  throw pgError("undefined_column", `column notation .${field} applied to type ${base.t}`);
}

// --- LIKE / SIMILAR --------------------------------------------------------------

function evalLike(ctx: EngineCtx, scope: EvalScope, e: LikeExpr): TypedValue {
  const l0 = evalExpr(ctx, scope, e.left);
  const p0 = evalExpr(ctx, scope, e.pattern);
  // ~~ candidates are text-family only; non-text operands have no implicit path
  const likeable = (t: TypeId): boolean => t === "unknown" || isTextType(t) || t === "bytea";
  if (!likeable(l0.t) || !likeable(p0.t)) {
    const op = e.kind === "ilike" ? "~~*" : e.kind === "similar" ? "~" : "~~";
    throw pgError(
      "undefined_function",
      `operator does not exist: ${typeDisplayName(l0.t)} ${op} ${typeDisplayName(p0.t)}`,
    );
  }
  // bytea LIKE matches raw bytes, not the hex text form
  const byteaStr = (v: TypedValue): TypedValue =>
    v.t === "bytea" && v.v !== null ? tv("text", String.fromCharCode(...(v.v as Uint8Array))) : v;
  const l = castTo(ctx, byteaStr(l0), "text", {});
  const p = castTo(ctx, byteaStr(p0), "text", {});
  const escTv = e.escape ? castTo(ctx, evalExpr(ctx, scope, e.escape), "text", {}) : null;
  if (l.v === null || p.v === null || (escTv !== null && escTv.v === null)) return tv("bool", null);
  const esc = escTv === null ? "\\" : (escTv.v as string);
  if (esc.length > 1) throw pgError("invalid_escape_sequence", "invalid escape string");
  let source: string;
  if (e.kind === "similar") {
    source = similarToRegex(p.v as string, esc === "" ? null : esc);
  } else {
    source = likeToRegex(p.v as string, esc === "" ? null : esc);
  }
  const re = new RegExp(source, e.kind === "ilike" ? "is" : "s");
  const match = re.test(l.v as string);
  return tv("bool", e.not ? !match : match);
}

// --- function calls --------------------------------------------------------------

const LAZY_FUNCS = new Set(["coalesce", "nullif", "greatest", "least"]);

function evalFuncCall(ctx: EngineCtx, scope: EvalScope, e: FuncCall): TypedValue {
  const agg = scope.aggValue?.(e);
  if (agg !== undefined) return agg;
  const win = scope.windowValue?.(e);
  if (win !== undefined) return win;
  if (e.over) {
    throw pgError("windowing_error", "window functions are not allowed in this context");
  }

  const bare = e.name.length === 1 ? e.name[0]! : e.name.length === 2 && e.name[0] === "pg_catalog" ? e.name[1]! : null;

  if (bare !== null && LAZY_FUNCS.has(bare)) {
    return evalLazyFunc(ctx, scope, bare, e.args);
  }

  // parser-desugared `x op ANY(array)` / `x op ALL(array)`
  if (bare === "__any_array" || bare === "__all_array") {
    return evalAnyAllArray(ctx, scope, bare === "__any_array" ? "any" : "all", e.args);
  }
  // parser-desugared `(s1, e1) OVERLAPS (s2, e2)`
  if (bare === "__overlaps") {
    return evalOverlaps(ctx, scope, e.args);
  }

  let args = e.args.map((a) => evalExpr(ctx, scope, a));
  if (e.argNames && bare !== null) args = reorderNamedArgs(bare, args, e.argNames);

  if (bare !== null) {
    const stateful = scope.callStatefulFunction?.(bare, args);
    if (stateful !== undefined) return stateful;
  }

  const user = scope.callUserFunction?.(e.name, args, e);
  if (user !== undefined) return user;

  if (bare !== null && hasScalarFunction(bare)) {
    return callScalarFunction(ctx, bare, args);
  }

  throw pgError(
    "undefined_function",
    `function ${e.name.join(".")}(${args.map((a) => a.t).join(", ")}) does not exist`,
  );
}

/** Builtin parameter-name signatures for named-notation calls (f(a => 1)). */
const NAMED_ARG_SIGNATURES = new Map<string, { params: string[]; defaults: TypedValue[] }>([
  [
    "make_interval",
    {
      params: ["years", "months", "weeks", "days", "hours", "mins", "secs"],
      defaults: [
        tv("int4", 0),
        tv("int4", 0),
        tv("int4", 0),
        tv("int4", 0),
        tv("int4", 0),
        tv("int4", 0),
        tv("float8", 0),
      ],
    },
  ],
]);

function reorderNamedArgs(name: string, args: TypedValue[], argNames: (string | null)[]): TypedValue[] {
  const sig = NAMED_ARG_SIGNATURES.get(name);
  if (!sig) return args;
  const out = sig.defaults.slice();
  let pos = 0;
  for (let i = 0; i < args.length; i++) {
    const n = argNames[i];
    const idx = n === null || n === undefined ? pos++ : sig.params.indexOf(n);
    if (idx < 0) throw pgError("undefined_function", `function ${name} has no parameter named "${n}"`);
    out[idx] = args[i]!;
  }
  return out;
}

function evalOverlaps(ctx: EngineCtx, scope: EvalScope, args: Expr[]): TypedValue {
  const pair = (e: Expr): [TypedValue, TypedValue] => {
    if (e.type === "row" && e.items.length === 2) {
      return [evalExpr(ctx, scope, e.items[0]!), evalExpr(ctx, scope, e.items[1]!)];
    }
    throw pgError("syntax", "OVERLAPS requires (start, end) pairs");
  };
  const [s1r, e1r] = pair(args[0]!);
  const [s2r, e2r] = pair(args[1]!);
  // unify all four endpoints to a common datetime type; intervals mean start + interval
  const resolveEnd = (start: TypedValue, end: TypedValue): TypedValue =>
    end.t === "interval" ? evalBinary(ctx, "+", start, end) : end;
  const e1 = resolveEnd(s1r, e1r);
  const e2 = resolveEnd(s2r, e2r);
  const target = [s1r, e1, s2r, e2].map((x) => x.t).find((t) => t !== "unknown") ?? "timestamp";
  const vals = [s1r, e1, s2r, e2].map((x) => castTo(ctx, x, target, { explicit: true }));
  if (vals.some((x) => x.v === null)) return tv("bool", null);
  const cmp = (a: TypedValue, b: TypedValue): number => datumCompare(target, a.v as Datum, b.v as Datum, ctx);
  let [s1, en1, s2, en2] = vals as [TypedValue, TypedValue, TypedValue, TypedValue];
  if (cmp(s1, en1) > 0) [s1, en1] = [en1, s1];
  if (cmp(s2, en2) > 0) [s2, en2] = [en2, s2];
  return tv("bool", cmp(s1, en2) < 0 && cmp(s2, en1) < 0);
}

function evalAnyAllArray(ctx: EngineCtx, scope: EvalScope, kind: "any" | "all", args: Expr[]): TypedValue {
  const left = evalExpr(ctx, scope, args[0]!);
  const arrArg = args[1]!;
  const opArg = args[2]!;
  const op = opArg.type === "string_lit" ? opArg.value : "=";
  let arr = evalExpr(ctx, scope, arrArg);
  if (arr.v === null) return tv("bool", null);
  if (arr.t === UNKNOWN || typeof arr.v === "string") {
    // untyped literal: infer element type from the left operand
    const elemT = left.t === UNKNOWN ? "text" : left.t;
    arr = castTo(ctx, arr, arrayTypeOf(elemT), {});
  }
  if (!isPgArray(arr.v)) {
    throw pgError("datatype_mismatch", `op ${kind.toUpperCase()} requires an array`, "42809");
  }
  const elemType = arr.v.elem;
  const rights = arr.v.items.map((item) => tv(elemType, item));
  return anyAllCompare(ctx, op, left, rights, kind);
}

function evalLazyFunc(ctx: EngineCtx, scope: EvalScope, name: string, argExprs: Expr[]): TypedValue {
  switch (name) {
    case "coalesce": {
      let t: TypeId = UNKNOWN;
      for (const a of argExprs) {
        const v = evalExpr(ctx, scope, a);
        if (v.t !== UNKNOWN) t = t === UNKNOWN ? v.t : (unifyTypes(t, v.t) ?? t);
        if (v.v !== null) return t === UNKNOWN ? v : castTo(ctx, v, t, {});
      }
      return tv(t === UNKNOWN ? "text" : t, null);
    }
    case "nullif": {
      if (argExprs.length !== 2) throw pgError("undefined_function", "NULLIF requires 2 arguments");
      const a = evalExpr(ctx, scope, argExprs[0]!);
      const b = evalExpr(ctx, scope, argExprs[1]!);
      const cmp = evalBinary(ctx, "=", a, b);
      if (cmp.v === true) return tv(a.t, null);
      return a;
    }
    case "greatest":
    case "least": {
      const op = name === "greatest" ? ">" : "<";
      let best: TypedValue | null = null;
      let t: TypeId = UNKNOWN;
      const vals = argExprs.map((a) => evalExpr(ctx, scope, a));
      for (const v of vals) {
        if (v.t !== UNKNOWN) t = t === UNKNOWN ? v.t : (unifyTypes(t, v.t) ?? t);
      }
      const finalT = t === UNKNOWN ? "text" : t;
      for (const v0 of vals) {
        const v = castTo(ctx, v0, finalT, {});
        if (v.v === null) continue;
        if (best === null || evalBinary(ctx, op, v, best).v === true) best = v;
      }
      return best ?? tv(finalT, null);
    }
    default:
      throw pgError("internal", `lazy function ${name} not handled`);
  }
}
