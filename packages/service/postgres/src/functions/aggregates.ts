import { pgError } from "../errors/error.ts";
import type { EngineCtx } from "../expressions/context.ts";
import { castTo, unifyTypes } from "../types/cast.ts";
import { datumCompare } from "../types/compare.ts";
import { JSONB_NULL, type JsonbValue, jsonbArr, jsonbCompactText, jsonbObj } from "../types/jsonb.ts";
import {
  makeNumeric,
  type Numeric,
  numericAdd,
  numericCmp,
  numericDivScaled,
  numericFromBigInt,
  numericMul,
  numericSqrt,
  numericSub,
  selectDivScale,
} from "../types/numeric.ts";
import {
  arrayTypeOf,
  type Datum,
  makeArray,
  type TypedValue,
  type TypeId,
  tv,
  UNKNOWN,
  wrapJsonb,
} from "../types/value.ts";
import { datumToJsonb } from "./json-fns.ts";
import { numericAsNumber } from "./util.ts";

/** Incremental accumulator; the executor feeds rows and reads the result. */
export interface AggregateAcc {
  step(args: TypedValue[]): void;
  result(): TypedValue;
}

export type AggregateFactory = (ctx: EngineCtx, argTypes: TypeId[]) => AggregateAcc;

const INT_TYPES = new Set(["int2", "int4", "int8"]);

function sumResultType(argT: TypeId): TypeId {
  if (argT === "int8" || argT === "numeric") return "numeric";
  if (argT === "int2" || argT === "int4") return "int8";
  if (argT === "float4") return "float4";
  if (argT === "float8") return "float8";
  if (argT === "interval") return "interval";
  if (argT === "money") return "money";
  return "numeric";
}

function avgResultType(argT: TypeId): TypeId {
  if (INT_TYPES.has(argT) || argT === "numeric") return "numeric";
  if (argT === "interval") return "interval";
  return "float8";
}

class CountAcc implements AggregateAcc {
  private n = 0n;
  step(args: TypedValue[]): void {
    if (args.length === 0 || args[0]!.v !== null) this.n++;
  }
  result(): TypedValue {
    return tv("int8", this.n);
  }
}

class SumAcc implements AggregateAcc {
  private readonly resultT: TypeId;
  private numericSum: Numeric | null = null;
  private floatSum: number | null = null;
  private intervalSum: { months: number; days: number; micros: bigint } | null = null;
  constructor(
    private readonly ctx: EngineCtx,
    argT: TypeId,
  ) {
    this.resultT = sumResultType(argT === UNKNOWN ? "numeric" : argT);
  }
  step(args: TypedValue[]): void {
    const a = args[0]!;
    if (a.v === null) return;
    if (this.resultT === "interval") {
      const iv = a.v as { months: number; days: number; micros: bigint };
      if (!this.intervalSum) this.intervalSum = { months: 0, days: 0, micros: 0n };
      this.intervalSum.months += iv.months;
      this.intervalSum.days += iv.days;
      this.intervalSum.micros += iv.micros;
      return;
    }
    if (this.resultT === "float4" || this.resultT === "float8") {
      this.floatSum = (this.floatSum ?? 0) + (a.v as number);
      return;
    }
    const n = castTo(this.ctx, a, "numeric", { explicit: true }).v as Numeric;
    this.numericSum = this.numericSum === null ? n : numericAdd(this.numericSum, n);
  }
  result(): TypedValue {
    if (this.resultT === "interval") {
      if (!this.intervalSum) return tv("interval", null);
      return tv("interval", { kind: "interval", ...this.intervalSum } as never);
    }
    if (this.resultT === "float4" || this.resultT === "float8") {
      return tv(this.resultT, this.floatSum);
    }
    if (this.numericSum === null) return tv(this.resultT, null);
    if (this.resultT === "int8") {
      return castTo(this.ctx, tv("numeric", this.numericSum), "int8", { explicit: true });
    }
    return tv("numeric", this.numericSum);
  }
}

