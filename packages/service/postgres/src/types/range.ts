import { pgError } from "../errors/error.ts";
import { type CompareCtx, DEFAULT_COMPARE_CTX, datumCompare, datumKey } from "./compare.ts";
import { DATE_NEG_INF, DATE_POS_INF } from "./datetime.ts";
import { RANGE_SUBTYPES } from "./range-types.ts";
import { checkInt4, checkInt8, type Datum, datumFromText, datumText, type InputCtx, type OutputCtx } from "./value.ts";

/**
 * The built-in range types (https://www.postgresql.org/docs/18/rangetypes.html): `int4range`,
 * `int8range`, `numrange`, `daterange`, `tsrange`, `tstzrange`. A datum is always canonical
 * (discrete ranges are stored `[lower,upper)`), so structural equality is range equality.
 * Multiranges are not modelled.
 */
export interface PgRange {
  readonly kind: "pgrange";
  readonly empty: boolean;
  /** null when the bound is infinite (unbounded) */
  readonly lower: Datum;
  readonly upper: Datum;
  readonly lowerInc: boolean;
  readonly upperInc: boolean;
}

export { isRangeType, RANGE_ARRAY_OIDS, RANGE_SUBTYPES, RANGE_TYPE_OIDS } from "./range-types.ts";

export function rangeSubtype(t: string): string {
  const sub = RANGE_SUBTYPES[t];
  if (sub === undefined) throw pgError("internal", `not a range type: ${t}`, "XX000");
  return sub;
}

export function isPgRange(v: unknown): v is PgRange {
  return typeof v === "object" && v !== null && (v as PgRange).kind === "pgrange";
}

export const EMPTY_RANGE: PgRange = {
  kind: "pgrange",
  empty: true,
  lower: null,
  upper: null,
  lowerInc: false,
  upperInc: false,
};

// --- bounds -----------------------------------------------------------------------

/** One side of a range, the shape PostgreSQL's range_cmp_bounds works on. */
interface Bound {
  readonly val: Datum;
  readonly inf: boolean;
  readonly inc: boolean;
  readonly lower: boolean;
}

const lowerBound = (r: PgRange): Bound => ({ val: r.lower, inf: r.lower === null, inc: r.lowerInc, lower: true });
const upperBound = (r: PgRange): Bound => ({ val: r.upper, inf: r.upper === null, inc: r.upperInc, lower: false });

function cmpValues(sub: string, a: Datum, b: Datum, ctx: CompareCtx): number {
  return Math.sign(datumCompare(sub, a, b, ctx));
}

/** range_cmp_bounds: orders bounds, an exclusive lower bound sorting after an inclusive one on the same value. */
function cmpBounds(sub: string, b1: Bound, b2: Bound, ctx: CompareCtx): number {
  if (b1.inf && b2.inf) return b1.lower === b2.lower ? 0 : b1.lower ? -1 : 1;
  if (b1.inf) return b1.lower ? -1 : 1;
  if (b2.inf) return b2.lower ? 1 : -1;
  const result = cmpValues(sub, b1.val, b2.val, ctx);
  if (result !== 0) return result;
  if (!b1.inc && !b2.inc) return b1.lower === b2.lower ? 0 : b1.lower ? 1 : -1;
  if (!b1.inc) return b1.lower ? 1 : -1;
  if (!b2.inc) return b2.lower ? -1 : 1;
  return 0;
}

// --- construction -------------------------------------------------------------------

function stepDiscrete(sub: string, v: Datum): Datum {
  switch (sub) {
    case "int4":
      return checkInt4((v as number) + 1);
    case "int8":
      return checkInt8((v as bigint) + 1n);
    case "date":
      return (v as number) + 1;
    default:
      return v;
  }
}

const isDiscrete = (sub: string): boolean => sub === "int4" || sub === "int8" || sub === "date";

