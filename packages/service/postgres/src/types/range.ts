import { pgError } from "../errors/error.ts";

/** Canonical int4range datum (PG range type). */
export interface Int4Range {
  readonly kind: "int4range";
  readonly empty: boolean;
  readonly lower: number | null;
  readonly upper: number | null;
  readonly lowerInc: boolean;
  readonly upperInc: boolean;
}

export function emptyInt4Range(): Int4Range {
  return { kind: "int4range", empty: true, lower: null, upper: null, lowerInc: false, upperInc: false };
}

export function makeInt4Range(
  lower: number | null,
  upper: number | null,
  lowerInc: boolean,
  upperInc: boolean,
): Int4Range {
  if (lower !== null && upper !== null) {
    const lo = lowerInc ? lower : lower + 1;
    const hi = upperInc ? upper + 1 : upper;
    if (lo >= hi) return emptyInt4Range();
  }
  return { kind: "int4range", empty: false, lower, upper, lowerInc, upperInc };
}

function parseBound(text: string, side: "lower" | "upper"): { value: number | null; inc: boolean } {
  const t = text.trim();
  if (t === "") return { value: null, inc: side === "lower" };
  const m = /^(-?\d+)$/.exec(t);
  if (!m) throw pgError("invalid_text_representation", `invalid input syntax for type integer: "${t}"`);
  return { value: Number(m[1]), inc: side === "lower" };
}

/** typinput for int4range: `[1,10)`, `empty`, `(,)` unbounded. */
export function parseInt4RangeText(text: string): Int4Range {
  const raw = text.trim();
  if (raw.toLowerCase() === "empty") return emptyInt4Range();
  if (raw.length < 3) {
    throw pgError("invalid_text_representation", `malformed range literal: "${text}"`);
  }
  const open = raw[0]!;
  const close = raw[raw.length - 1]!;
  if ((open !== "[" && open !== "(") || (close !== "]" && close !== ")")) {
    throw pgError("invalid_text_representation", `malformed range literal: "${text}"`);
  }
  const inner = raw.slice(1, -1);
  const comma = inner.indexOf(",");
  if (comma === -1) {
    throw pgError("invalid_text_representation", `malformed range literal: "${text}"`);
  }
  const lo = parseBound(inner.slice(0, comma), "lower");
  const hi = parseBound(inner.slice(comma + 1), "upper");
  const lowerInc = open === "[";
  const upperInc = close === "]";
  const range = makeInt4Range(lo.value, hi.value, lowerInc, upperInc);
  if (range.empty && lo.value === null && hi.value === null && lowerInc && upperInc) {
    return emptyInt4Range();
  }
  return range;
}

export function int4RangeText(r: Int4Range): string {
  if (r.empty) return "empty";
  const open = r.lowerInc ? "[" : "(";
  const close = r.upperInc ? "]" : ")";
  const lo = r.lower === null ? "" : String(r.lower);
  const hi = r.upper === null ? "" : String(r.upper);
  return `${open}${lo},${hi}${close}`;
}

export function isInt4Range(v: unknown): v is Int4Range {
  return typeof v === "object" && v !== null && (v as Int4Range).kind === "int4range";
}

function pointInRange(r: Int4Range, n: number): boolean {
  if (r.empty) return false;
  if (r.lower !== null) {
    if (r.lowerInc ? n < r.lower : n <= r.lower) return false;
  }
  if (r.upper !== null) {
    if (r.upperInc ? n > r.upper : n >= r.upper) return false;
  }
  return true;
}

export function int4RangeContains(outer: Int4Range, inner: Int4Range | number): boolean {
  if (typeof inner === "number") return pointInRange(outer, inner);
  if (outer.empty) return inner.empty;
  if (inner.empty) return true;
  if (inner.lower !== null && !pointInRange(outer, inner.lower)) return false;
  if (inner.upper !== null && !pointInRange(outer, inner.upper)) return false;
  if (inner.lower !== null && inner.lowerInc && outer.lower !== null && inner.lower === outer.lower) {
    if (!outer.lowerInc) return false;
  }
  if (inner.upper !== null && inner.upperInc && outer.upper !== null && inner.upper === outer.upper) {
    if (!outer.upperInc) return false;
  }
  return true;
}

export function int4RangeOverlaps(a: Int4Range, b: Int4Range): boolean {
  if (a.empty || b.empty) return false;
  // a.lower < b.upper && b.lower < a.upper (with inclusivity)
  const aLo = a.lower ?? Number.MIN_SAFE_INTEGER;
  const aHi = a.upper ?? Number.MAX_SAFE_INTEGER;
  const bLo = b.lower ?? Number.MIN_SAFE_INTEGER;
  const bHi = b.upper ?? Number.MAX_SAFE_INTEGER;
  const aLoVal = a.lowerInc ? aLo : aLo + 1;
  const aHiVal = a.upperInc ? aHi + 1 : aHi;
  const bLoVal = b.lowerInc ? bLo : bLo + 1;
  const bHiVal = b.upperInc ? bHi + 1 : bHi;
  return aLoVal < bHiVal && bLoVal < aHiVal;
}
