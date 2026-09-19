import { pgError } from "../errors/error.ts";
import { tsqueryCombine, tsqueryNegate, tsvectorConcat, tsvectorMatches } from "../tsearch/tsearch.ts";
import { castTo, isTextType, unifyTypes } from "../types/cast.ts";
import { datumCompare, datumEquals } from "../types/compare.ts";
import {
  DATE_NEG_INF,
  DATE_POS_INF,
  type Interval,
  intervalAdd,
  intervalNeg,
  makeInterval,
  TS_NEG_INF,
  TS_POS_INF,
  timestampAddInterval,
  USECS_PER_DAY,
} from "../types/datetime.ts";
import {
  type JsonbValue,
  jsonbArr,
  jsonbContains,
  jsonbText,
  parseJsonText as parseJsonbText,
} from "../types/jsonb.ts";
import {
  isNumeric,
  makeNumeric,
  type Numeric,
  numericAbs,
  numericAdd,
  numericDiv,
  numericFromBigInt,
  numericMod,
  numericMul,
  numericNeg,
  numericPower,
  numericSqrt,
  numericSub,
  numericToNumber,
  parseNumeric,
} from "../types/numeric.ts";
import {
  arrayElemType,
  arrayTypeOf,
  checkInt2,
  checkInt4,
  checkInt8,
  type Datum,
  datumText,
  float8Text,
  isArrayType,
  type JsonbWrap,
  makeArray,
  type PgArray,
  type TypedValue,
  type TypeId,
  tv,
  typeDisplayName,
  wrapJsonb,
} from "../types/value.ts";
import type { EngineCtx } from "./context.ts";
import { likeMatch, regexMatch } from "./pattern.ts";

const NUM_LADDER = ["int2", "int4", "int8", "numeric", "float4", "float8"];

function opNotExist(op: string, l: TypeId, r: TypeId): never {
  throw pgError("undefined_function", `operator does not exist: ${typeDisplayName(l)} ${op} ${typeDisplayName(r)}`);
}

function isIntType(t: TypeId): boolean {
  return t === "int2" || t === "int4" || t === "int8";
}

function isNumType(t: TypeId): boolean {
  return NUM_LADDER.includes(t);
}

function toF8(t: TypeId, v: Datum): number {
  if (t === "int8") return Number(v as bigint);
  if (t === "numeric") return numericToNumber(v as Numeric);
  return v as number;
}

function toNumeric(t: TypeId, v: Datum): Numeric {
  if (t === "numeric") return v as Numeric;
  if (t === "int8") return numericFromBigInt(v as bigint);
  return numericFromBigInt(BigInt(v as number));
}

function toI8(t: TypeId, v: Datum): bigint {
  return t === "int8" ? (v as bigint) : BigInt(v as number);
}

const COMPARISONS = new Set(["=", "<>", "<", "<=", ">", ">="]);

/** per-operator: types that have operator candidates an unknown can resolve against */
const ADD_CAPABLE = new Set([
  "int2",
  "int4",
  "int8",
  "float4",
  "float8",
  "numeric",
  "money",
  "interval",
  "date",
  "time",
  "timetz",
  "timestamp",
  "timestamptz",
]);
const MOD_CAPABLE = new Set(["int2", "int4", "int8", "numeric"]);
const POW_CAPABLE = new Set(["int2", "int4", "int8", "float4", "float8", "numeric"]);
const BIT_CAPABLE = new Set(["int2", "int4", "int8", "bit", "varbit"]);

function opCapable(op: string, t: TypeId): boolean {
  switch (op) {
    case "+":
    case "-":
    case "*":
    case "/":
      return ADD_CAPABLE.has(t);
    case "%":
      return MOD_CAPABLE.has(t);
    case "^":
      return POW_CAPABLE.has(t);
    case "&":
    case "|":
    case "#":
    case "<<":
    case ">>":
      return BIT_CAPABLE.has(t);
    default:
      return true;
  }
}

/** resolve unknown-typed operands against the other side */
function resolveUnknowns(ctx: EngineCtx, op: string, l: TypedValue, r: TypedValue): [TypedValue, TypedValue] {
  // numeric/bit operators have no candidates for e.g. bool — report original
  // types ("operator does not exist: unknown + boolean") instead of coercing
  // types whose || operator concatenates same-type operands; anything else pairs
  // with unknown via `text || anynonarray` (result is text)
  const concatsWithSelf = (t: TypeId): boolean =>
    isTextType(t) ||
    t === "bytea" ||
    t === "bit" ||
    t === "varbit" ||
    t === "jsonb" ||
    t === "json" ||
    t === "tsvector" ||
    t === "tsquery" ||
    isArrayType(t);
  // ^ has only float8 and numeric candidates: ints resolve to the preferred float8
  const unknownTarget = (known: TypeId): TypeId => {
    if (op === "^" && known !== "numeric") return "float8";
    if (op === "||" && !concatsWithSelf(known)) return "text";
    return known;
  };
  if (l.t === "unknown" && r.t !== "unknown") {
    if (!opCapable(op, r.t)) opNotExist(op, l.t, r.t);
    const target = unknownTarget(r.t);
    return [castTo(ctx, l, target), target === r.t ? r : castTo(ctx, r, target)];
  }
  if (r.t === "unknown" && l.t !== "unknown") {
    if (!opCapable(op, l.t)) opNotExist(op, l.t, r.t);
    const target = unknownTarget(l.t);
    return [target === l.t ? l : castTo(ctx, l, target), castTo(ctx, r, target)];
  }
  if (l.t === "unknown" && r.t === "unknown") {
    if (COMPARISONS.has(op) || op === "||" || op === "~~" || op === "~") {
      return [castTo(ctx, l, "text"), castTo(ctx, r, "text")];
    }
    // ^ has only numeric candidates, so the preferred type float8 wins
    if (op === "^") {
      return [castTo(ctx, l, "float8"), castTo(ctx, r, "float8")];
    }
    // other overloaded numeric/bit operators cannot pick a candidate from two unknowns
    if (AMBIGUOUS_ON_UNKNOWN.has(op)) {
      throw pgError("ambiguous_function", `operator is not unique: unknown ${op} unknown`);
    }
  }
  return [l, r];
}