/** make_range: validate the bounds, then canonicalize discrete ranges to `[lower,upper)`. */
export function makeRange(
  rangeType: string,
  lower: Datum,
  upper: Datum,
  lowerInc: boolean,
  upperInc: boolean,
  ctx: CompareCtx = DEFAULT_COMPARE_CTX,
): PgRange {
  const sub = rangeSubtype(rangeType);
  let li = lower === null ? false : lowerInc;
  let ui = upper === null ? false : upperInc;
  if (lower !== null && upper !== null) {
    const c = cmpValues(sub, lower, upper, ctx);
    if (c > 0) {
      throw pgError("data_exception", "range lower bound must be less than or equal to range upper bound", "22000");
    }
    if (c === 0 && !(li && ui)) return EMPTY_RANGE;
  }
  let lo = lower;
  let hi = upper;
  if (isDiscrete(sub)) {
    // daterange_canonical leaves an infinite date bound as written
    const finite = (v: Datum): boolean => sub !== "date" || (v !== DATE_POS_INF && v !== DATE_NEG_INF);
    if (lo !== null && !li && finite(lo)) {
      lo = stepDiscrete(sub, lo);
      li = true;
    }
    if (hi !== null && ui && finite(hi)) {
      hi = stepDiscrete(sub, hi);
      ui = false;
    }
    if (lo !== null && hi !== null && cmpValues(sub, lo, hi, ctx) === 0 && !(li && ui)) return EMPTY_RANGE;
  }
  return { kind: "pgrange", empty: false, lower: lo, upper: hi, lowerInc: li, upperInc: ui };
}

function fromBounds(rangeType: string, lo: Bound, hi: Bound, ctx: CompareCtx): PgRange {
  return makeRange(rangeType, lo.inf ? null : lo.val, hi.inf ? null : hi.val, lo.inc, hi.inc, ctx);
}

/** The third argument of a range constructor (`'[)'`, `'(]'`, …). */
export function parseRangeFlags(flags: string): { lowerInc: boolean; upperInc: boolean } {
  if (flags.length !== 2 || (flags[0] !== "[" && flags[0] !== "(") || (flags[1] !== "]" && flags[1] !== ")")) {
    throw pgError("syntax", "invalid range bound flags", "42601");
  }
  return { lowerInc: flags[0] === "[", upperInc: flags[1] === "]" };
}

// --- text I/O ---------------------------------------------------------------------

/** `detail` is PostgreSQL's DETAIL line; the engine's errors carry only the message. */
function malformed(text: string, _detail: string): never {
  throw pgError("invalid_text_representation", `malformed range literal: "${text}"`, "22P02");
}

/** range_parse_bound: an unquoted empty bound is infinite; quotes and backslashes escape. */
function parseBoundText(text: string, pos: number): { value: string | null; pos: number } {
  const delimiter = (ch: string | undefined): boolean => ch === "," || ch === ")" || ch === "]";
  if (delimiter(text[pos])) return { value: null, pos };
  let out = "";
  let inQuote = false;
  while (pos < text.length && (inQuote || !delimiter(text[pos]))) {
    const ch = text[pos]!;
    if (ch === "\\") {
      pos++;
      if (pos >= text.length) malformed(text, "Unexpected end of input.");
      out += text[pos]!;
    } else if (ch === '"') {
      if (!inQuote) inQuote = true;
      else if (text[pos + 1] === '"') {
        out += '"';
        pos++;
      } else inQuote = false;
    } else out += ch;
    pos++;
  }
  if (pos >= text.length) malformed(text, "Unexpected end of input.");
  return { value: out, pos };
}

export function parseRangeText(rangeType: string, text: string, ctx: InputCtx & CompareCtx): PgRange {
  const sub = rangeSubtype(rangeType);
  let pos = 0;
  while (pos < text.length && /\s/.test(text[pos]!)) pos++;
  if (text.slice(pos, pos + 5).toLowerCase() === "empty") {
    pos += 5;
    while (pos < text.length && /\s/.test(text[pos]!)) pos++;
    if (pos !== text.length) malformed(text, "Junk after closing right brace.");
    return EMPTY_RANGE;
  }
  const open = text[pos];
  if (open !== "[" && open !== "(") malformed(text, "Missing left parenthesis or bracket.");
  pos++;
  const lo = parseBoundText(text, pos);
  pos = lo.pos;
  if (text[pos] !== ",") malformed(text, "Missing comma after lower bound.");
  pos++;
  const hi = parseBoundText(text, pos);
  pos = hi.pos;
  const close = text[pos];
  if (close !== "]" && close !== ")") malformed(text, "Too many commas.");
  pos++;
  while (pos < text.length && /\s/.test(text[pos]!)) pos++;
  if (pos !== text.length) malformed(text, "Junk after right parenthesis or bracket.");
  const lower = lo.value === null ? null : datumFromText(sub, lo.value, ctx);
  const upper = hi.value === null ? null : datumFromText(sub, hi.value, ctx);
  return makeRange(rangeType, lower, upper, open === "[", close === "]", ctx);
}