class AvgAcc implements AggregateAcc {
  private n = 0n;
  private numericSum: Numeric = makeNumeric(0n, 0);
  private floatSum = 0;
  private intervalSum = { months: 0, days: 0, micros: 0n };
  private readonly resultT: TypeId;
  constructor(
    private readonly ctx: EngineCtx,
    readonly argT: TypeId,
  ) {
    this.resultT = avgResultType(argT === UNKNOWN ? "numeric" : argT);
  }
  step(args: TypedValue[]): void {
    const a = args[0]!;
    if (a.v === null) return;
    this.n++;
    if (this.resultT === "float8") {
      this.floatSum += castTo(this.ctx, a, "float8", { explicit: true }).v as number;
    } else if (this.resultT === "interval") {
      const iv = a.v as { months: number; days: number; micros: bigint };
      this.intervalSum.months += iv.months;
      this.intervalSum.days += iv.days;
      this.intervalSum.micros += iv.micros;
    } else {
      this.numericSum = numericAdd(this.numericSum, castTo(this.ctx, a, "numeric", { explicit: true }).v as Numeric);
    }
  }
  result(): TypedValue {
    if (this.n === 0n) return tv(this.resultT, null);
    if (this.resultT === "float8") return tv("float8", this.floatSum / Number(this.n));
    if (this.resultT === "interval") {
      const totalMicros =
        (BigInt(this.intervalSum.months) * 2_629_800_000_000n +
          BigInt(this.intervalSum.days) * 86_400_000_000n +
          this.intervalSum.micros) /
        this.n;
      return tv("interval", { kind: "interval", months: 0, days: 0, micros: totalMicros } as never);
    }
    // numeric avg divides sum/count with the standard division scale rule
    const divisor = numericFromBigInt(this.n);
    return tv("numeric", numericDivScaled(this.numericSum, divisor, selectDivScale(this.numericSum, divisor)));
  }
}

class MinMaxAcc implements AggregateAcc {
  private best: TypedValue | null = null;
  constructor(
    private readonly ctx: EngineCtx,
    private readonly isMax: boolean,
    private argT: TypeId,
  ) {}
  step(args: TypedValue[]): void {
    const a = args[0]!;
    if (a.v === null) return;
    if (this.argT === UNKNOWN && a.t !== UNKNOWN) this.argT = a.t;
    const t = this.argT === UNKNOWN ? "text" : this.argT;
    const v = castTo(this.ctx, a, t, {});
    if (this.best === null) {
      this.best = v;
      return;
    }
    const c = datumCompare(t, v.v, this.best.v, this.ctx);
    if (this.isMax ? c > 0 : c < 0) this.best = v;
  }
  result(): TypedValue {
    const t = this.argT === UNKNOWN ? "text" : this.argT;
    return this.best ?? tv(t, null);
  }
}

class BoolAndOrAcc implements AggregateAcc {
  private acc: boolean | null = null;
  constructor(private readonly isAnd: boolean) {}
  step(args: TypedValue[]): void {
    const v = args[0]!.v;
    if (v === null) return;
    const b = v as boolean;
    if (this.acc === null) this.acc = b;
    else this.acc = this.isAnd ? this.acc && b : this.acc || b;
  }
  result(): TypedValue {
    return tv("bool", this.acc);
  }
}

class StringAggAcc implements AggregateAcc {
  private parts: string[] | null = null;
  private lastSep = "";
  private readonly isBytea: boolean;
  private byteaParts: Uint8Array[] | null = null;
  constructor(
    private readonly ctx: EngineCtx,
    argT: TypeId,
  ) {
    this.isBytea = argT === "bytea";
  }
  step(args: TypedValue[]): void {
    const a = args[0]!;
    if (a.v === null) return;
    const sep =
      args[1] === undefined || args[1].v === null
        ? ""
        : this.isBytea
          ? ""
          : (castTo(this.ctx, args[1], "text", { explicit: true }).v as string);
    if (this.isBytea) {
      if (!this.byteaParts) this.byteaParts = [];
      else if (args[1] !== undefined && args[1].v !== null) this.byteaParts.push(args[1].v as Uint8Array);
      this.byteaParts.push(a.v as Uint8Array);
      return;
    }
    const text = castTo(this.ctx, a, "text", { explicit: true }).v as string;
    if (this.parts === null) this.parts = [text];
    else {
      this.parts.push(sep);
      this.parts.push(text);
    }
    this.lastSep = sep;
    void this.lastSep;
  }
  result(): TypedValue {
    if (this.isBytea) {
      if (!this.byteaParts) return tv("bytea", null);
      const total = this.byteaParts.reduce((acc, p) => acc + p.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const p of this.byteaParts) {
        out.set(p, off);
        off += p.length;
      }
      return tv("bytea", out);
    }
    return tv("text", this.parts === null ? null : this.parts.join(""));
  }
}