/** operators with multiple candidate signatures for (unknown, unknown) — PG raises 42725 */
const AMBIGUOUS_ON_UNKNOWN = new Set(["+", "-", "*", "/", "%", "&", "|", "#", "<<", ">>"]);

export function evalBinary(ctx: EngineCtx, op: string, l0: TypedValue, r0: TypedValue): TypedValue {
  // jsonb/json extraction ops keep unknown on rhs as text
  const [l, r] = resolveJsonUnknowns(ctx, op, l0, r0);

  if (COMPARISONS.has(op)) {
    return evalComparison(ctx, op, l, r);
  }

  switch (op) {
    case "+":
    case "-":
    case "*":
    case "/":
    case "%":
    case "^":
      return evalArithmetic(ctx, op, l, r);
    case "||":
      return evalConcat(ctx, l, r);
    case "&":
    case "|":
    case "#":
    case "<<":
    case ">>":
      return evalBitwise(ctx, op, l, r);
    case "~~":
    case "~~*":
    case "!~~":
    case "!~~*":
      return evalLikeOp(ctx, op, l, r);
    case "~":
    case "~*":
    case "!~":
    case "!~*":
      return evalRegexOp(ctx, op, l, r);
    case "@>":
    case "<@":
    case "&&":
      return evalContainment(ctx, op, l, r);
    case "->":
    case "->>":
    case "#>":
    case "#>>":
      return evalJsonExtract(ctx, op, l, r);
    case "?":
    case "?|":
    case "?&":
      return evalJsonbExists(ctx, op, l, r);
    case "#-":
      return evalJsonbDeletePath(ctx, l, r);
    case "@@":
      return evalTextSearchMatch(ctx, l, r);
    default:
      opNotExist(op, l.t, r.t);
  }
}

function resolveJsonUnknowns(ctx: EngineCtx, op: string, l: TypedValue, r: TypedValue): [TypedValue, TypedValue] {
  if ((op === "->" || op === "->>") && (l.t === "json" || l.t === "jsonb")) {
    if (r.t === "unknown") return [l, castTo(ctx, r, "text")];
    return [l, r];
  }
  if ((op === "#>" || op === "#>>") && (l.t === "json" || l.t === "jsonb")) {
    if (r.t === "unknown") return [l, castTo(ctx, r, "text[]")];
    return [l, r];
  }
  if ((op === "?" || op === "-") && l.t === "jsonb" && r.t === "unknown") {
    return [l, castTo(ctx, r, "text")];
  }
  if ((op === "?|" || op === "?&" || op === "#-") && l.t === "jsonb" && r.t === "unknown") {
    return [l, castTo(ctx, r, "text[]")];
  }
  if (op === "@>" || op === "<@") {
    if (l.t === "jsonb" && r.t === "unknown") return [l, castTo(ctx, r, "jsonb")];
    if (r.t === "jsonb" && l.t === "unknown") return [castTo(ctx, l, "jsonb"), r];
  }
  if (op === "-" && l.t === "jsonb" && (r.t === "text" || r.t === "int4" || r.t === "text[]")) {
    return [l, r];
  }
  return resolveUnknowns(ctx, op, l, r);
}

function evalComparison(ctx: EngineCtx, op: string, l: TypedValue, r: TypedValue): TypedValue {
  const unified = unifyTypes(l.t, r.t);
  if (unified === null) opNotExist(op, l.t, r.t);
  if (l.v === null || r.v === null) return tv("bool", null);
  const lv = castTo(ctx, l, unified).v;
  const rv = castTo(ctx, r, unified).v;
  const c = datumCompare(unified, lv, rv, ctx);
  let result: boolean;
  switch (op) {
    case "=":
      result = c === 0;
      break;
    case "<>":
      result = c !== 0;
      break;
    case "<":
      result = c < 0;
      break;
    case "<=":
      result = c <= 0;
      break;
    case ">":
      result = c > 0;
      break;
    default:
      result = c >= 0;
  }
  return tv("bool", result);
}

// --- arithmetic --------------------------------------------------------------

function addI(t: TypeId, a: bigint, b: bigint): Datum {
  const r = a + b;
  return checkIntRange(t, r);
}

function checkIntRange(t: TypeId, r: bigint): Datum {
  if (t === "int2") return checkInt2(Number(r));
  if (t === "int4") return checkInt4(Number(r));
  return checkInt8(r);
}

