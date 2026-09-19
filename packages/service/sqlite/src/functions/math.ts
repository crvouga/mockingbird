import { SqliteError } from "../errors/index.ts";
import { asSqlReal, coerceToNumber, type SqlValue } from "../types/value.ts";
import type { FunctionContext, ScalarFunction } from "./registry.ts";

function requireArgs(name: string, args: SqlValue[], min: number, max = min): void {
  if (args.length < min || args.length > max) {
    throw new SqliteError(`wrong number of arguments to function ${name}()`, "misuse");
  }
}

function num(value: SqlValue): number | null {
  if (value === null) return null;
  return coerceToNumber(value);
}

function realOrNull(value: number | null): SqlValue {
  if (value === null || Number.isNaN(value)) return null;
  return asSqlReal(value);
}

function unaryMath(name: string, fn: (n: number) => number): ScalarFunction {
  return (args) => {
    requireArgs(name, args, 1);
    const n = num(args[0]!);
    if (n === null) return null;
    return realOrNull(fn(n));
  };
}

/** IEEE754 helpers matching SQLite ENABLE_MATH_FUNCTIONS / ieee754 extension. */
function decodeIeee754(value: number): { mantissa: bigint; exponent: number } {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value, false);
  const bits = new DataView(buf).getBigUint64(0, false);
  const sign = bits >> 63n;
  const expBits = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & 0xfffffffffffffn;
  if (expBits === 0) {
    // subnormal or zero
    let m = frac;
    let e = -1074;
    if (m === 0n) return { mantissa: sign === 0n ? 0n : -0n, exponent: 0 };
    while ((m & 1n) === 0n) {
      m >>= 1n;
      e++;
    }
    return { mantissa: sign ? -m : m, exponent: e };
  }
  if (expBits === 0x7ff) {
    // Inf/NaN — SQLite still formats; use mantissa with high bit
    const m = (1n << 52n) | frac;
    return { mantissa: sign ? -m : m, exponent: 972 };
  }
  let m = (1n << 52n) | frac;
  let e = expBits - 1075;
  while ((m & 1n) === 0n) {
    m >>= 1n;
    e++;
  }
  return { mantissa: sign ? -m : m, exponent: e };
}

function encodeIeee754(mantissa: bigint, exponent: number): number {
  if (mantissa === 0n) return 0;
  const sign = mantissa < 0n ? -1 : 1;
  let m = mantissa < 0n ? -mantissa : mantissa;
  let e = exponent;
  while (m > 0n && (m & 1n) === 0n) {
    m >>= 1n;
    e++;
  }
  // Reconstruct via Math: value = m * 2^e
  return sign * Number(m) * 2 ** e;
}

export const mathFunctions: Readonly<Record<string, ScalarFunction>> = {
  acos: unaryMath("acos", Math.acos),
  acosh: unaryMath("acosh", Math.acosh),
  asin: unaryMath("asin", Math.asin),
  asinh: unaryMath("asinh", Math.asinh),
  atan: unaryMath("atan", Math.atan),
  atanh: unaryMath("atanh", Math.atanh),
  ceil: unaryMath("ceil", Math.ceil),
  ceiling: unaryMath("ceiling", Math.ceil),
  cos: unaryMath("cos", Math.cos),
  cosh: unaryMath("cosh", Math.cosh),
  degrees: unaryMath("degrees", (n) => (n * 180) / Math.PI),
  exp: unaryMath("exp", Math.exp),
  floor: unaryMath("floor", Math.floor),
  ln: unaryMath("ln", Math.log),
  log10: unaryMath("log10", Math.log10),
  log2: unaryMath("log2", Math.log2),
  pi(args) {
    requireArgs("pi", args, 0);
    return asSqlReal(Math.PI);
  },
  radians: unaryMath("radians", (n) => (n * Math.PI) / 180),
  sign(args) {
    requireArgs("sign", args, 1);
    const n = num(args[0]!);
    if (n === null) return null;
    if (n > 0) return 1;
    if (n < 0) return -1;
    return 0;
  },
  sin: unaryMath("sin", Math.sin),
  sinh: unaryMath("sinh", Math.sinh),
  sqrt: unaryMath("sqrt", Math.sqrt),
  tan: unaryMath("tan", Math.tan),
  tanh: unaryMath("tanh", Math.tanh),
  trunc: unaryMath("trunc", Math.trunc),
  atan2(args) {
    requireArgs("atan2", args, 2);
    const y = num(args[0]!);
    const x = num(args[1]!);
    if (y === null || x === null) return null;
    return realOrNull(Math.atan2(y, x));
  },
  log(args) {
    requireArgs("log", args, 1, 2);
    if (args.length === 1) {
      const n = num(args[0]!);
      if (n === null) return null;
      return realOrNull(Math.log10(n));
    }
    const base = num(args[0]!);
    const n = num(args[1]!);
    if (base === null || n === null) return null;
    return realOrNull(Math.log(n) / Math.log(base));
  },
  mod(args) {
    requireArgs("mod", args, 2);
    const a = num(args[0]!);
    const b = num(args[1]!);
    if (a === null || b === null) return null;
    if (b === 0) return null;
    return realOrNull(a % b);
  },
  pow(args) {
    requireArgs("pow", args, 2);
    const a = num(args[0]!);
    const b = num(args[1]!);
    if (a === null || b === null) return null;
    return realOrNull(a ** b);
  },
  power(args, ctx) {
    return mathFunctions.pow!(args, ctx);
  },
  ieee754(args) {
    requireArgs("ieee754", args, 1, 2);
    if (args.length === 1) {
      const n = num(args[0]!);
      if (n === null) return null;
      const { mantissa, exponent } = decodeIeee754(n);
      return `ieee754(${mantissa},${exponent})`;
    }
    const m = args[0]!;
    const e = args[1]!;
    if (m === null || e === null) return null;
    const mantissa = typeof m === "bigint" ? m : BigInt(Math.trunc(num(m)!));
    const exponent = Math.trunc(num(e)!);
    return realOrNull(encodeIeee754(mantissa, exponent));
  },
  ieee754_mantissa(args) {
    requireArgs("ieee754_mantissa", args, 1);
    const n = num(args[0]!);
    if (n === null) return null;
    return decodeIeee754(n).mantissa;
  },
  ieee754_exponent(args) {
    requireArgs("ieee754_exponent", args, 1);
    const n = num(args[0]!);
    if (n === null) return null;
    return decodeIeee754(n).exponent;
  },
  ieee754_to_blob(args) {
    requireArgs("ieee754_to_blob", args, 1);
    const n = num(args[0]!);
    if (n === null) return null;
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, n, false);
    return new Uint8Array(buf);
  },
  ieee754_from_blob(args) {
    requireArgs("ieee754_from_blob", args, 1);
    const value = args[0];
    if (value === null) return null;
    if (!(value instanceof Uint8Array) || value.length !== 8) {
      throw new SqliteError("ieee754_from_blob() requires an 8-byte blob", "misuse");
    }
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    return realOrNull(view.getFloat64(0, false));
  },
  ieee754_inc(args) {
    requireArgs("ieee754_inc", args, 2);
    const n = num(args[0]!);
    const delta = num(args[1]!);
    if (n === null || delta === null) return null;
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setFloat64(0, n, false);
    let bits = view.getBigUint64(0, false);
    const step = BigInt(Math.trunc(delta));
    bits = (bits + step) & 0xffffffffffffffffn;
    view.setBigUint64(0, bits, false);
    return realOrNull(view.getFloat64(0, false));
  },
};

// silence unused
void (null as unknown as FunctionContext);