class ArrayAggAcc implements AggregateAcc {
  private items: Datum[] = [];
  private any = false;
  constructor(
    private readonly ctx: EngineCtx,
    private argT: TypeId,
  ) {}
  step(args: TypedValue[]): void {
    const a = args[0]!;
    this.any = true;
    if (this.argT === UNKNOWN && a.t !== UNKNOWN) this.argT = a.t;
    const t = this.argT === UNKNOWN ? "text" : this.argT;
    this.items.push(a.v === null ? null : castTo(this.ctx, a, t, {}).v);
  }
  result(): TypedValue {
    const t = this.argT === UNKNOWN ? "text" : this.argT;
    if (!this.any) return tv(arrayTypeOf(t), null);
    return tv(arrayTypeOf(t), makeArray(t, this.items));
  }
}

class JsonAggAcc implements AggregateAcc {
  private items: JsonbValue[] = [];
  private any = false;
  constructor(
    private readonly ctx: EngineCtx,
    private readonly jsonb: boolean,
  ) {}
  step(args: TypedValue[]): void {
    const a = args[0]!;
    this.any = true;
    this.items.push(a.v === null ? JSONB_NULL : datumToJsonb(this.ctx, a.t, a.v));
  }
  result(): TypedValue {
    if (!this.any) return tv(this.jsonb ? "jsonb" : "json", null);
    const arr = jsonbArr(this.items);
    if (this.jsonb) return tv("jsonb", wrapJsonb(arr));
    // json_agg joins compact element renderings with ", "
    return tv("json", `[${this.items.map(jsonbCompactText).join(", ")}]`);
  }
}

class JsonObjectAggAcc implements AggregateAcc {
  private entries: Array<[string, JsonbValue]> = [];
  private any = false;
  constructor(
    private readonly ctx: EngineCtx,
    private readonly jsonb: boolean,
  ) {}
  step(args: TypedValue[]): void {
    const k = args[0]!;
    const v = args[1]!;
    this.any = true;
    if (k.v === null) {
      throw pgError("null_value_not_allowed", "field name must not be null", "22004");
    }
    const key = castTo(this.ctx, k, "text", { explicit: true }).v as string;
    this.entries.push([key, v.v === null ? JSONB_NULL : datumToJsonb(this.ctx, v.t, v.v)]);
  }
  result(): TypedValue {
    if (!this.any) return tv(this.jsonb ? "jsonb" : "json", null);
    if (this.jsonb) return tv("jsonb", wrapJsonb(jsonbObj(this.entries)));
    // json_object_agg spacing: `{ "a" : 1, "b" : 2 }`, insertion order (duplicates collapse — divergence)
    const obj = jsonbObj(this.entries);
    const entries = obj.j === "obj" ? [...obj.v.entries()] : [];
    const body = entries.map(([k, x]) => `${JSON.stringify(k)} : ${jsonbCompactText(x)}`).join(", ");
    return tv("json", `{ ${body} }`);
  }
}

class BitwiseAcc implements AggregateAcc {
  private acc: bigint | null = null;
  private resultT: TypeId = "int8";
  constructor(
    private readonly op: "and" | "or" | "xor",
    readonly argT: TypeId,
  ) {
    this.resultT = argT === UNKNOWN ? "int8" : argT;
  }
  step(args: TypedValue[]): void {
    const a = args[0]!;
    if (a.v === null) return;
    const v = typeof a.v === "bigint" ? a.v : BigInt(a.v as number);
    if (this.acc === null) {
      this.acc = v;
      return;
    }
    this.acc = this.op === "and" ? this.acc & v : this.op === "or" ? this.acc | v : this.acc ^ v;
  }
  result(): TypedValue {
    if (this.acc === null) return tv(this.resultT, null);
    if (this.resultT === "int8") return tv("int8", BigInt.asIntN(64, this.acc));
    return tv(this.resultT, Number(BigInt.asIntN(32, this.acc)));
  }
}