function evalArithmetic(ctx: EngineCtx, op: string, l: TypedValue, r: TypedValue): TypedValue {
  const lt = l.t;
  const rt = r.t;

  // jsonb - text / int / text[] (key, index, key-set deletion)
  if (op === "-" && lt === "jsonb") {
    return evalJsonbDelete(ctx, l, r);
  }

  // datetime / interval arithmetic
  const dt = tryDatetimeArith(ctx, op, l, r);
  if (dt) return dt;

  // money
  const money = tryMoneyArith(op, l, r);
  if (money) return money;

  if (!isNumType(lt) || !isNumType(rt)) opNotExist(op, lt, rt);
  if (l.v === null || r.v === null) {
    return tv(NUM_LADDER[Math.max(NUM_LADDER.indexOf(lt), NUM_LADDER.indexOf(rt))]!, null);
  }

  if (op === "^") {
    // numeric^numeric only when both non-float and at least one numeric… PG picks
    // float8 for int args, numeric when either side is numeric
    if (
      (lt === "numeric" || rt === "numeric") &&
      lt !== "float4" &&
      lt !== "float8" &&
      rt !== "float4" &&
      rt !== "float8"
    ) {
      return tv("numeric", numericPower(toNumeric(lt, l.v), toNumeric(rt, r.v)));
    }
    const res = toF8(lt, l.v) ** toF8(rt, r.v);
    if (!Number.isFinite(res) && Number.isFinite(toF8(lt, l.v)) && Number.isFinite(toF8(rt, r.v))) {
      if (Number.isNaN(res)) {
        throw pgError(
          "invalid_parameter_value",
          "a negative number raised to a non-integer power yields a complex result",
        );
      }
      throw pgError("numeric_value_out_of_range", "value out of range: overflow");
    }
    return tv("float8", res);
  }

  const idx = Math.max(NUM_LADDER.indexOf(lt), NUM_LADDER.indexOf(rt));
  const resultType = NUM_LADDER[idx]!;

  if (resultType === "float4" || resultType === "float8") {
    const a = toF8(lt, l.v);
    const b = toF8(rt, r.v);
    let res: number;
    switch (op) {
      case "+":
        res = a + b;
        break;
      case "-":
        res = a - b;
        break;
      case "*":
        res = a * b;
        break;
      case "/":
        if (b === 0) throw pgError("division_by_zero", "division by zero");
        res = a / b;
        break;
      default:
        opNotExist(op, lt, rt);
    }
    if (resultType === "float4") {
      const f = Math.fround(res);
      if (!Number.isFinite(f) && Number.isFinite(a) && Number.isFinite(b)) {
        throw pgError("numeric_value_out_of_range", "value out of range: overflow");
      }
      return tv("float4", f);
    }
    if (!Number.isFinite(res) && Number.isFinite(a) && Number.isFinite(b) && !Number.isNaN(res)) {
      throw pgError("numeric_value_out_of_range", "value out of range: overflow");
    }
    return tv("float8", res);
  }

  if (resultType === "numeric") {
    const a = toNumeric(lt, l.v);
    const b = toNumeric(rt, r.v);
    switch (op) {
      case "+":
        return tv("numeric", numericAdd(a, b));
      case "-":
        return tv("numeric", numericSub(a, b));
      case "*":
        return tv("numeric", numericMul(a, b));
      case "/":
        return tv("numeric", numericDiv(a, b));
      case "%":
        return tv("numeric", numericMod(a, b));
      default:
        opNotExist(op, lt, rt);
    }
  }

  // integer arithmetic with overflow checks
  const a = toI8(lt, l.v);
  const b = toI8(rt, r.v);
  switch (op) {
    case "+":
      return tv(resultType, addI(resultType, a, b));
    case "-":
      return tv(resultType, checkIntRange(resultType, a - b));
    case "*":
      return tv(resultType, checkIntRange(resultType, a * b));
    case "/": {
      if (b === 0n) throw pgError("division_by_zero", "division by zero");
      const q = a / b;
      // BigInt division truncates toward zero (matches PG)
      return tv(resultType, checkIntRange(resultType, q));
    }
    case "%": {
      if (b === 0n) throw pgError("division_by_zero", "division by zero");
      return tv(resultType, checkIntRange(resultType, a % b));
    }
    default:
      opNotExist(op, lt, rt);
  }
}

