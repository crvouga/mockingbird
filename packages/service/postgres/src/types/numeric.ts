import { pgError } from "../errors/error.ts";
import { assertBounds } from "../runtime/assert.ts";

/**
 * Arbitrary-precision decimal mirroring PostgreSQL's `numeric`.
 *
 * Value = (nan/inf special) or coefficient * 10^-dscale where `coef` is a
 * signed bigint and `dscale` (display scale) is the number of digits after
 * the decimal point. Display scale is significant: `2.50` renders as "2.50".
 */
export interface Numeric {
  readonly kind: "numeric";
  /** signed coefficient; value = coef * 10^-dscale */
  readonly coef: bigint;
  /** display scale (digits after decimal point), >= 0 */
  readonly dscale: number;
  readonly special: "nan" | "inf" | "-inf" | null;
}

const MAX_DISPLAY_SCALE = 1000;
const MIN_SIG_DIGITS = 16;

export function makeNumeric(coef: bigint, dscale: number): Numeric {
  assertBounds(dscale, 0, MAX_DISPLAY_SCALE, "numeric dscale");
  return { kind: "numeric", coef, dscale, special: null };
}

export const NUMERIC_NAN: Numeric = { kind: "numeric", coef: 0n, dscale: 0, special: "nan" };
export const NUMERIC_PINF: Numeric = { kind: "numeric", coef: 0n, dscale: 0, special: "inf" };
export const NUMERIC_NINF: Numeric = { kind: "numeric", coef: 0n, dscale: 0, special: "-inf" };

export function isNumeric(v: unknown): v is Numeric {
  return typeof v === "object" && v !== null && (v as any).kind === "numeric";
}

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

export function numericFromBigInt(v: bigint): Numeric {
  return makeNumeric(v, 0);
}

export function numericFromNumber(v: number): Numeric {
  if (Number.isNaN(v)) return NUMERIC_NAN;
  if (v === Number.POSITIVE_INFINITY) return NUMERIC_PINF;
  if (v === Number.NEGATIVE_INFINITY) return NUMERIC_NINF;
  return parseNumeric(shortestNumberString(v));
}