/** Welford-style accumulation over float8; numeric args use exact sums. */
class StatAcc implements AggregateAcc {
  private n = 0n;
  private sum: Numeric = makeNumeric(0n, 0);
  private sumSq: Numeric = makeNumeric(0n, 0);
  private useFloat: boolean;
  private fN = 0;
  private fSum = 0;
  private fSumSq = 0;
  constructor(
    private readonly ctx: EngineCtx,
    argT: TypeId,
    private readonly kind: "var_samp" | "var_pop" | "stddev_samp" | "stddev_pop",
  ) {
    this.useFloat = argT === "float4" || argT === "float8";
  }
  step(args: TypedValue[]): void {
    const a = args[0]!;
    if (a.v === null) return;
    if (this.useFloat) {
      const f = a.v as number;
      this.fN++;
      this.fSum += f;
      this.fSumSq += f * f;
      return;
    }
    const x = castTo(this.ctx, a, "numeric", { explicit: true }).v as Numeric;
    this.n++;
    this.sum = numericAdd(this.sum, x);
    this.sumSq = numericAdd(this.sumSq, numericMul(x, x));
  }
  result(): TypedValue {
    const resultT = this.useFloat ? "float8" : "numeric";
    const n = this.useFloat ? this.fN : Number(this.n);
    const isSamp = this.kind === "var_samp" || this.kind === "stddev_samp";
    if (n === 0 || (isSamp && n === 1)) return tv(resultT, null);
    if (this.useFloat) {
      const meanSq = (this.fSum * this.fSum) / this.fN;
      const ss = this.fSumSq - meanSq;
      const variance = ss / (isSamp ? this.fN - 1 : this.fN);
      const out = this.kind.startsWith("stddev") ? Math.sqrt(Math.max(variance, 0)) : Math.max(variance, 0);
      return tv("float8", out);
    }
    // numeric: variance = (n*sumSq - sum^2) / (n * (n or n-1))
    const nBig = numericFromBigInt(this.n);
    const numerator = numericSub(numericMul(nBig, this.sumSq), numericMul(this.sum, this.sum));
    const denomFactor = isSamp ? this.n - 1n : this.n;
    const denominator = numericMul(nBig, numericFromBigInt(denomFactor));
    const scale = Math.max(this.sum.dscale * 2 + 6, 16);
    let variance = numericDivScaled(numerator, denominator, scale);
    if (numericCmp(variance, makeNumeric(0n, 0)) < 0) variance = makeNumeric(0n, variance.dscale);
    if (this.kind.startsWith("stddev")) {
      return tv("numeric", numericSqrt(variance));
    }
    return tv("numeric", variance);
  }
}