function tryDatetimeArith(ctx: EngineCtx, op: string, l: TypedValue, r: TypedValue): TypedValue | null {
  const lt = l.t;
  const rt = r.t;
  const isDT = (t: TypeId): boolean => ["date", "time", "timestamp", "timestamptz", "interval"].includes(t);
  if (!isDT(lt) && !isDT(rt)) return null;

  const key = `${lt}${op}${rt}`;
  const nullOf = (t: TypeId): TypedValue => tv(t, null);

  switch (key) {
    case "date+int4":
    case "date+int2": {
      if (l.v === null || r.v === null) return nullOf("date");
      return tv("date", dateAddDays(l.v as number, Number(r.v)));
    }
    case "int4+date":
    case "int2+date": {
      if (l.v === null || r.v === null) return nullOf("date");
      return tv("date", dateAddDays(r.v as number, Number(l.v)));
    }
    case "date-int4":
    case "date-int2": {
      if (l.v === null || r.v === null) return nullOf("date");
      return tv("date", dateAddDays(l.v as number, -Number(r.v)));
    }
    case "date-date": {
      if (l.v === null || r.v === null) return nullOf("int4");
      return tv("int4", (l.v as number) - (r.v as number));
    }
    case "date+interval":
    case "interval+date": {
      const d = lt === "date" ? l : r;
      const iv = lt === "date" ? r : l;
      if (d.v === null || iv.v === null) return nullOf("timestamp");
      const ts = BigInt(d.v as number) * USECS_PER_DAY;
      return tv("timestamp", timestampAddInterval(ts, iv.v as Interval));
    }
    case "date-interval": {
      if (l.v === null || r.v === null) return nullOf("timestamp");
      const ts = BigInt(l.v as number) * USECS_PER_DAY;
      return tv("timestamp", timestampAddInterval(ts, intervalNeg(r.v as Interval)));
    }
    case "date+time":
    case "time+date": {
      const d = lt === "date" ? l : r;
      const t = lt === "date" ? r : l;
      if (d.v === null || t.v === null) return nullOf("timestamp");
      return tv("timestamp", BigInt(d.v as number) * USECS_PER_DAY + (t.v as bigint));
    }
    case "timestamp+interval":
    case "interval+timestamp": {
      const ts = lt === "timestamp" ? l : r;
      const iv = lt === "timestamp" ? r : l;
      if (ts.v === null || iv.v === null) return nullOf("timestamp");
      return tv("timestamp", timestampAddInterval(ts.v as bigint, iv.v as Interval));
    }
    case "timestamp-interval": {
      if (l.v === null || r.v === null) return nullOf("timestamp");
      return tv("timestamp", timestampAddInterval(l.v as bigint, intervalNeg(r.v as Interval)));
    }
    case "timestamptz+interval":
    case "interval+timestamptz": {
      const ts = lt === "timestamptz" ? l : r;
      const iv = lt === "timestamptz" ? r : l;
      if (ts.v === null || iv.v === null) return nullOf("timestamptz");
      return tv("timestamptz", timestamptzAddInterval(ctx, ts.v as bigint, iv.v as Interval));
    }
    case "timestamptz-interval": {
      if (l.v === null || r.v === null) return nullOf("timestamptz");
      return tv("timestamptz", timestamptzAddInterval(ctx, l.v as bigint, intervalNeg(r.v as Interval)));
    }
    case "timestamp-timestamp":
    case "timestamptz-timestamptz": {
      if (l.v === null || r.v === null) return nullOf("interval");
      return tv("interval", timestampDiff(l.v as bigint, r.v as bigint));
    }
    case "time+interval":
    case "interval+time": {
      const t = lt === "time" ? l : r;
      const iv = lt === "time" ? r : l;
      if (t.v === null || iv.v === null) return nullOf("time");
      let micros = ((t.v as bigint) + (iv.v as Interval).micros) % USECS_PER_DAY;
      if (micros < 0n) micros += USECS_PER_DAY;
      return tv("time", micros);
    }
    case "time-interval": {
      if (l.v === null || r.v === null) return nullOf("time");
      let micros = ((l.v as bigint) - (r.v as Interval).micros) % USECS_PER_DAY;
      if (micros < 0n) micros += USECS_PER_DAY;
      return tv("time", micros);
    }
    case "time-time": {
      if (l.v === null || r.v === null) return nullOf("interval");
      return tv("interval", makeInterval(0, 0, (l.v as bigint) - (r.v as bigint)));
    }
    case "interval+interval": {
      if (l.v === null || r.v === null) return nullOf("interval");
      return tv("interval", intervalAdd(l.v as Interval, r.v as Interval));
    }
    case "interval-interval": {
      if (l.v === null || r.v === null) return nullOf("interval");
      return tv("interval", intervalAdd(l.v as Interval, intervalNeg(r.v as Interval)));
    }
    default:
      break;
  }

  // interval * number / interval / number
  if (op === "*" && lt === "interval" && isNumType(rt)) {
    if (l.v === null || r.v === null) return nullOf("interval");
    return tv("interval", intervalScale(l.v as Interval, toF8(rt, r.v)));
  }
  if (op === "*" && rt === "interval" && isNumType(lt)) {
    if (l.v === null || r.v === null) return nullOf("interval");
    return tv("interval", intervalScale(r.v as Interval, toF8(lt, l.v)));
  }
  if (op === "/" && lt === "interval" && isNumType(rt)) {
    if (l.v === null || r.v === null) return nullOf("interval");
    const f = toF8(rt, r.v);
    if (f === 0) throw pgError("division_by_zero", "division by zero");
    return tv("interval", intervalScale(l.v as Interval, 1 / f));
  }
  if (op === "-" && lt === "interval" && rt === "interval") {
    if (l.v === null || r.v === null) return nullOf("interval");
    return tv("interval", intervalAdd(l.v as Interval, intervalNeg(r.v as Interval)));
  }
  // unknown-side coercions: date + 'unknown'? let caller resolve; here try casting unknown
  if (lt === "unknown" || rt === "unknown") {
    const known = lt === "unknown" ? rt : lt;
    if (isDT(known)) {
      // interpret the unknown as interval for +/- with timestamps, else fail through
      const target = known === "interval" ? "interval" : "interval";
      try {
        const lc = lt === "unknown" ? castTo(ctx, l, target) : l;
        const rc = rt === "unknown" ? castTo(ctx, r, target) : r;
        return tryDatetimeArith(ctx, op, lc, rc) ?? null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function dateAddDays(d: number, days: number): number {
  if (d === DATE_POS_INF || d === DATE_NEG_INF) return d;
  const r = d + days;
  if (r >= DATE_POS_INF || r <= DATE_NEG_INF) {
    throw pgError("invalid_datetime", "date out of range");
  }
  return r;
}

function timestamptzAddInterval(ctx: EngineCtx, ts: bigint, iv: Interval): bigint {
  if (ts === TS_POS_INF || ts === TS_NEG_INF) return ts;
  if (iv.months === 0 && iv.days === 0) return ts + iv.micros;
  // months/days arithmetic happens in local time
  const off1 = ctx.zoneOffsetAt(ts);
  const local = ts + BigInt(off1) * 1_000_000n;
  const localResult = timestampAddInterval(local, makeInterval(iv.months, iv.days, 0n));
  const off2 = ctx.zoneOffsetForNaive(localResult);
  return localResult - BigInt(off2) * 1_000_000n + iv.micros;
}

function timestampDiff(a: bigint, b: bigint): Interval {
  if (a === TS_POS_INF || a === TS_NEG_INF || b === TS_POS_INF || b === TS_NEG_INF) {
    throw pgError("invalid_datetime", "cannot subtract infinite timestamps", "22008");
  }
  const micros = a - b;
  // PG justifies hours into days
  const days = Number(micros / USECS_PER_DAY);
  let rem = micros % USECS_PER_DAY;
  let d = days;
  if (d > 0 && rem < 0n) {
    d -= 1;
    rem += USECS_PER_DAY;
  } else if (d < 0 && rem > 0n) {
    d += 1;
    rem -= USECS_PER_DAY;
  }
  return makeInterval(0, d, rem);
}

function intervalScale(iv: Interval, factor: number): Interval {
  if (!Number.isFinite(factor)) throw pgError("invalid_parameter_value", "interval out of range", "22015");
  const months = iv.months * factor;
  const wholeMonths = Math.trunc(months);
  const days = iv.days * factor + (months - wholeMonths) * 30;
  const wholeDays = Math.trunc(days);
  const micros = Number(iv.micros) * factor + (days - wholeDays) * 86_400_000_000;
  return makeInterval(wholeMonths, wholeDays, BigInt(Math.round(micros)));
}

function tryMoneyArith(op: string, l: TypedValue, r: TypedValue): TypedValue | null {
  const lt = l.t;
  const rt = r.t;
  if (lt !== "money" && rt !== "money") return null;
  const nullOf = (t: TypeId): TypedValue => tv(t, null);
  if (lt === "money" && rt === "money") {
    if (l.v === null || r.v === null) return nullOf(op === "/" ? "float8" : "money");
    const a = l.v as bigint;
    const b = r.v as bigint;
    switch (op) {
      case "+":
        return tv("money", a + b);
      case "-":
        return tv("money", a - b);
      case "/": {
        if (b === 0n) throw pgError("division_by_zero", "division by zero");
        return tv("float8", Number(a) / Number(b));
      }
      default:
        opNotExist(op, lt, rt);
    }
  }
  const m = lt === "money" ? l : r;
  const n = lt === "money" ? r : l;
  if (!isNumType(n.t)) opNotExist(op, lt, rt);
  if (m.v === null || n.v === null) return nullOf("money");
  const cents = m.v as bigint;
  const f = toF8(n.t, n.v);
  switch (op) {
    case "*":
      return tv("money", BigInt(Math.round(Number(cents) * f)));
    case "/": {
      if (lt !== "money") opNotExist(op, lt, rt);
      if (f === 0) throw pgError("division_by_zero", "division by zero");
      return tv("money", BigInt(Math.trunc(Number(cents) / f)));
    }
    default:
      opNotExist(op, lt, rt);
  }
}

// --- concat ------------------------------------------------------------------

function evalConcat(ctx: EngineCtx, l: TypedValue, r: TypedValue): TypedValue {
  // array || array, array || elem, elem || array
  if (isArrayType(l.t) || isArrayType(r.t)) {
    return arrayConcat(ctx, l, r);
  }
  if (l.t === "jsonb" && r.t === "jsonb") {
    if (l.v === null || r.v === null) return tv("jsonb", null);
    return tv("jsonb", wrapJsonb(jsonbConcat((l.v as JsonbWrap).value, (r.v as JsonbWrap).value)));
  }
  if (l.t === "jsonb" && r.t === "unknown") {
    return evalConcat(ctx, l, castTo(ctx, r, "jsonb"));
  }
  if (r.t === "jsonb" && l.t === "unknown") {
    return evalConcat(ctx, castTo(ctx, l, "jsonb"), r);
  }
  if (l.t === "bytea" && (r.t === "bytea" || r.t === "unknown")) {
    const rb = r.t === "unknown" ? castTo(ctx, r, "bytea") : r;
    if (l.v === null || rb.v === null) return tv("bytea", null);
    const a = l.v as Uint8Array;
    const b = rb.v as Uint8Array;
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return tv("bytea", out);
  }
  if (r.t === "bytea" && l.t === "unknown") {
    return evalConcat(ctx, castTo(ctx, l, "bytea"), r);
  }
  if (l.t === "tsvector" && r.t === "tsvector") {
    if (l.v === null || r.v === null) return tv("tsvector", null);
    return tv("tsvector", tsvectorConcat(l.v as string, r.v as string));
  }
  if (l.t === "tsquery" && r.t === "tsquery") {
    if (l.v === null || r.v === null) return tv("tsquery", null);
    return tv("tsquery", tsqueryCombine("or", l.v as string, r.v as string));
  }
  // text concat: at least one side must be a string type (or unknown)
  const textish = (t: TypeId): boolean => isTextType(t) || t === "unknown";
  if (!textish(l.t) && !textish(r.t)) opNotExist("||", l.t, r.t);
  if (!textish(l.t) && l.t !== "unknown") {
    // anynonarray || text
  }
  if (l.v === null || r.v === null) return tv("text", null);
  // bpchar -> text conversion strips trailing spaces (PG rtrim semantics)
  const sideText = (s: TypedValue): string => {
    if (s.t === "bpchar") return (s.v as string).replace(/ +$/, "");
    return textish(s.t) ? (s.v as string) : datumText(s.t, s.v, ctx);
  };
  return tv("text", sideText(l) + sideText(r));
}

function arrayConcat(ctx: EngineCtx, l: TypedValue, r: TypedValue): TypedValue {
  if (isArrayType(l.t) && isArrayType(r.t)) {
    const elem = unifyTypes(arrayElemType(l.t), arrayElemType(r.t));
    if (elem === null) opNotExist("||", l.t, r.t);
    const t = arrayTypeOf(elem);
    if (l.v === null) return r.v === null ? tv(t, null) : castTo(ctx, r, t);
    if (r.v === null) return castTo(ctx, l, t);
    const la = castTo(ctx, l, t).v as PgArray;
    const ra = castTo(ctx, r, t).v as PgArray;
    if (la.items.length === 0) return tv(t, ra);
    if (ra.items.length === 0) return tv(t, la);
    if (la.dims.length === ra.dims.length) {
      if (la.dims.length > 1) {
        // stack along first dimension
        return tv(t, makeArray(elem, [...la.items, ...ra.items], [la.dims[0]! + ra.dims[0]!, ...la.dims.slice(1)]));
      }
      return tv(t, makeArray(elem, [...la.items, ...ra.items]));
    }
    if (la.dims.length === ra.dims.length + 1) {
      return tv(t, makeArray(elem, [...la.items, ...ra.items], [la.dims[0]! + 1, ...la.dims.slice(1)]));
    }
    if (ra.dims.length === la.dims.length + 1) {
      return tv(t, makeArray(elem, [...la.items, ...ra.items], [ra.dims[0]! + 1, ...ra.dims.slice(1)]));
    }
    opNotExist("||", l.t, r.t);
  }
  // elem || array / array || elem
  if (isArrayType(l.t)) {
    const elem = unifyTypes(arrayElemType(l.t), r.t === "unknown" ? arrayElemType(l.t) : r.t);
    if (elem === null) opNotExist("||", l.t, r.t);
    const t = arrayTypeOf(elem);
    const la = l.v === null ? null : (castTo(ctx, l, t).v as PgArray);
    const rv = castTo(ctx, r, elem).v;
    if (la === null) return tv(t, makeArray(elem, [rv]));
    return tv(t, makeArray(elem, [...la.items, rv]));
  }
  const elem = unifyTypes(arrayElemType(r.t), l.t === "unknown" ? arrayElemType(r.t) : l.t);
  if (elem === null) opNotExist("||", l.t, r.t);
  const t = arrayTypeOf(elem);
  const ra = r.v === null ? null : (castTo(ctx, r, t).v as PgArray);
  const lv = castTo(ctx, l, elem).v;
  if (ra === null) return tv(t, makeArray(elem, [lv]));
  return tv(
    t,
    makeArray(elem, [lv, ...ra.items], ra.dims.length <= 1 ? undefined : [ra.dims[0]! + 1, ...ra.dims.slice(1)]),
  );
}

function jsonbConcat(a: JsonbValue, b: JsonbValue): JsonbValue {
  if (a.j === "obj" && b.j === "obj") {
    const m = new Map(a.v);
    for (const [k, v] of b.v) m.set(k, v);
    return { j: "obj", v: m };
  }
  const arrOf = (x: JsonbValue): JsonbValue[] => (x.j === "arr" ? x.v : [x]);
  return jsonbArr([...arrOf(a), ...arrOf(b)]);
}

// --- bitwise ------------------------------------------------------------------

function evalBitwise(ctx: EngineCtx, op: string, l0: TypedValue, r0: TypedValue): TypedValue {
  const [l, r] = resolveUnknowns(ctx, op, l0, r0);
  // bit-string ops: bit & bit / | / # (xor); shifts take an int rhs
  if ((l.t === "bit" || l.t === "varbit") && (op === "<<" || op === ">>") && isIntType(r.t)) {
    if (l.v === null || r.v === null) return tv(l.t, null);
    const s = l.v as string;
    const n = Number(toI8(r.t, r.v));
    if (n <= 0) return op === "<<" && n < 0 ? evalBitwise(ctx, ">>", l, tv("int4", -n)) : l;
    const shifted =
      op === "<<"
        ? s.slice(Math.min(n, s.length)).padEnd(s.length, "0")
        : s.slice(0, Math.max(0, s.length - n)).padStart(s.length, "0");
    return tv(l.t, shifted);
  }
  if ((l.t === "bit" || l.t === "varbit") && (r.t === "bit" || r.t === "varbit")) {
    if (l.v === null || r.v === null) return tv(l.t, null);
    const a = l.v as string;
    const b = r.v as string;
    if (a.length !== b.length) {
      const word = op === "&" ? "AND" : op === "|" ? "OR" : "XOR";
      throw pgError("data_exception", `cannot ${word} bit strings of different sizes`, "22026");
    }
    let out = "";
    for (let i = 0; i < a.length; i++) {
      const x = a[i] === "1";
      const y = b[i] === "1";
      out += (op === "&" ? x && y : op === "|" ? x || y : x !== y) ? "1" : "0";
    }
    return tv(l.t, out);
  }
  if (!isIntType(l.t) || !isIntType(r.t)) opNotExist(op, l.t, r.t);
  const t = NUM_LADDER[Math.max(NUM_LADDER.indexOf(l.t), NUM_LADDER.indexOf(r.t))]!;
  if (l.v === null || r.v === null) return tv(t, null);
  const a = toI8(l.t, l.v);
  const b = toI8(r.t, r.v);
  const bits = t === "int2" ? 16 : t === "int4" ? 32 : 64;
  let res: bigint;
  switch (op) {
    case "&":
      res = a & b;
      break;
    case "|":
      res = a | b;
      break;
    case "#":
      res = a ^ b;
      break;
    case "<<":
      res = BigInt.asIntN(bits, a << (b & BigInt(bits - 1)));
      break;
    case ">>":
      res = a >> (b & BigInt(bits - 1));
      break;
    default:
      opNotExist(op, l.t, r.t);
  }
  res = BigInt.asIntN(bits, res);
  return tv(t, t === "int8" ? res : Number(res));
}

// --- pattern ops ---------------------------------------------------------------

function evalLikeOp(ctx: EngineCtx, op: string, l0: TypedValue, r0: TypedValue): TypedValue {
  const l = l0.t === "unknown" ? castTo(ctx, l0, "text") : l0;
  const r = r0.t === "unknown" ? castTo(ctx, r0, "text") : r0;
  if (!isTextType(l.t) || !isTextType(r.t)) opNotExist(op, l0.t, r0.t);
  if (l.v === null || r.v === null) return tv("bool", null);
  const ci = op.endsWith("*");
  const negated = op.startsWith("!");
  const m = likeMatch(l.v as string, r.v as string, null, ci);
  return tv("bool", negated ? !m : m);
}

function evalRegexOp(ctx: EngineCtx, op: string, l0: TypedValue, r0: TypedValue): TypedValue {
  const l = l0.t === "unknown" ? castTo(ctx, l0, "text") : l0;
  const r = r0.t === "unknown" ? castTo(ctx, r0, "text") : r0;
  if (!isTextType(l.t) || !isTextType(r.t)) opNotExist(op, l0.t, r0.t);
  if (l.v === null || r.v === null) return tv("bool", null);
  const ci = op.endsWith("*");
  const negated = op.startsWith("!");
  const m = regexMatch(l.v as string, r.v as string, ci);
  return tv("bool", negated ? !m : m);
}

// --- containment ------------------------------------------------------------------

function evalContainment(ctx: EngineCtx, op: string, l0: TypedValue, r0: TypedValue): TypedValue {
  let [l, r] = resolveJsonUnknowns(ctx, op, l0, r0);
  if (op === "&&" && l.t === "tsquery" && r.t === "tsquery") {
    if (l.v === null || r.v === null) return tv("tsquery", null);
    return tv("tsquery", tsqueryCombine("and", l.v as string, r.v as string));
  }
  if (l.t === "jsonb" && r.t === "jsonb") {
    if (l.v === null || r.v === null) return tv("bool", null);
    const a = (l.v as JsonbWrap).value;
    const b = (r.v as JsonbWrap).value;
    if (op === "@>") return tv("bool", jsonbContains(a, b));
    if (op === "<@") return tv("bool", jsonbContains(b, a));
    opNotExist(op, l.t, r.t);
  }
  if (isArrayType(l.t) || isArrayType(r.t)) {
    if (l.t === "unknown") l = castTo(ctx, l, r.t);
    if (r.t === "unknown") r = castTo(ctx, r, l.t);
    if (!isArrayType(l.t) || !isArrayType(r.t)) opNotExist(op, l.t, r.t);
    const elem = unifyTypes(arrayElemType(l.t), arrayElemType(r.t));
    if (elem === null) opNotExist(op, l.t, r.t);
    if (l.v === null || r.v === null) return tv("bool", null);
    const la = castTo(ctx, l, arrayTypeOf(elem)).v as PgArray;
    const ra = castTo(ctx, r, arrayTypeOf(elem)).v as PgArray;
    if (op === "&&") {
      for (const x of la.items) {
        if (x === null) continue;
        for (const y of ra.items) {
          if (y !== null && datumEquals(elem, x, y, ctx)) return tv("bool", true);
        }
      }
      return tv("bool", false);
    }
    const contains = (outer: PgArray, inner: PgArray): boolean => {
      for (const y of inner.items) {
        if (y === null) return false; // NULL elements are never contained
        let found = false;
        for (const x of outer.items) {
          if (x !== null && datumEquals(elem, x, y, ctx)) {
            found = true;
            break;
          }
        }
        if (!found) return false;
      }
      return true;
    };
    if (op === "@>") return tv("bool", contains(la, ra));
    return tv("bool", contains(ra, la));
  }
  opNotExist(op, l.t, r.t);
}

// --- json extraction ------------------------------------------------------------

function evalJsonExtract(_ctx: EngineCtx, op: string, l: TypedValue, r: TypedValue): TypedValue {
  const isJson = l.t === "json";
  const isJsonb = l.t === "jsonb";
  if (!isJson && !isJsonb) opNotExist(op, l.t, r.t);
  const resultType = op.endsWith(">>") ? "text" : l.t;
  if (l.v === null || r.v === null) return tv(resultType, null);

  const value: JsonbValue = isJsonb ? (l.v as JsonbWrap).value : parseJsonbText(l.v as string);

  let result: JsonbValue | null;
  if (op === "->" || op === "->>") {
    if (r.t === "int4" || r.t === "int2") {
      result = jsonGetIndex(value, Number(r.v));
    } else if (r.t === "int8") {
      result = jsonGetIndex(value, Number(r.v as bigint));
    } else if (isTextType(r.t)) {
      result = jsonGetKey(value, r.v as string);
    } else {
      opNotExist(op, l.t, r.t);
    }
  } else {
    // #> / #>>
    if (!isArrayType(r.t)) opNotExist(op, l.t, r.t);
    const path = (r.v as PgArray).items;
    result = value;
    for (const p of path) {
      if (result === null) break;
      if (p === null) {
        result = null;
        break;
      }
      const key = String(p);
      if (result.j === "arr" && /^-?\d+$/.test(key)) {
        result = jsonGetIndex(result, Number(key));
      } else {
        result = jsonGetKey(result, key);
      }
    }
  }

  if (result === null) return tv(resultType, null);
  if (op.endsWith(">>")) {
    if (result.j === "null") return tv("text", null);
    if (result.j === "str") return tv("text", result.v);
    return tv("text", jsonbText(result));
  }
  if (isJsonb) return tv("jsonb", wrapJsonb(result));
  return tv("json", jsonbText(result));
}

function jsonGetIndex(v: JsonbValue, idx: number): JsonbValue | null {
  if (v.j !== "arr") return null;
  const i = idx < 0 ? v.v.length + idx : idx;
  return v.v[i] ?? null;
}

function jsonGetKey(v: JsonbValue, key: string): JsonbValue | null {
  if (v.j !== "obj") return null;
  return v.v.get(key) ?? null;
}

function evalJsonbExists(_ctx: EngineCtx, op: string, l: TypedValue, r: TypedValue): TypedValue {
  if (l.t !== "jsonb") opNotExist(op, l.t, r.t);
  if (l.v === null || r.v === null) return tv("bool", null);
  const value = (l.v as JsonbWrap).value;
  const has = (key: string): boolean => {
    if (value.j === "obj") return value.v.has(key);
    if (value.j === "arr") return value.v.some((x) => x.j === "str" && x.v === key);
    if (value.j === "str") return value.v === key;
    return false;
  };
  if (op === "?") {
    return tv("bool", has(r.v as string));
  }
  const keys = (r.v as PgArray).items.filter((k): k is string => k !== null).map(String);
  if (op === "?|") return tv("bool", keys.some(has));
  return tv("bool", keys.every(has));
}

/** jsonb - text / jsonb - int / jsonb - text[] */
export function evalJsonbDelete(_ctx: EngineCtx, l: TypedValue, r: TypedValue): TypedValue {
  if (l.v === null || r.v === null) return tv("jsonb", null);
  const value = (l.v as JsonbWrap).value;
  if (isTextType(r.t) || r.t === "unknown") {
    const key = r.v as string;
    if (value.j === "obj") {
      const m = new Map(value.v);
      m.delete(key);
      return tv("jsonb", wrapJsonb({ j: "obj", v: m }));
    }
    if (value.j === "arr") {
      return tv("jsonb", wrapJsonb(jsonbArr(value.v.filter((x) => !(x.j === "str" && x.v === key)))));
    }
    throw pgError("invalid_parameter_value", "cannot delete from scalar", "22023");
  }
  if (r.t === "int4" || r.t === "int2" || r.t === "int8") {
    if (value.j !== "arr") {
      if (value.j === "obj")
        throw pgError("invalid_parameter_value", "cannot delete from object using integer index", "22023");
      throw pgError("invalid_parameter_value", "cannot delete from scalar", "22023");
    }
    let idx = Number(r.v);
    if (idx < 0) idx = value.v.length + idx;
    return tv("jsonb", wrapJsonb(jsonbArr(value.v.filter((_, i) => i !== idx))));
  }
  if (isArrayType(r.t)) {
    const keys = new Set((r.v as PgArray).items.filter((k) => k !== null).map(String));
    if (value.j === "obj") {
      const m = new Map(value.v);
      for (const k of keys) m.delete(k);
      return tv("jsonb", wrapJsonb({ j: "obj", v: m }));
    }
    if (value.j === "arr") {
      return tv("jsonb", wrapJsonb(jsonbArr(value.v.filter((x) => !(x.j === "str" && keys.has(x.v))))));
    }
    throw pgError("invalid_parameter_value", "cannot delete from scalar", "22023");
  }
  opNotExist("-", l.t, r.t);
}

function evalJsonbDeletePath(ctx: EngineCtx, l: TypedValue, r0: TypedValue): TypedValue {
  const r = r0.t === "unknown" ? castTo(ctx, r0, "text[]") : r0;
  if (l.t !== "jsonb" || !isArrayType(r.t)) opNotExist("#-", l.t, r0.t);
  if (l.v === null || r.v === null) return tv("jsonb", null);
  const path = (r.v as PgArray).items.map((x) => (x === null ? null : String(x)));
  if (path.some((p) => p === null)) {
    throw pgError("invalid_parameter_value", "path element cannot be null", "22004" as any);
  }
  const del = (v: JsonbValue, depth: number): JsonbValue => {
    const key = path[depth] as string;
    if (v.j === "obj") {
      if (!v.v.has(key)) return v;
      const m = new Map(v.v);
      if (depth === path.length - 1) {
        m.delete(key);
      } else {
        m.set(key, del(m.get(key)!, depth + 1));
      }
      return { j: "obj", v: m };
    }
    if (v.j === "arr") {
      if (!/^-?\d+$/.test(key)) {
        return v;
      }
      let idx = Number(key);
      if (idx < 0) idx = v.v.length + idx;
      if (idx < 0 || idx >= v.v.length) return v;
      if (depth === path.length - 1) {
        return jsonbArr(v.v.filter((_, i) => i !== idx));
      }
      const copy = v.v.slice();
      copy[idx] = del(copy[idx]!, depth + 1);
      return jsonbArr(copy);
    }
    if (depth === 0) {
      throw pgError("invalid_parameter_value", "cannot delete path in scalar", "22023");
    }
    return v;
  };
  if (path.length === 0) return tv("jsonb", l.v);
  return tv("jsonb", wrapJsonb(del((l.v as JsonbWrap).value, 0)));
}

// --- text search (minimal tsvector/tsquery) ---------------------------------------

function evalTextSearchMatch(ctx: EngineCtx, l0: TypedValue, r0: TypedValue): TypedValue {
  let l = l0;
  let r = r0;
  if (l.t === "unknown") l = castTo(ctx, l, "tsvector");
  if (r.t === "unknown") r = castTo(ctx, r, "tsquery");
  if (l.t === "tsquery" && r.t === "tsvector") [l, r] = [r, l];
  if (l.t !== "tsvector" || r.t !== "tsquery") opNotExist("@@", l0.t, r0.t);
  if (l.v === null || r.v === null) return tv("bool", null);
  return tv("bool", tsvectorMatches(l.v as string, r.v as string));
}

// --- unary --------------------------------------------------------------------------

export function evalUnary(ctx: EngineCtx, op: string, operand: TypedValue): TypedValue {
  const { t, v } = operand;
  switch (op) {
    case "-": {
      if (t === "unknown") throw pgError("ambiguous_function", "operator is not unique: - unknown");
      if (t === "int2" || t === "int4") {
        if (v === null) return tv(t, null);
        const neg = -(v as number);
        return tv(t, t === "int2" ? checkInt2(neg) : checkInt4(neg));
      }
      if (t === "int8") {
        if (v === null) return tv(t, null);
        return tv(t, checkInt8(-(v as bigint)));
      }
      if (t === "float4" || t === "float8") {
        if (v === null) return tv(t, null);
        return tv(t, -(v as number));
      }
      if (t === "numeric") {
        if (v === null) return tv(t, null);
        return tv(t, numericNeg(v as Numeric));
      }
      if (t === "interval") {
        if (v === null) return tv(t, null);
        return tv(t, intervalNeg(v as Interval));
      }
      if (t === "money") {
        if (v === null) return tv(t, null);
        return tv(t, -(v as bigint));
      }
      throw pgError("undefined_function", `operator does not exist: - ${typeDisplayName(t)}`);
    }
    case "+": {
      // all unary + candidates are numeric, so the preferred type float8 wins
      if (t === "unknown") return evalUnary(ctx, op, castTo(ctx, operand, "float8"));
      if (!isNumType(t) && t !== "interval" && t !== "money") {
        throw pgError("undefined_function", `operator does not exist: + ${typeDisplayName(t)}`);
      }
      return operand;
    }
    case "~": {
      if (t === "unknown") throw pgError("ambiguous_function", "operator is not unique: ~ unknown");
      if (!isIntType(t)) throw pgError("undefined_function", `operator does not exist: ~ ${typeDisplayName(t)}`);
      if (v === null) return tv(t, null);
      const bits = t === "int2" ? 16 : t === "int4" ? 32 : 64;
      const res = BigInt.asIntN(bits, ~toI8(t, v));
      return tv(t, t === "int8" ? res : Number(res));
    }
    case "@": {
      if (t === "unknown") return evalUnary(ctx, op, castTo(ctx, operand, "float8"));
      if (v === null) return tv(t, null);
      if (t === "numeric") return tv(t, numericAbs(v as Numeric));
      if (t === "int8") return tv(t, (v as bigint) < 0n ? checkInt8(-(v as bigint)) : v);
      if (isIntType(t)) return tv(t, Math.abs(v as number));
      if (t === "float4" || t === "float8") return tv(t, Math.abs(v as number));
      throw pgError("undefined_function", `operator does not exist: @ ${typeDisplayName(t)}`);
    }
    case "|/": {
      const f = castTo(ctx, operand, "float8");
      if (f.v === null) return tv("float8", null);
      const x = f.v as number;
      if (x < 0) throw pgError("invalid_parameter_value", "cannot take square root of a negative number");
      return tv("float8", Math.sqrt(x));
    }
    case "||/": {
      const f = castTo(ctx, operand, "float8");
      if (f.v === null) return tv("float8", null);
      return tv("float8", Math.cbrt(f.v as number));
    }
    case "not": {
      if (t !== "bool" && t !== "unknown") {
        throw pgError("datatype_mismatch", `argument of NOT must be type boolean, not type ${typeDisplayName(t)}`);
      }
      const b = t === "bool" ? operand : castTo(ctx, operand, "bool");
      if (b.v === null) return tv("bool", null);
      return tv("bool", !(b.v as boolean));
    }
    case "!!": {
      const q = t === "tsquery" ? operand : castTo(ctx, operand, "tsquery");
      if (q.v === null) return tv("tsquery", null);
      return tv("tsquery", tsqueryNegate(q.v as string));
    }
    default:
      throw pgError("undefined_function", `operator does not exist: ${op} ${typeDisplayName(t)}`);
  }
}

export { float8Text, isNumeric, makeNumeric, numericSqrt, parseNumeric };
