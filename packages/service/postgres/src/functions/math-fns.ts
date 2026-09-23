import { pgError } from "../errors/error.ts";
import { castTo, isNumericType } from "../types/cast.ts";
import {
  isNumeric,
  makeNumeric,
  type Numeric,
  numericAbs,
  numericCeil,
  numericCmp,
  numericDivScaled,
  numericDivTrunc,
  numericExp,
  numericFloor,
  numericFromBigInt,
  numericLn,
  numericLog10,
  numericLogBase,
  numericMod,
  numericMul,
  numericPower,
  numericRound,
  numericSign,
  numericSqrt,
  numericStripTrailingZeros,
  numericSub,
  numericToBigInt,
  numericTrunc,
} from "../types/numeric.ts";
import { checkInt2, checkInt4, checkInt8, type TypedValue, tv } from "../types/value.ts";
import { argFloat, argInt, argNumeric, type ScalarFn, strict } from "./util.ts";

function isFloatArg(v: TypedValue): boolean {
  return v.t === "float4" || v.t === "float8";
}

function isIntType(t: string): boolean {
  return t === "int2" || t === "int4" || t === "int8";
}

function checkFloat(v: number, _op: string): number {
  if (Number.isNaN(v)) return v;
  if (!Number.isFinite(v)) return v;
  return v;
}

function floatErr(v: number, allowInf: boolean): number {
  if (!allowInf && !Number.isFinite(v) && !Number.isNaN(v)) {
    throw pgError("numeric_value_out_of_range", "value out of range: overflow");
  }
  return v;
}