function quoteBound(s: string): string {
  if (s !== "" && !/[\s"\\(),[\]]/.test(s)) return s;
  let out = '"';
  for (const ch of s) out += ch === '"' || ch === "\\" ? ch + ch : ch;
  return `${out}"`;
}

export function rangeText(rangeType: string, r: PgRange, ctx: OutputCtx): string {
  if (r.empty) return "empty";
  const sub = rangeSubtype(rangeType);
  const lo = r.lower === null ? "" : quoteBound(datumText(sub, r.lower, ctx));
  const hi = r.upper === null ? "" : quoteBound(datumText(sub, r.upper, ctx));
  return `${r.lowerInc ? "[" : "("}${lo},${hi}${r.upperInc ? "]" : ")"}`;
}

/** Grouping / uniqueness key: canonical ranges with equal bounds share it. */
export function rangeKey(rangeType: string, r: PgRange): string {
  if (r.empty) return "Rempty";
  const sub = rangeSubtype(rangeType);
  const lo = r.lower === null ? "-inf" : datumKey(sub, r.lower);
  const hi = r.upper === null ? "+inf" : datumKey(sub, r.upper);
  return `R${r.lowerInc ? "[" : "("}${lo}\u0001${hi}${r.upperInc ? "]" : ")"}`;
}

// --- comparison and operators -----------------------------------------------------

/** range_cmp: empty sorts first, then by lower bound, then by upper bound. */
export function rangeCompare(rangeType: string, a: PgRange, b: PgRange, ctx: CompareCtx = DEFAULT_COMPARE_CTX): number {
  if (a.empty || b.empty) return a.empty && b.empty ? 0 : a.empty ? -1 : 1;
  const sub = rangeSubtype(rangeType);
  const c = cmpBounds(sub, lowerBound(a), lowerBound(b), ctx);
  return c !== 0 ? c : cmpBounds(sub, upperBound(a), upperBound(b), ctx);
}

export function rangeOverlaps(t: string, a: PgRange, b: PgRange, ctx: CompareCtx): boolean {
  if (a.empty || b.empty) return false;
  const sub = rangeSubtype(t);
  const [l1, u1, l2, u2] = [lowerBound(a), upperBound(a), lowerBound(b), upperBound(b)];
  if (cmpBounds(sub, l1, l2, ctx) >= 0 && cmpBounds(sub, l1, u2, ctx) <= 0) return true;
  return cmpBounds(sub, l2, l1, ctx) >= 0 && cmpBounds(sub, l2, u1, ctx) <= 0;
}

export function rangeContains(t: string, a: PgRange, b: PgRange, ctx: CompareCtx): boolean {
  if (b.empty) return true;
  if (a.empty) return false;
  const sub = rangeSubtype(t);
  if (cmpBounds(sub, lowerBound(a), lowerBound(b), ctx) > 0) return false;
  return cmpBounds(sub, upperBound(a), upperBound(b), ctx) >= 0;
}

export function rangeContainsElem(t: string, r: PgRange, v: Datum, ctx: CompareCtx): boolean {
  if (r.empty) return false;
  const sub = rangeSubtype(t);
  if (r.lower !== null) {
    const c = cmpValues(sub, r.lower, v, ctx);
    if (c > 0 || (c === 0 && !r.lowerInc)) return false;
  }
  if (r.upper !== null) {
    const c = cmpValues(sub, r.upper, v, ctx);
    if (c < 0 || (c === 0 && !r.upperInc)) return false;
  }
  return true;
}

/** `<<`: every point of a is below every point of b. */
export function rangeBefore(t: string, a: PgRange, b: PgRange, ctx: CompareCtx): boolean {
  if (a.empty || b.empty) return false;
  return cmpBounds(rangeSubtype(t), upperBound(a), lowerBound(b), ctx) < 0;
}

/** `&<`: a does not extend to the right of b. */
export function rangeOverLeft(t: string, a: PgRange, b: PgRange, ctx: CompareCtx): boolean {
  if (a.empty || b.empty) return false;
  return cmpBounds(rangeSubtype(t), upperBound(a), upperBound(b), ctx) <= 0;
}

/** `&>`: a does not extend to the left of b. */
export function rangeOverRight(t: string, a: PgRange, b: PgRange, ctx: CompareCtx): boolean {
  if (a.empty || b.empty) return false;
  return cmpBounds(rangeSubtype(t), lowerBound(a), lowerBound(b), ctx) >= 0;
}

/** bounds_adjacent: no point lies between an upper bound and a following lower bound. */
function boundsAdjacent(t: string, upper: Bound, lower: Bound, ctx: CompareCtx): boolean {
  const sub = rangeSubtype(t);
  if (upper.inf || lower.inf) return false;
  const c = cmpValues(sub, upper.val, lower.val, ctx);
  if (c < 0) {
    if (!isDiscrete(sub)) return false;
    // the range strictly between the two bounds is empty after canonicalization
    return makeRange(t, upper.val, lower.val, !upper.inc, !lower.inc, ctx).empty;
  }
  return c === 0 && upper.inc !== lower.inc;
}

/** `-|-` */
export function rangeAdjacent(t: string, a: PgRange, b: PgRange, ctx: CompareCtx): boolean {
  if (a.empty || b.empty) return false;
  return boundsAdjacent(t, upperBound(a), lowerBound(b), ctx) || boundsAdjacent(t, upperBound(b), lowerBound(a), ctx);
}

function minBound(sub: string, a: Bound, b: Bound, ctx: CompareCtx): Bound {
  return cmpBounds(sub, a, b, ctx) <= 0 ? a : b;
}
function maxBound(sub: string, a: Bound, b: Bound, ctx: CompareCtx): Bound {
  return cmpBounds(sub, a, b, ctx) >= 0 ? a : b;
}

/** `+` (strict: the inputs must overlap or touch) and range_merge (not strict). */
export function rangeUnion(t: string, a: PgRange, b: PgRange, strict: boolean, ctx: CompareCtx): PgRange {
  if (a.empty) return b;
  if (b.empty) return a;
  if (strict && !rangeOverlaps(t, a, b, ctx) && !rangeAdjacent(t, a, b, ctx)) {
    throw pgError("data_exception", "result of range union would not be contiguous", "22000");
  }
  const sub = rangeSubtype(t);
  return fromBounds(
    t,
    minBound(sub, lowerBound(a), lowerBound(b), ctx),
    maxBound(sub, upperBound(a), upperBound(b), ctx),
    ctx,
  );
}

/** `*` */
export function rangeIntersect(t: string, a: PgRange, b: PgRange, ctx: CompareCtx): PgRange {
  if (a.empty || b.empty || !rangeOverlaps(t, a, b, ctx)) return EMPTY_RANGE;
  const sub = rangeSubtype(t);
  return fromBounds(
    t,
    maxBound(sub, lowerBound(a), lowerBound(b), ctx),
    minBound(sub, upperBound(a), upperBound(b), ctx),
    ctx,
  );
}

/** `-` (range_minus_internal) */
export function rangeMinus(t: string, a: PgRange, b: PgRange, ctx: CompareCtx): PgRange {
  if (a.empty || b.empty) return a;
  const sub = rangeSubtype(t);
  const [l1, u1, l2, u2] = [lowerBound(a), upperBound(a), lowerBound(b), upperBound(b)];
  const cl1l2 = cmpBounds(sub, l1, l2, ctx);
  const cl1u2 = cmpBounds(sub, l1, u2, ctx);
  const cu1l2 = cmpBounds(sub, u1, l2, ctx);
  const cu1u2 = cmpBounds(sub, u1, u2, ctx);
  if (cl1l2 < 0 && cu1u2 > 0) {
    throw pgError("data_exception", "result of range difference would not be contiguous", "22000");
  }
  if (cl1u2 > 0 || cu1l2 < 0) return a;
  if (cl1l2 >= 0 && cu1u2 <= 0) return EMPTY_RANGE;
  if (cl1l2 <= 0 && cu1l2 >= 0 && cu1u2 <= 0) {
    return fromBounds(t, l1, { ...l2, inc: !l2.inc, lower: false }, ctx);
  }
  if (cl1l2 >= 0 && cu1u2 >= 0 && cl1u2 <= 0) {
    return fromBounds(t, { ...u2, inc: !u2.inc, lower: true }, u1, ctx);
  }
  throw pgError("internal", "unexpected case in range_minus", "XX000");
}