/** Shortest round-trip decimal digits for a JS number, in plain notation. */
function shortestNumberString(v: number): string {
  const s = String(v);
  if (!s.includes("e") && !s.includes("E")) return s;
  // expand scientific notation
  const m = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
  if (!m) return s;
  const sign = m[1]!;
  const intPart = m[2]!;
  const fracPart = m[3] ?? "";
  const exp = Number(m[4]!);
  const digits = intPart + fracPart;
  const pointPos = intPart.length + exp;
  if (pointPos <= 0) {
    return `${sign}0.${"0".repeat(-pointPos)}${digits}`;
  }
  if (pointPos >= digits.length) {
    return sign + digits + "0".repeat(pointPos - digits.length);
  }
  return `${sign}${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
}

const NUMERIC_RE = /^\s*([+-]?)(?:(\d[\d_]*)?(?:\.(\d[\d_]*)?)?)([eE][+-]?\d[\d_]*)?\s*$/;

/** Parse text into numeric. Throws 22P02 on bad syntax (like numeric_in). */
export function parseNumeric(text: string): Numeric {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "nan") return NUMERIC_NAN;
  if (lower === "infinity" || lower === "inf" || lower === "+infinity" || lower === "+inf") return NUMERIC_PINF;
  if (lower === "-infinity" || lower === "-inf") return NUMERIC_NINF;
  const m = NUMERIC_RE.exec(trimmed);
  if (!m || (m[2] === undefined && m[3] === undefined)) {
    throw pgError("invalid_text_representation", `invalid input syntax for type numeric: "${text}"`);
  }
  const sign = m[1] === "-" ? -1n : 1n;
  const intDigits = (m[2] ?? "").replaceAll("_", "");
  const fracDigits = (m[3] ?? "").replaceAll("_", "");
  const expPart = m[4] ? Number(m[4].slice(1).replaceAll("_", "")) : 0;
  let coef = BigInt((intDigits || "0") + fracDigits);
  let dscale = fracDigits.length - expPart;
  if (dscale < 0) {
    coef *= pow10(-dscale);
    dscale = 0;
  }
  if (dscale > MAX_DISPLAY_SCALE) {
    // reduce to max display scale with rounding
    const r = roundToScale(sign * coef, dscale, MAX_DISPLAY_SCALE);
    return makeNumeric(r, MAX_DISPLAY_SCALE);
  }
  return makeNumeric(sign * coef, dscale);
}

/** Round coefficient at `fromScale` to `toScale` (half away from zero). */
function roundToScale(coef: bigint, fromScale: number, toScale: number): bigint {
  if (toScale >= fromScale) return coef * pow10(toScale - fromScale);
  const drop = fromScale - toScale;
  const p = pow10(drop);
  const q = coef / p;
  const r = coef % p;
  const half = p / 2n;
  if (r >= half) return q + 1n;
  if (-r >= half) return q - 1n;
  return q;
}

export function numericRescale(v: Numeric, dscale: number): Numeric {
  if (v.special) return v;
  return makeNumeric(roundToScale(v.coef, v.dscale, dscale), dscale);
}

export function numericText(v: Numeric): string {
  if (v.special === "nan") return "NaN";
  if (v.special === "inf") return "Infinity";
  if (v.special === "-inf") return "-Infinity";
  const neg = v.coef < 0n;
  const abs = (neg ? -v.coef : v.coef).toString();
  const scale = v.dscale;
  let out: string;
  if (scale === 0) {
    out = abs;
  } else {
    const padded = abs.padStart(scale + 1, "0");
    out = `${padded.slice(0, padded.length - scale)}.${padded.slice(padded.length - scale)}`;
  }
  return neg ? `-${out}` : out;
}

export function numericIsZero(v: Numeric): boolean {
  return v.special === null && v.coef === 0n;
}

export function numericSign(v: Numeric): number {
  if (v.special === "nan") return Number.NaN;
  if (v.special === "inf") return 1;
  if (v.special === "-inf") return -1;
  return v.coef > 0n ? 1 : v.coef < 0n ? -1 : 0;
}

/** Compare (NaN sorts greater than everything, like PG). Returns -1|0|1. */
export function numericCmp(a: Numeric, b: Numeric): number {
  const rank = (v: Numeric): number =>
    v.special === "nan" ? 2 : v.special === "inf" ? 1 : v.special === "-inf" ? -1 : 0;
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== 0 || rb !== 0) return ra < rb ? -1 : ra > rb ? 1 : 0;
  const scale = Math.max(a.dscale, b.dscale);
  const ca = a.coef * pow10(scale - a.dscale);
  const cb = b.coef * pow10(scale - b.dscale);
  return ca < cb ? -1 : ca > cb ? 1 : 0;
}

function addSpecial(a: Numeric, b: Numeric): Numeric | null {
  if (a.special === "nan" || b.special === "nan") return NUMERIC_NAN;
  if (a.special === "inf") return b.special === "-inf" ? NUMERIC_NAN : NUMERIC_PINF;
  if (a.special === "-inf") return b.special === "inf" ? NUMERIC_NAN : NUMERIC_NINF;
  if (b.special) return b;
  return null;
}

export function numericAdd(a: Numeric, b: Numeric): Numeric {
  const sp = addSpecial(a, b);
  if (sp) return sp;
  const scale = Math.max(a.dscale, b.dscale);
  return makeNumeric(a.coef * pow10(scale - a.dscale) + b.coef * pow10(scale - b.dscale), scale);
}

export function numericNeg(a: Numeric): Numeric {
  if (a.special === "inf") return NUMERIC_NINF;
  if (a.special === "-inf") return NUMERIC_PINF;
  if (a.special) return a;
  return makeNumeric(-a.coef, a.dscale);
}

export function numericSub(a: Numeric, b: Numeric): Numeric {
  return numericAdd(a, numericNeg(b));
}

export function numericMul(a: Numeric, b: Numeric): Numeric {
  if (a.special || b.special) {
    if (a.special === "nan" || b.special === "nan") return NUMERIC_NAN;
    const sa = numericSign(a);
    const sb = numericSign(b);
    if (sa === 0 || sb === 0) return NUMERIC_NAN; // inf * 0
    return sa * sb > 0 ? NUMERIC_PINF : NUMERIC_NINF;
  }
  let dscale = a.dscale + b.dscale;
  let coef = a.coef * b.coef;
  if (dscale > MAX_DISPLAY_SCALE) {
    coef = roundToScale(coef, dscale, MAX_DISPLAY_SCALE);
    dscale = MAX_DISPLAY_SCALE;
  }
  return makeNumeric(coef, dscale);
}

/** Decimal weight: exponent of the first significant digit (0 for 1..9). */
function decimalWeight(v: Numeric): number {
  if (v.coef === 0n) return 0;
  const abs = v.coef < 0n ? -v.coef : v.coef;
  return abs.toString().length - 1 - v.dscale;
}

/**
 * NBASE (base-10000) weight and first digit group, as numeric.c stores them.
 * weight w means the first digit group has value firstdigit × 10000^w.
 */
function nbaseFirstDigit(v: Numeric): { weight: number; firstdigit: number } {
  if (v.coef === 0n) return { weight: 0, firstdigit: 0 };
  const abs = v.coef < 0n ? -v.coef : v.coef;
  const dw = abs.toString().length - 1 - v.dscale;
  const weight = Math.floor(dw / 4);
  const e = v.dscale + 4 * weight;
  const firstdigit = e >= 0 ? abs / pow10(e) : abs * pow10(-e);
  return { weight, firstdigit: Number(firstdigit) };
}

/** Result scale for division, mirroring numeric.c select_div_scale. */
export function selectDivScale(a: Numeric, b: Numeric): number {
  const d1 = nbaseFirstDigit(a);
  const d2 = nbaseFirstDigit(b);
  // Estimate quotient weight in NBASE digits (DEC_DIGITS = 4 per digit).
  let qweight = d1.weight - d2.weight;
  if (d1.firstdigit <= d2.firstdigit) qweight--;
  let rscale = MIN_SIG_DIGITS - qweight * 4;
  rscale = Math.max(rscale, a.dscale);
  rscale = Math.max(rscale, b.dscale);
  rscale = Math.max(rscale, 0);
  rscale = Math.min(rscale, MAX_DISPLAY_SCALE);
  return rscale;
}

/** Divide with explicit result scale, rounding half away from zero. */
export function numericDivScaled(a: Numeric, b: Numeric, rscale: number): Numeric {
  const sp = divSpecial(a, b);
  if (sp) return sp;
  if (b.coef === 0n) throw pgError("division_by_zero", "division by zero");
  // a.coef*10^-as / b.coef*10^-bs = (a.coef / b.coef) * 10^(bs-as)
  // target: q * 10^-rscale
  const shift = rscale + b.dscale - a.dscale;
  let num = a.coef;
  let den = b.coef;
  if (shift >= 0) num *= pow10(shift);
  else den *= pow10(-shift);
  const neg = num < 0n !== den < 0n;
  const an = num < 0n ? -num : num;
  const ad = den < 0n ? -den : den;
  let q = an / ad;
  const r = an % ad;
  if (r * 2n >= ad) q += 1n;
  return makeNumeric(neg ? -q : q, rscale);
}

function divSpecial(a: Numeric, b: Numeric): Numeric | null {
  if (a.special === "nan" || b.special === "nan") return NUMERIC_NAN;
  if (a.special) {
    if (b.special) return NUMERIC_NAN; // inf/inf
    if (b.coef === 0n) throw pgError("division_by_zero", "division by zero");
    const s = numericSign(a) * numericSign(b);
    return s > 0 ? NUMERIC_PINF : NUMERIC_NINF;
  }
  if (b.special) return makeNumeric(0n, 0);
  return null;
}

export function numericDiv(a: Numeric, b: Numeric): Numeric {
  return numericDivScaled(a, b, selectDivScale(a, b));
}

/** Truncated integer division (div(a,b) function semantics). */
export function numericDivTrunc(a: Numeric, b: Numeric): Numeric {
  const sp = divSpecial(a, b);
  if (sp) return sp;
  if (b.coef === 0n) throw pgError("division_by_zero", "division by zero");
  const scale = Math.max(a.dscale, b.dscale);
  const ca = a.coef * pow10(scale - a.dscale);
  const cb = b.coef * pow10(scale - b.dscale);
  return makeNumeric(ca / cb, 0);
}

/** Modulo like numeric_mod: result has scale max(s1, s2), sign of dividend. */
export function numericMod(a: Numeric, b: Numeric): Numeric {
  if (a.special === "nan" || b.special === "nan") return NUMERIC_NAN;
  if (a.special) return NUMERIC_NAN;
  if (b.special) return a;
  if (b.coef === 0n) throw pgError("division_by_zero", "division by zero");
  const scale = Math.max(a.dscale, b.dscale);
  const ca = a.coef * pow10(scale - a.dscale);
  const cb = b.coef * pow10(scale - b.dscale);
  return makeNumeric(ca % cb, scale);
}

export function numericAbs(a: Numeric): Numeric {
  if (a.special === "-inf") return NUMERIC_PINF;
  if (a.special) return a;
  return makeNumeric(a.coef < 0n ? -a.coef : a.coef, a.dscale);
}

/** round(v, s): round half away from zero; result dscale = max(s, 0). */
export function numericRound(a: Numeric, s: number): Numeric {
  if (a.special) return a;
  if (s >= a.dscale) return a;
  const coef = roundToScale(a.coef, a.dscale, Math.max(s, -1000));
  if (s < 0) {
    return makeNumeric(coef * pow10(-s), 0);
  }
  return makeNumeric(coef, s);
}

/** trunc(v, s): truncate toward zero. */
export function numericTrunc(a: Numeric, s: number): Numeric {
  if (a.special) return a;
  if (s >= a.dscale) return a;
  const drop = a.dscale - Math.max(s, 0);
  let coef = a.coef / pow10(drop);
  if (s < 0) {
    const p = pow10(-s);
    coef = (coef / p) * p;
    return makeNumeric(coef, 0);
  }
  return makeNumeric(coef, Math.max(s, 0));
}

export function numericFloor(a: Numeric): Numeric {
  if (a.special) return a;
  if (a.dscale === 0) return a;
  const p = pow10(a.dscale);
  let q = a.coef / p;
  if (a.coef < 0n && a.coef % p !== 0n) q -= 1n;
  return makeNumeric(q, 0);
}

export function numericCeil(a: Numeric): Numeric {
  if (a.special) return a;
  if (a.dscale === 0) return a;
  const p = pow10(a.dscale);
  let q = a.coef / p;
  if (a.coef > 0n && a.coef % p !== 0n) q += 1n;
  return makeNumeric(q, 0);
}

export function numericToNumber(a: Numeric): number {
  if (a.special === "nan") return Number.NaN;
  if (a.special === "inf") return Number.POSITIVE_INFINITY;
  if (a.special === "-inf") return Number.NEGATIVE_INFINITY;
  return Number(numericText(a));
}

/** Exact bigint if integral after rounding to scale 0 (half away from zero). */
export function numericToBigInt(a: Numeric): bigint {
  if (a.special) {
    throw pgError("numeric_value_out_of_range", "bigint out of range");
  }
  return roundToScale(a.coef, a.dscale, 0);
}

/** sqrt via integer Newton iteration at extended scale. */
export function numericSqrt(a: Numeric): Numeric {
  if (a.special === "nan") return NUMERIC_NAN;
  if (a.special === "inf") return NUMERIC_PINF;
  if (a.special === "-inf") throw pgError("invalid_parameter_value", "cannot take square root of a negative number");
  if (a.coef < 0n) throw pgError("invalid_parameter_value", "cannot take square root of a negative number");
  if (a.coef === 0n) return makeNumeric(0n, Math.max(a.dscale, 0));
  // PG numeric_sqrt: sweight from the NBASE-10000 weight of the argument
  const w4 = Math.floor(decimalWeight(a) / 4);
  const sweight = ((w4 + 1) * 4) / 2 - 1;
  let rscale = MIN_SIG_DIGITS - sweight;
  rscale = Math.max(rscale, a.dscale);
  rscale = Math.max(rscale, 0);
  rscale = Math.min(rscale, MAX_DISPLAY_SCALE);
  // compute floor(sqrt(a * 10^(2*(rscale+g)))) with guard digits then round
  const guard = 4;
  const target =
    a.coef * pow10(2 * (rscale + guard) - a.dscale + ((2 * (rscale + guard) - a.dscale) % 2 === 0 ? 0 : 1));
  // ensure even shift for exact sqrt scaling
  let shift = 2 * (rscale + guard) - a.dscale;
  if (shift % 2 !== 0) shift += 1;
  const scaled = a.coef * pow10(shift);
  const root = bigintSqrt(scaled);
  void target;
  const extraScale = (a.dscale + shift) / 2;
  return makeNumeric(roundToScale(root, extraScale, rscale), rscale);
}

function bigintSqrt(n: bigint): bigint {
  if (n < 0n) throw pgError("internal", "bigintSqrt: negative operand", "XX000");
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

// --- fixed-point transcendental core -------------------------------------------
// Values are bigints scaled by 10^S. Mirrors PG's ln_var/exp_var/power_var so
// results are correct to the chosen display scale (float64 is not enough).

/** round(num / den), half away from zero; den > 0 */
function roundDiv(num: bigint, den: bigint): bigint {
  const q = num / den;
  const r = num % den;
  if (r === 0n) return q;
  const abs2r = (r < 0n ? -r : r) * 2n;
  if (abs2r >= den) return num < 0n ? q - 1n : q + 1n;
  return q;
}

function fxFrom(v: Numeric, S: number): bigint {
  return roundToScale(v.coef, v.dscale, S);
}

function fxMul(a: bigint, b: bigint, S: number): bigint {
  return roundDiv(a * b, pow10(S));
}

function fxDiv(a: bigint, b: bigint, S: number): bigint {
  const neg = b < 0n;
  return roundDiv(a * pow10(S) * (neg ? -1n : 1n), neg ? -b : b);
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  // Newton from a power-of-two upper bound; monotonically descends to floor(sqrt(n))
  let x = 1n << BigInt((n.toString(2).length >> 1) + 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

function fxSqrt(a: bigint, S: number): bigint {
  return isqrt(a * pow10(S));
}

/** ln of positive fixed-point x at scale S (repeated sqrt into [0.9, 1.1], then atanh series) */
function fxLn(x: bigint, S: number): bigint {
  const one = pow10(S);
  let m = x;
  let f = 1n;
  const hi = (one * 11n) / 10n;
  const lo = (one * 9n) / 10n;
  while (m > hi || m < lo) {
    m = fxSqrt(m, S);
    f *= 2n;
  }
  const t = fxDiv(m - one, m + one, S);
  const t2 = fxMul(t, t, S);
  let term = t;
  let sum = t;
  let k = 3n;
  for (;;) {
    term = fxMul(term, t2, S);
    const add = roundDiv(term, k);
    if (add === 0n) break;
    sum += add;
    k += 2n;
  }
  return 2n * f * sum;
}

/** e^x for fixed-point x at scale S (halve into |x| <= 0.01, Taylor, square back) */
function fxExp(x: bigint, S: number): bigint {
  const one = pow10(S);
  const limit = one / 100n;
  let xx = x;
  let halvings = 0;
  while (xx > limit || xx < -limit) {
    xx = roundDiv(xx, 2n);
    halvings++;
    if (halvings > 1000) throw pgError("numeric_value_out_of_range", "value overflows numeric format");
  }
  let term = one;
  let sum = one;
  let k = 1n;
  for (;;) {
    term = roundDiv(fxMul(term, xx, S), k);
    if (term === 0n) break;
    sum += term;
    k += 1n;
  }
  let r = sum;
  for (let i = 0; i < halvings; i++) r = fxMul(r, r, S);
  return r;
}

/** working guard digits beyond the display scale */
const FX_GUARD = 24;

/** PG's literal log10(e) constant from numeric.c (not Math.LOG10E) */
// biome-ignore lint/suspicious/noApproximativeNumericConstant: intentionally PG's truncated constant
const PG_LOG10E = 0.434294481903252;

/**
 * PG's estimate_ln_dweight: decimal weight of the most significant digit of
 * ln(x). Near 1 (0.9..1.1) it uses the weight of x-1; otherwise a float estimate.
 */
function estimateLnDweight(a: Numeric): number {
  const nineTenths = makeNumeric(9n, 1);
  const elevenTenths = makeNumeric(11n, 1);
  if (numericCmp(a, nineTenths) >= 0 && numericCmp(a, elevenTenths) <= 0) {
    const d = numericSub(a, makeNumeric(1n, 0));
    if (d.coef === 0n) return 0;
    return decimalWeight(d);
  }
  const x = Math.abs(numericToNumber(a));
  if (x === 0 || !Number.isFinite(x)) return 0;
  const lnd = Math.abs(Math.log(x));
  if (lnd === 0) return 0;
  return Math.trunc(Math.log10(lnd));
}

/** binary powering of a fixed-point value at scale S (rounds each step, like PG's mul_var chain) */
function fxPow(base: bigint, e: bigint, S: number): bigint {
  let result = pow10(S);
  let sq = base;
  let n = e;
  while (n > 0n) {
    if (n & 1n) result = fxMul(result, sq, S);
    n >>= 1n;
    if (n > 0n) sq = fxMul(sq, sq, S);
  }
  return result;
}

/** power for numeric with numeric result: ports PG's power_var/power_var_int in fixed point. */
export function numericPower(a: Numeric, b: Numeric): Numeric {
  if (a.special === "nan" || b.special === "nan") return NUMERIC_NAN;
  // integral exponent: power_var_int (exact or rounded binary powering)
  if (!a.special && !b.special && b.dscale === 0) {
    const e = b.coef;
    if (a.coef === 0n || e === 0n) {
      if (a.coef === 0n && e < 0n) {
        throw pgError("division_by_zero", "zero raised to a negative power is undefined");
      }
      const zscale = Math.min(Math.max(MIN_SIG_DIGITS, a.dscale), MAX_DISPLAY_SCALE);
      return makeNumeric(e === 0n ? pow10(zscale) : 0n, zscale);
    }
    const p = Math.log10(Math.abs(numericToNumber(a))) * Number(e);
    if (p > 131072) throw pgError("numeric_value_out_of_range", "value overflows numeric format");
    let rscale = MIN_SIG_DIGITS - Math.trunc(p);
    rscale = Math.max(rscale, a.dscale);
    rscale = Math.max(rscale, 0);
    rscale = Math.min(rscale, MAX_DISPLAY_SCALE);
    const negate = a.coef < 0n && ((e % 2n) + 2n) % 2n === 1n;
    const absCoef = a.coef < 0n ? -a.coef : a.coef;
    const absE = e < 0n ? -e : e;
    let coef: bigint;
    if (e > 0n && a.dscale * Number(e) <= rscale + 32 && p < 4000) {
      // exact bigint power, then round to the display scale
      let exact = 1n;
      let sq = absCoef;
      let n = absE;
      while (n > 0n) {
        if (n & 1n) exact *= sq;
        n >>= 1n;
        if (n > 0n) sq *= sq;
      }
      coef = roundToScale(exact, a.dscale * Number(e), rscale);
    } else {
      const ws = rscale + Math.max(0, Math.ceil(Math.abs(p))) + FX_GUARD;
      const pow = fxPow(fxFrom(makeNumeric(absCoef, a.dscale), ws), absE, ws);
      const r = e < 0n ? fxDiv(pow10(ws), pow, ws) : pow;
      coef = roundToScale(r, ws, rscale);
    }
    return makeNumeric(negate ? -coef : coef, rscale);
  }
  const av = numericToNumber(a);
  const bv = numericToNumber(b);
  if (av === 0 && bv < 0) throw pgError("division_by_zero", "zero raised to a negative power is undefined");
  if (av < 0 && !Number.isInteger(bv)) {
    throw pgError("invalid_parameter_value", "a negative number raised to a non-integer power yields a complex result");
  }
  if (a.special || b.special) {
    const r = av ** bv;
    if (Number.isNaN(r)) return NUMERIC_NAN;
    if (r === Number.POSITIVE_INFINITY) return NUMERIC_PINF;
    if (r === Number.NEGATIVE_INFINITY) return NUMERIC_NINF;
    return numericFromNumber(r);
  }
  if (a.coef === 0n) {
    // 0 ^ positive-non-integer = 0 with the default sig-digit scale
    return makeNumeric(0n, MIN_SIG_DIGITS);
  }
  // negative base with integral exponent: sign from exponent parity
  let base = a;
  let negate = false;
  if (a.coef < 0n) {
    base = makeNumeric(-a.coef, a.dscale);
    const ipart = numericRescale(b, 0);
    negate = ((ipart.coef % 2n) + 2n) % 2n === 1n;
  }
  // result decimal-weight estimate → display scale, as PG power_var does
  const p = Math.log(Math.abs(numericToNumber(base))) * bv * PG_LOG10E;
  if (p > 131072) throw pgError("numeric_value_out_of_range", "value overflows numeric format");
  let rscale = MIN_SIG_DIGITS - Math.trunc(p);
  rscale = Math.max(rscale, a.dscale);
  rscale = Math.max(rscale, b.dscale);
  rscale = Math.max(rscale, 0);
  rscale = Math.min(rscale, MAX_DISPLAY_SCALE);
  const ws = rscale + Math.max(0, Math.ceil(p)) + FX_GUARD;
  const lnBase = fxLn(fxFrom(base, ws), ws);
  const arg = fxMul(lnBase, fxFrom(b, ws), ws);
  const r = fxExp(arg, ws);
  const coef = roundToScale(negate ? -r : r, ws, rscale);
  return makeNumeric(coef, rscale);
}

/** exp(numeric) in fixed point with PG's exp_var display-scale rule. */
export function numericExp(a: Numeric): Numeric {
  if (a.special === "nan") return NUMERIC_NAN;
  if (a.special === "inf") return NUMERIC_PINF;
  if (a.special === "-inf") return makeNumeric(0n, 16);
  const xv = numericToNumber(a);
  const p = xv * PG_LOG10E;
  if (p > 131072) throw pgError("numeric_value_out_of_range", "value overflows numeric format");
  let rscale = MIN_SIG_DIGITS - Math.trunc(p);
  rscale = Math.max(rscale, a.dscale);
  rscale = Math.max(rscale, 0);
  rscale = Math.min(rscale, MAX_DISPLAY_SCALE);
  const ws = rscale + Math.max(0, Math.ceil(p)) + FX_GUARD;
  const r = fxExp(fxFrom(a, ws), ws);
  return makeNumeric(roundToScale(r, ws, rscale), rscale);
}

function lnRscale(a: Numeric): number {
  let rscale = MIN_SIG_DIGITS - estimateLnDweight(a);
  rscale = Math.max(rscale, a.dscale);
  rscale = Math.max(rscale, 0);
  return Math.min(rscale, MAX_DISPLAY_SCALE);
}

function checkLnArg(a: Numeric): void {
  const s = numericSign(a);
  if (s === 0) throw pgError("invalid_parameter_value", "cannot take logarithm of zero");
  if (s < 0) throw pgError("invalid_parameter_value", "cannot take logarithm of a negative number");
}

/** ln(numeric) in fixed point with PG's numeric_ln display-scale rule. */
export function numericLn(a: Numeric): Numeric {
  if (a.special === "nan") return NUMERIC_NAN;
  if (a.special === "-inf") throw pgError("invalid_parameter_value", "cannot take logarithm of a negative number");
  if (a.special === "inf") return NUMERIC_PINF;
  checkLnArg(a);
  const rscale = lnRscale(a);
  const ws = rscale + FX_GUARD;
  const r = fxLn(fxFrom(a, ws), ws);
  return makeNumeric(roundToScale(r, ws, rscale), rscale);
}

/** log(base, x) = ln(x)/ln(base) in fixed point with PG's log_var scale rule. */
export function numericLogBase(base: Numeric, x: Numeric): Numeric {
  if (base.special === "nan" || x.special === "nan") return NUMERIC_NAN;
  if (x.special === "-inf" || base.special === "-inf") {
    throw pgError("invalid_parameter_value", "cannot take logarithm of a negative number");
  }
  if (x.special === "inf" || base.special === "inf") {
    // ln(inf)/ln(b) etc — mirror float behavior for the special grid
    const r = Math.log(numericToNumber(x)) / Math.log(numericToNumber(base));
    return numericFromNumber(r);
  }
  checkLnArg(x);
  checkLnArg(base);
  let rscale = MIN_SIG_DIGITS - (estimateLnDweight(x) - estimateLnDweight(base));
  rscale = Math.max(rscale, base.dscale);
  rscale = Math.max(rscale, x.dscale);
  rscale = Math.max(rscale, 0);
  rscale = Math.min(rscale, MAX_DISPLAY_SCALE);
  const ws = rscale + FX_GUARD;
  const r = fxDiv(fxLn(fxFrom(x, ws), ws), fxLn(fxFrom(base, ws), ws), ws);
  return makeNumeric(roundToScale(r, ws, rscale), rscale);
}

/** log10(numeric) in fixed point. */
export function numericLog10(a: Numeric): Numeric {
  if (a.special === "nan") return NUMERIC_NAN;
  if (a.special === "-inf") throw pgError("invalid_parameter_value", "cannot take logarithm of a negative number");
  if (a.special === "inf") return NUMERIC_PINF;
  checkLnArg(a);
  return numericLogBase(makeNumeric(10n, 0), a);
}

/** Apply numeric(precision, scale) typmod constraint. */
export function applyNumericTypmod(v: Numeric, precision: number, scale: number): Numeric {
  if (v.special) {
    if (v.special === "nan") return v;
    throw pgError("numeric_value_out_of_range", `numeric field overflow`);
  }
  const rescaled = numericRescale(v, scale);
  const abs = rescaled.coef < 0n ? -rescaled.coef : rescaled.coef;
  const maxIntDigits = precision - scale;
  const intDigits = abs === 0n ? 0 : Math.max(abs.toString().length - scale, 0);
  if (intDigits > maxIntDigits) {
    throw pgError("numeric_value_out_of_range", `numeric field overflow`);
  }
  return rescaled;
}

/** Strip trailing fractional zeros (used by jsonb number canonicalization is NOT this; PG keeps scale). */
export function numericStripTrailingZeros(v: Numeric): Numeric {
  if (v.special || v.dscale === 0) return v;
  let coef = v.coef;
  let scale = v.dscale;
  while (scale > 0 && coef % 10n === 0n) {
    coef /= 10n;
    scale -= 1;
  }
  return makeNumeric(coef, scale);
}