export function getMathFunctions(): Map<string, ScalarFn> {
  const m = new Map<string, ScalarFn>();

  m.set(
    "abs",
    strict("numeric", (ctx, args) => {
      const a = args[0]!;
      switch (a.t) {
        case "int2":
          return tv("int2", checkInt2(Math.abs(a.v as number)));
        case "int4":
          return tv("int4", checkInt4(Math.abs(a.v as number)));
        case "int8": {
          const v = a.v as bigint;
          return tv("int8", checkInt8(v < 0n ? -v : v));
        }
        case "float4":
          return tv("float4", Math.abs(a.v as number));
        case "float8":
          return tv("float8", Math.abs(a.v as number));
        default:
          return tv("numeric", numericAbs(argNumeric(ctx, a)));
      }
    }),
  );

  const ceilFn = strict("numeric", (ctx: Parameters<ScalarFn>[0], args: TypedValue[]) => {
    const a = args[0]!;
    if (isFloatArg(a)) return tv("float8", Math.ceil(argFloat(ctx, a)));
    if (isIntType(a.t)) return tv(a.t, a.v);
    return tv("numeric", numericCeil(argNumeric(ctx, a)));
  });
  m.set("ceil", ceilFn);
  m.set("ceiling", ceilFn);
  m.set(
    "floor",
    strict("numeric", (ctx, args) => {
      const a = args[0]!;
      if (isFloatArg(a)) return tv("float8", Math.floor(argFloat(ctx, a)));
      if (isIntType(a.t)) return tv(a.t, a.v);
      return tv("numeric", numericFloor(argNumeric(ctx, a)));
    }),
  );
  m.set(
    "round",
    strict("numeric", (ctx, args) => {
      const a = args[0]!;
      if (args.length === 1) {
        if (isFloatArg(a)) {
          // PG float round: round-half-away-from-zero
          const f = argFloat(ctx, a);
          const r = f >= 0 ? Math.round(f) : -Math.round(-f);
          return tv("float8", r);
        }
        if (isIntType(a.t)) return tv(a.t, a.v);
        return tv("numeric", numericRound(argNumeric(ctx, a), 0));
      }
      const s = argInt(ctx, args[1]!);
      return tv("numeric", numericRound(argNumeric(ctx, a), s));
    }),
  );
  m.set(
    "trunc",
    strict("numeric", (ctx, args) => {
      const a = args[0]!;
      if (args.length === 1) {
        if (isFloatArg(a)) return tv("float8", Math.trunc(argFloat(ctx, a)));
        if (isIntType(a.t)) return tv(a.t, a.v);
        return tv("numeric", numericTrunc(argNumeric(ctx, a), 0));
      }
      const s = argInt(ctx, args[1]!);
      return tv("numeric", numericTrunc(argNumeric(ctx, a), s));
    }),
  );
  m.set(
    "sign",
    strict("numeric", (ctx, args) => {
      const a = args[0]!;
      if (isFloatArg(a)) {
        const f = argFloat(ctx, a);
        return tv("float8", f > 0 ? 1 : f < 0 ? -1 : Number.isNaN(f) ? Number.NaN : 0);
      }
      return tv("numeric", numericFromBigInt(BigInt(numericSign(argNumeric(ctx, a)))));
    }),
  );
  m.set(
    "sqrt",
    strict("numeric", (ctx, args) => {
      const a = args[0]!;
      if (isFloatArg(a)) {
        const f = argFloat(ctx, a);
        if (f < 0)
          throw pgError("invalid_argument_for_power_function", "cannot take square root of a negative number", "2201F");
        return tv("float8", Math.sqrt(f));
      }
      return tv("numeric", numericSqrt(argNumeric(ctx, a)));
    }),
  );
  m.set(
    "cbrt",
    strict("float8", (ctx, args) => tv("float8", Math.cbrt(argFloat(ctx, args[0]!)))),
  );
  m.set(
    "exp",
    strict("numeric", (ctx, args) => {
      const a = args[0]!;
      if (isFloatArg(a)) return tv("float8", floatErr(Math.exp(argFloat(ctx, a)), true));
      return tv("numeric", numericExp(argNumeric(ctx, a)));
    }),
  );
  m.set(
    "ln",
    strict("numeric", (ctx, args) => {
      const a = args[0]!;
      if (isFloatArg(a)) {
        const f = argFloat(ctx, a);
        if (f === 0) throw pgError("invalid_argument_for_log", "cannot take logarithm of zero", "2201E");
        if (f < 0) throw pgError("invalid_argument_for_log", "cannot take logarithm of a negative number", "2201E");
        return tv("float8", Math.log(f));
      }
      return tv("numeric", numericLn(argNumeric(ctx, a)));
    }),
  );
  m.set(
    "log",
    strict("numeric", (ctx, args) => {
      if (args.length === 2) {
        const base = argNumeric(ctx, args[0]!);
        const x = argNumeric(ctx, args[1]!);
        return tv("numeric", numericLogBase(base, x));
      }
      const a = args[0]!;
      if (isFloatArg(a)) {
        const f = argFloat(ctx, a);
        if (f === 0) throw pgError("invalid_argument_for_log", "cannot take logarithm of zero", "2201E");
        if (f < 0) throw pgError("invalid_argument_for_log", "cannot take logarithm of a negative number", "2201E");
        return tv("float8", Math.log10(f));
      }
      return tv("numeric", numericLog10(argNumeric(ctx, a)));
    }),
  );
  m.set(
    "log10",
    strict("numeric", (ctx, args) => {
      const a = args[0]!;
      if (isFloatArg(a)) return tv("float8", Math.log10(argFloat(ctx, a)));
      return tv("numeric", numericLog10(argNumeric(ctx, a)));
    }),
  );
  const powerFn = strict("numeric", (ctx: Parameters<ScalarFn>[0], args: TypedValue[]) => {
    const a = args[0]!;
    const b = args[1]!;
    if (isFloatArg(a) || isFloatArg(b)) {
      return tv("float8", floatErr(argFloat(ctx, a) ** argFloat(ctx, b), true));
    }
    return tv("numeric", numericPower(argNumeric(ctx, a), argNumeric(ctx, b)));
  });
  m.set("power", powerFn);
  m.set("pow", powerFn);
  m.set(
    "mod",
    strict("numeric", (ctx, args) => {
      const a = args[0]!;
      const b = args[1]!;
      if (isIntType(a.t) && isIntType(b.t)) {
        if (a.t === "int8" || b.t === "int8") {
          const x = castTo(ctx, a, "int8", {}).v as bigint;
          const y = castTo(ctx, b, "int8", {}).v as bigint;
          if (y === 0n) throw pgError("division_by_zero", "division by zero");
          return tv("int8", x % y);
        }
        const x = a.v as number;
        const y = b.v as number;
        if (y === 0) throw pgError("division_by_zero", "division by zero");
        const r = x % y;
        return tv(a.t === "int2" && b.t === "int2" ? "int2" : "int4", r);
      }
      return tv("numeric", numericMod(argNumeric(ctx, a), argNumeric(ctx, b)));
    }),
  );
  m.set(
    "div",
    strict("numeric", (ctx, args) => {
      const a = argNumeric(ctx, args[0]!);
      const b = argNumeric(ctx, args[1]!);
      return tv("numeric", numericDivTrunc(a, b));
    }),
  );
  m.set("pi", (_ctx, _args) => tv("float8", Math.PI));
  m.set(
    "degrees",
    strict("float8", (ctx, args) => tv("float8", (argFloat(ctx, args[0]!) * 180) / Math.PI)),
  );
  m.set(
    "radians",
    strict("float8", (ctx, args) => tv("float8", (argFloat(ctx, args[0]!) * Math.PI) / 180)),
  );

  const trig: Record<string, (x: number) => number> = {
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    cot: (x) => 1 / Math.tan(x),
    asin: Math.asin,
    acos: Math.acos,
    atan: Math.atan,
    sinh: Math.sinh,
    cosh: Math.cosh,
    tanh: Math.tanh,
    asinh: Math.asinh,
    acosh: Math.acosh,
    atanh: Math.atanh,
  };
  for (const [name, fn] of Object.entries(trig)) {
    m.set(
      name,
      strict("float8", (ctx, args) => {
        const x = argFloat(ctx, args[0]!);
        if ((name === "asin" || name === "acos") && (x < -1 || x > 1)) {
          throw pgError("numeric_value_out_of_range", "input is out of range");
        }
        if (name === "acosh" && x < 1) throw pgError("numeric_value_out_of_range", "input is out of range");
        if (name === "atanh" && (x < -1 || x > 1)) throw pgError("numeric_value_out_of_range", "input is out of range");
        return tv("float8", checkFloat(fn(x), name));
      }),
    );
  }
  m.set(
    "atan2",
    strict("float8", (ctx, args) => tv("float8", Math.atan2(argFloat(ctx, args[0]!), argFloat(ctx, args[1]!)))),
  );

  // degree-based variants
  const degTrig: Record<string, (x: number) => number> = {
    sind: (x) => exactDegSin(x),
    cosd: (x) => exactDegCos(x),
    tand: (x) => exactDegTan(x),
    cotd: (x) => 1 / exactDegTan(x),
    asind: (x) => (Math.asin(x) * 180) / Math.PI,
    acosd: (x) => (Math.acos(x) * 180) / Math.PI,
    atand: (x) => (Math.atan(x) * 180) / Math.PI,
  };
  for (const [name, fn] of Object.entries(degTrig)) {
    m.set(
      name,
      strict("float8", (ctx, args) => {
        const x = argFloat(ctx, args[0]!);
        if ((name === "asind" || name === "acosd") && (x < -1 || x > 1)) {
          throw pgError("numeric_value_out_of_range", "input is out of range");
        }
        return tv("float8", fn(x));
      }),
    );
  }
  m.set(
    "atan2d",
    strict("float8", (ctx, args) =>
      tv("float8", (Math.atan2(argFloat(ctx, args[0]!), argFloat(ctx, args[1]!)) * 180) / Math.PI),
    ),
  );

  m.set(
    "gcd",
    strict("numeric", (ctx, args) => {
      const a = args[0]!;
      const b = args[1]!;
      if (a.t === "int8" || b.t === "int8") {
        const x = castTo(ctx, a, "int8", {}).v as bigint;
        const y = castTo(ctx, b, "int8", {}).v as bigint;
        return tv("int8", checkInt8(bigintGcd(x, y)));
      }
      if (isIntType(a.t) && isIntType(b.t)) {
        const g = bigintGcd(BigInt(a.v as number), BigInt(b.v as number));
        return tv("int4", checkInt4(Number(g)));
      }
      return tv("numeric", numericGcd(argNumeric(ctx, a), argNumeric(ctx, b)));
    }),
  );
  m.set(
    "lcm",
    strict("numeric", (ctx, args) => {
      const a = args[0]!;
      const b = args[1]!;
      if (a.t === "int8" || b.t === "int8") {
        const x = castTo(ctx, a, "int8", {}).v as bigint;
        const y = castTo(ctx, b, "int8", {}).v as bigint;
        if (x === 0n || y === 0n) return tv("int8", 0n);
        const l = (x / bigintGcd(x, y)) * y;
        return tv("int8", checkInt8(l < 0n ? -l : l));
      }
      if (isIntType(a.t) && isIntType(b.t)) {
        const x = BigInt(a.v as number);
        const y = BigInt(b.v as number);
        if (x === 0n || y === 0n) return tv("int4", 0);
        const l = (x / bigintGcd(x, y)) * y;
        return tv("int4", checkInt4(Number(l < 0n ? -l : l)));
      }
      const na = argNumeric(ctx, args[0]!);
      const nb = argNumeric(ctx, args[1]!);
      if (numericSign(na) === 0 || numericSign(nb) === 0) return tv("numeric", makeNumeric(0n, 0));
      const g = numericGcd(na, nb);
      const l = numericMul(numericDivScaled(na, g, 0), nb);
      return tv("numeric", numericAbs(l));
    }),
  );
  m.set(
    "factorial",
    strict("numeric", (ctx, args) => {
      const n = castTo(ctx, args[0]!, "int8", {}).v as bigint;
      if (n < 0n) throw pgError("invalid_parameter_value", "factorial of a negative number is undefined");
      let acc = 1n;
      for (let i = 2n; i <= n; i++) {
        acc *= i;
        if (acc > 10n ** 100000n) throw pgError("numeric_value_out_of_range", "value overflows numeric format");
      }
      return tv("numeric", numericFromBigInt(acc));
    }),
  );
  m.set(
    "width_bucket",
    strict("int4", (ctx, args) => {
      const op = argNumeric(ctx, args[0]!);
      const b1 = argNumeric(ctx, args[1]!);
      const b2 = argNumeric(ctx, args[2]!);
      const count = argInt(ctx, args[3]!);
      if (count <= 0)
        throw pgError("invalid_argument_for_width_bucket_function", "count must be greater than zero", "2201G");
      const cmp12 = numericCmp(b1, b2);
      if (cmp12 === 0)
        throw pgError("invalid_argument_for_width_bucket_function", "lower bound cannot equal upper bound", "2201G");
      if (op.special === "nan" || b1.special === "nan" || b2.special === "nan") {
        throw pgError(
          "invalid_argument_for_width_bucket_function",
          "operand, lower bound, and upper bound cannot be NaN",
          "2201G",
        );
      }
      const ascending = cmp12 < 0;
      if (ascending) {
        if (numericCmp(op, b1) < 0) return tv("int4", 0);
        if (numericCmp(op, b2) >= 0) return tv("int4", count + 1);
      } else {
        if (numericCmp(op, b1) > 0) return tv("int4", 0);
        if (numericCmp(op, b2) <= 0) return tv("int4", count + 1);
      }
      // bucket = floor(count * (op - b1) / (b2 - b1)) + 1
      const num = numericMul(numericFromBigInt(BigInt(count)), numericSub(op, b1));
      const den = numericSub(b2, b1);
      const q = numericDivScaled(num, den, 20);
      const fl = numericToBigInt(numericFloor(q));
      return tv("int4", checkInt4(Number(fl) + 1));
    }),
  );
  m.set(
    "scale",
    strict("int4", (ctx, args) => {
      const n = argNumeric(ctx, args[0]!);
      if (n.special) return tv("int4", null);
      return tv("int4", n.dscale);
    }),
  );
  m.set(
    "min_scale",
    strict("int4", (ctx, args) => {
      const n = argNumeric(ctx, args[0]!);
      if (n.special) throw pgError("numeric_value_out_of_range", "cannot take min_scale of special values");
      return tv("int4", numericStripTrailingZeros(n).dscale);
    }),
  );
  m.set(
    "trim_scale",
    strict("numeric", (ctx, args) => {
      const n = argNumeric(ctx, args[0]!);
      if (n.special) return tv("numeric", n);
      return tv("numeric", numericStripTrailingZeros(n));
    }),
  );
  m.set("random", (ctx, _args) => tv("float8", ctx.state.prng.nextFloat()));
  m.set("setseed", (ctx, args) => {
    const seed = argFloat(ctx, args[0]!);
    if (seed < -1 || seed > 1) {
      throw pgError("invalid_parameter_value", `setseed parameter ${seed} is out of allowed range [-1,1]`, "22023");
    }
    ctx.state.prng.setSeedFloat(seed);
    return tv("void", null);
  });
  m.set(
    "erf",
    strict("float8", (ctx, args) => tv("float8", erf(argFloat(ctx, args[0]!)))),
  );
  m.set(
    "erfc",
    strict("float8", (ctx, args) => tv("float8", 1 - erf(argFloat(ctx, args[0]!)))),
  );

  m.set(
    "isfinite",
    strict("bool", (ctx, args) => {
      const a = args[0]!;
      void ctx;
      if (a.t === "date") {
        const d = a.v as number;
        return tv("bool", d !== 2147483647 && d !== -2147483648);
      }
      if (a.t === "timestamp" || a.t === "timestamptz") {
        const t = a.v as bigint;
        return tv("bool", t !== 9223372036854775807n && t !== -9223372036854775808n);
      }
      if (a.t === "interval") return tv("bool", true);
      if (isNumericType(a.t)) {
        if (isNumeric(a.v)) return tv("bool", a.v.special !== "inf" && a.v.special !== "-inf");
        if (typeof a.v === "number") return tv("bool", Number.isFinite(a.v) || Number.isNaN(a.v));
        return tv("bool", true);
      }
      throw pgError("datatype_mismatch", `function isfinite(${a.t}) does not exist`, "42883");
    }),
  );

  m.set("num_nulls", (_ctx, args) => tv("int4", args.filter((a) => a.v === null).length));
  m.set("num_nonnulls", (_ctx, args) => tv("int4", args.filter((a) => a.v !== null).length));

  return m;
}

function bigintGcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

function numericGcd(a: Numeric, b: Numeric): Numeric {
  // scale both to common dscale and gcd the coefficients
  const ds = Math.max(a.dscale, b.dscale);
  let ca = a.coef;
  for (let i = a.dscale; i < ds; i++) ca *= 10n;
  let cb = b.coef;
  for (let i = b.dscale; i < ds; i++) cb *= 10n;
  const g = bigintGcd(ca, cb);
  return numericStripTrailingZeros(makeNumeric(g, ds));
}

/** Abramowitz & Stegun 7.1.26 is not precise enough; use the series/continued fraction combo. */
function erf(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x === 0) return 0;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  if (ax > 6) return sign;
  // series expansion
  let sum = ax;
  let term = ax;
  for (let n = 1; n < 200; n++) {
    term *= (-ax * ax) / n;
    const add = term / (2 * n + 1);
    sum += add;
    if (Math.abs(add) < 1e-18 * Math.abs(sum)) break;
  }
  return (sign * 2 * sum) / Math.sqrt(Math.PI);
}

function exactDegSin(x: number): number {
  const mod = ((x % 360) + 360) % 360;
  if (mod === 0 || mod === 180) return 0;
  if (mod === 90) return 1;
  if (mod === 270) return -1;
  if (mod === 30 || mod === 150) return 0.5;
  if (mod === 210 || mod === 330) return -0.5;
  return Math.sin((x * Math.PI) / 180);
}

function exactDegCos(x: number): number {
  return exactDegSin(x + 90);
}

function exactDegTan(x: number): number {
  const mod = ((x % 360) + 360) % 360;
  if (mod === 0 || mod === 180) return 0;
  if (mod === 45 || mod === 225) return 1;
  if (mod === 135 || mod === 315) return -1;
  if (mod === 90 || mod === 270) return Number.POSITIVE_INFINITY * (mod === 90 ? 1 : -1);
  return Math.tan((x * Math.PI) / 180);
}