/** ordered-set aggregate: percentile_cont / percentile_disc / mode */
class PercentileAcc implements AggregateAcc {
  private values: TypedValue[] = [];
  private fraction: number | null = null;
  constructor(
    private readonly ctx: EngineCtx,
    private readonly kind: "cont" | "disc" | "mode",
    private argT: TypeId,
  ) {}
  step(args: TypedValue[]): void {
    // args[0] = direct arg (fraction), args[1] = within-group value
    if (this.kind !== "mode") {
      if (args[0]!.v !== null)
        this.fraction = numericAsNumber(castTo(this.ctx, args[0]!, "float8", { explicit: true }).v);
      const v = args[1]!;
      if (v.v === null) return;
      if (this.argT === UNKNOWN && v.t !== UNKNOWN) this.argT = v.t;
      this.values.push(v);
      return;
    }
    const v = args[0]!;
    if (v.v === null) return;
    if (this.argT === UNKNOWN && v.t !== UNKNOWN) this.argT = v.t;
    this.values.push(v);
  }
  result(): TypedValue {
    const t = this.argT === UNKNOWN ? "float8" : this.argT;
    if (this.values.length === 0 || (this.kind !== "mode" && this.fraction === null)) return tv(t, null);
    const sorted = [...this.values].sort((a, b) => datumCompare(t, a.v, b.v, this.ctx));
    if (this.kind === "mode") {
      let best = sorted[0]!;
      let bestCount = 1;
      let i = 0;
      while (i < sorted.length) {
        let j = i + 1;
        while (j < sorted.length && datumCompare(t, sorted[j]!.v, sorted[i]!.v, this.ctx) === 0) j++;
        if (j - i > bestCount) {
          best = sorted[i]!;
          bestCount = j - i;
        }
        i = j;
      }
      return best;
    }
    const frac = this.fraction!;
    if (frac < 0 || frac > 1 || Number.isNaN(frac)) {
      throw pgError("invalid_parameter_value", "percentile value must be between 0 and 1", "22023");
    }
    if (this.kind === "disc") {
      const idx = Math.max(Math.ceil(frac * sorted.length) - 1, 0);
      return sorted[idx]!;
    }
    // continuous
    const pos = frac * (sorted.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    const loV = castTo(this.ctx, sorted[lo]!, "float8", { explicit: true }).v as number;
    if (lo === hi) {
      if (t === "interval" || INT_TYPES.has(t) || t === "numeric") return tv("float8", loV);
      return tv("float8", loV);
    }
    const hiV = castTo(this.ctx, sorted[hi]!, "float8", { explicit: true }).v as number;
    return tv("float8", loV + (hiV - loV) * (pos - lo));
  }
}

class CorrAcc implements AggregateAcc {
  n = 0;
  sumX = 0;
  sumY = 0;
  sumXY = 0;
  sumX2 = 0;
  sumY2 = 0;
  constructor(private readonly kind: string) {}
  step(args: TypedValue[]): void {
    const yArg = args[0]!;
    const xArg = args[1]!;
    if (yArg.v === null || xArg.v === null) return;
    const y = numericAsNumber(yArg.v);
    const x = numericAsNumber(xArg.v);
    this.n++;
    this.sumX += x;
    this.sumY += y;
    this.sumXY += x * y;
    this.sumX2 += x * x;
    this.sumY2 += y * y;
  }
  result(): TypedValue {
    const { n, sumX, sumY, sumXY, sumX2, sumY2 } = this;
    if (n === 0) return this.kind === "regr_count" ? tv("int8", 0n) : tv("float8", null);
    const sxx = sumX2 - (sumX * sumX) / n;
    const syy = sumY2 - (sumY * sumY) / n;
    const sxy = sumXY - (sumX * sumY) / n;
    switch (this.kind) {
      case "corr": {
        if (n < 2 || sxx === 0 || syy === 0) return tv("float8", null);
        return tv("float8", sxy / Math.sqrt(sxx * syy));
      }
      case "covar_pop":
        return tv("float8", sxy / n);
      case "covar_samp":
        return n < 2 ? tv("float8", null) : tv("float8", sxy / (n - 1));
      case "regr_slope":
        return sxx === 0 ? tv("float8", null) : tv("float8", sxy / sxx);
      case "regr_intercept":
        return sxx === 0 ? tv("float8", null) : tv("float8", sumY / n - (sxy / sxx) * (sumX / n));
      case "regr_r2": {
        if (sxx === 0) return tv("float8", null);
        if (syy === 0) return tv("float8", 1);
        return tv("float8", (sxy * sxy) / (sxx * syy));
      }
      case "regr_count":
        return tv("int8", BigInt(n));
      case "regr_avgx":
        return tv("float8", sumX / n);
      case "regr_avgy":
        return tv("float8", sumY / n);
      case "regr_sxx":
        return tv("float8", sxx);
      case "regr_syy":
        return tv("float8", syy);
      case "regr_sxy":
        return tv("float8", sxy);
      default:
        return tv("float8", null);
    }
  }
}

const FACTORIES = new Map<string, AggregateFactory>([
  ["count", (_ctx, _t) => new CountAcc()],
  ["sum", (ctx, t) => new SumAcc(ctx, t[0] ?? "numeric")],
  ["avg", (ctx, t) => new AvgAcc(ctx, t[0] ?? "numeric")],
  ["min", (ctx, t) => new MinMaxAcc(ctx, false, t[0] ?? UNKNOWN)],
  ["max", (ctx, t) => new MinMaxAcc(ctx, true, t[0] ?? UNKNOWN)],
  ["bool_and", () => new BoolAndOrAcc(true)],
  ["bool_or", () => new BoolAndOrAcc(false)],
  ["every", () => new BoolAndOrAcc(true)],
  ["string_agg", (ctx, t) => new StringAggAcc(ctx, t[0] ?? "text")],
  ["array_agg", (ctx, t) => new ArrayAggAcc(ctx, t[0] ?? UNKNOWN)],
  ["json_agg", (ctx) => new JsonAggAcc(ctx, false)],
  ["jsonb_agg", (ctx) => new JsonAggAcc(ctx, true)],
  ["json_object_agg", (ctx) => new JsonObjectAggAcc(ctx, false)],
  ["jsonb_object_agg", (ctx) => new JsonObjectAggAcc(ctx, true)],
  ["bit_and", (_ctx, t) => new BitwiseAcc("and", t[0] ?? "int8")],
  ["bit_or", (_ctx, t) => new BitwiseAcc("or", t[0] ?? "int8")],
  ["bit_xor", (_ctx, t) => new BitwiseAcc("xor", t[0] ?? "int8")],
  ["variance", (ctx, t) => new StatAcc(ctx, t[0] ?? "numeric", "var_samp")],
  ["var_samp", (ctx, t) => new StatAcc(ctx, t[0] ?? "numeric", "var_samp")],
  ["var_pop", (ctx, t) => new StatAcc(ctx, t[0] ?? "numeric", "var_pop")],
  ["stddev", (ctx, t) => new StatAcc(ctx, t[0] ?? "numeric", "stddev_samp")],
  ["stddev_samp", (ctx, t) => new StatAcc(ctx, t[0] ?? "numeric", "stddev_samp")],
  ["stddev_pop", (ctx, t) => new StatAcc(ctx, t[0] ?? "numeric", "stddev_pop")],
  ["percentile_cont", (ctx, t) => new PercentileAcc(ctx, "cont", t[1] ?? UNKNOWN)],
  ["percentile_disc", (ctx, t) => new PercentileAcc(ctx, "disc", t[1] ?? UNKNOWN)],
  ["mode", (ctx, t) => new PercentileAcc(ctx, "mode", t[0] ?? UNKNOWN)],
  ["corr", () => new CorrAcc("corr")],
  ["covar_pop", () => new CorrAcc("covar_pop")],
  ["covar_samp", () => new CorrAcc("covar_samp")],
  ["regr_slope", () => new CorrAcc("regr_slope")],
  ["regr_intercept", () => new CorrAcc("regr_intercept")],
  ["regr_r2", () => new CorrAcc("regr_r2")],
  ["regr_count", () => new CorrAcc("regr_count")],
  ["regr_avgx", () => new CorrAcc("regr_avgx")],
  ["regr_avgy", () => new CorrAcc("regr_avgy")],
  ["regr_sxx", () => new CorrAcc("regr_sxx")],
  ["regr_syy", () => new CorrAcc("regr_syy")],
  ["regr_sxy", () => new CorrAcc("regr_sxy")],
]);

export function getAggregateFactories(): Map<string, AggregateFactory> {
  return FACTORIES;
}

export function isAggregateName(name: string): boolean {
  return FACTORIES.has(name);
}

export function createAggregate(ctx: EngineCtx, name: string, argTypes: TypeId[]): AggregateAcc {
  const f = FACTORIES.get(name);
  if (!f) throw pgError("undefined_function", `aggregate ${name} does not exist`, "42883");
  return f(ctx, argTypes);
}

/** true for aggregates whose arguments come from WITHIN GROUP (ORDER BY ...) */
export function isOrderedSetAggregate(name: string): boolean {
  return name === "percentile_cont" || name === "percentile_disc" || name === "mode";
}

/** unify agg arg type across rows (executor helper) */
export function unifyAggType(a: TypeId, b: TypeId): TypeId {
  if (a === UNKNOWN) return b;
  if (b === UNKNOWN) return a;
  return unifyTypes(a, b) ?? a;
}

/** result type helpers used by planner-ish code paths */
export function aggregateResultHint(name: string, argT: TypeId): TypeId {
  switch (name) {
    case "count":
    case "regr_count":
      return "int8";
    case "sum":
      return sumResultType(argT);
    case "avg":
      return avgResultType(argT);
    case "array_agg":
      return arrayTypeOf(argT === UNKNOWN ? "text" : argT);
    case "string_agg":
      return argT === "bytea" ? "bytea" : "text";
    case "json_agg":
    case "json_object_agg":
      return "json";
    case "jsonb_agg":
    case "jsonb_object_agg":
      return "jsonb";
    case "bool_and":
    case "bool_or":
    case "every":
      return "bool";
    default:
      return argT;
  }
}
