import { pgError } from "../errors/error.ts";
import { type Interval, intervalCmp } from "./datetime.ts";
import { jsonbCompare } from "./jsonb.ts";
import { networkCompare } from "./network.ts";
import { isNumeric, type Numeric, numericCmp, numericStripTrailingZeros, numericText } from "./numeric.ts";
import { type PgRange, rangeCompare, rangeKey } from "./range.ts";
import { isRangeType } from "./range-types.ts";
import { isMultirangeType, multirangeCompare, multirangeKey, type PgMultirange } from "./multirange.ts";
import {
  arrayElemType,
  byteaText,
  type Datum,
  isArrayType,
  isCompositeType,
  isEnumType,
  type JsonbWrap,
  type PgArray,
  type PgRecord,
  type TypeId,
  tidCompare,
} from "./value.ts";
import { vectorCompare, vectorKey } from "./vector.ts";

/**
 * Total order for non-null datums of the same type. Text uses C-locale
 * (code point) ordering — the engine's pinned collation.
 *
 * Enum ordering needs label positions; callers pass `enumOrder`.
 */
export interface CompareCtx {
  enumOrder?(enumType: TypeId, label: string): number;
}

export const DEFAULT_COMPARE_CTX: CompareCtx = {};

function expectNumber(a: Datum, t: TypeId): number {
  if (typeof a !== "number") throw pgError("internal", `invalid ${t} datum for comparison`, "XX000");
  return a;
}

function expectBigint(a: Datum, t: TypeId): bigint {
  if (typeof a !== "bigint") throw pgError("internal", `invalid ${t} datum for comparison`, "XX000");
  return a;
}

export function datumCompare(t: TypeId, a: Datum, b: Datum, ctx: CompareCtx = DEFAULT_COMPARE_CTX): number {
  if (a === null || b === null) throw pgError("internal", "datumCompare called with null");
  if (isArrayType(t)) return arrayCompare(t, a as PgArray, b as PgArray, ctx);
  if (isRangeType(t)) return rangeCompare(t, a as PgRange, b as PgRange, ctx);
  if (isCompositeType(t)) return recordCompare(a as PgRecord, b as PgRecord, ctx);
  if (isMultirangeType(t)) return multirangeCompare(t, a as PgMultirange, b as PgMultirange, ctx);
  if (isEnumType(t)) {
    if (!ctx.enumOrder) return cmpString(a as string, b as string);
    return ctx.enumOrder(t, a as string) - ctx.enumOrder(t, b as string);
  }
  switch (t) {
    case "bool":
      return a === b ? 0 : a ? 1 : -1;
    case "int2":
    case "int4":
    case "oid":
    case "regclass":
    case "xid":
    case "regnamespace":
    case "date":
      return expectNumber(a, t) - expectNumber(b, t);
    case "float4":
    case "float8": {
      // NaN sorts last (greater than everything), like PG
      const fa = a as number;
      const fb = b as number;
      const na = Number.isNaN(fa);
      const nb = Number.isNaN(fb);
      if (na || nb) return na && nb ? 0 : na ? 1 : -1;
      return fa < fb ? -1 : fa > fb ? 1 : 0;
    }
    case "int8":
    case "money":
    case "timestamp":
    case "timestamptz":
    case "time": {
      const ba = expectBigint(a, t);
      const bb = expectBigint(b, t);
      return ba < bb ? -1 : ba > bb ? 1 : 0;
    }
    case "numeric":
      return numericCmp(a as Numeric, b as Numeric);
    case "text":
    case "varchar":
    case "bpchar":
    case "name":
    case "unknown":
    case "uuid":
    // regtype / regproc keep their canonical name: one name per type or function
    case "regtype":
    case "regproc":
    case "tsvector":
    case "tsquery":
    case "bit":
    case "varbit":
    case "macaddr":
      return cmpString(a as string, b as string);
    case "inet":
    case "cidr":
      return networkCompare(a as string, b as string);
    case "tid":
      return tidCompare(a as string, b as string);
    case "bytea": {
      const ba = a as Uint8Array;
      const bb = b as Uint8Array;
      const n = Math.min(ba.length, bb.length);
      for (let i = 0; i < n; i++) {
        if (ba[i]! !== bb[i]!) return ba[i]! < bb[i]! ? -1 : 1;
      }
      return ba.length - bb.length;
    }
    case "vector":
      return vectorCompare(a, b);
    case "interval":
      return intervalCmp(a as Interval, b as Interval);
    case "jsonb":
      return jsonbCompare((a as JsonbWrap).value, (b as JsonbWrap).value);
    case "json":
      throw pgError("undefined_function", "could not identify an equality operator for type json");
    case "record":
      return recordCompare(a as PgRecord, b as PgRecord, ctx);
    default:
      throw pgError("undefined_function", `could not identify an ordering operator for type ${t}`);
  }
}

/**
 * C-locale text order: the order of the strings' UTF-8 bytes, which is code point order. Equal to
 * comparing `new TextEncoder().encode()` of each byte by byte (a lone surrogate encodes as U+FFFD),
 * including the result's magnitude (`±1` at a difference, the byte-length difference for a prefix),
 * without encoding: the common prefix is skipped by UTF-16 code unit, then code points are compared.
 */
export function cmpString(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  // A shared high surrogate pairs (or not) with the unit after it, which differs: decode from there.
  if (i > 0 && isHighSurrogate(a.charCodeAt(i - 1))) i--;
  let j = i;
  while (i < a.length && j < b.length) {
    const ca = codePointAt(a, i);
    const cb = codePointAt(b, j);
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  return utf8Length(a, i) - utf8Length(b, j);
}

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;

/** The code point at `i` as UTF-8 encodes it: a lone surrogate is U+FFFD. */
function codePointAt(s: string, i: number): number {
  const unit = s.charCodeAt(i);
  if (unit < 0xd800 || unit > 0xdfff) return unit;
  if (unit <= 0xdbff && i + 1 < s.length) {
    const low = s.charCodeAt(i + 1);
    if (low >= 0xdc00 && low <= 0xdfff) return ((unit - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
  }
  return 0xfffd;
}

/** UTF-8 byte length of `s` from code unit `from`. */
function utf8Length(s: string, from: number): number {
  let bytes = 0;
  for (let i = from; i < s.length; ) {
    const cp = codePointAt(s, i);
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp <= 0xffff ? 3 : 4;
    i += cp > 0xffff ? 2 : 1;
  }
  return bytes;
}

function arrayCompare(t: TypeId, a: PgArray, b: PgArray, ctx: CompareCtx): number {
  const elem = arrayElemType(t);
  const n = Math.min(a.items.length, b.items.length);
  for (let i = 0; i < n; i++) {
    const av = a.items[i]!;
    const bv = b.items[i]!;
    if (av === null && bv === null) continue;
    // PG array comparison sorts NULLs last within elements
    if (av === null) return 1;
    if (bv === null) return -1;
    const c = datumCompare(elem, av, bv, ctx);
    if (c !== 0) return c;
  }
  if (a.items.length !== b.items.length) return a.items.length - b.items.length;
  // equal contents; compare dims
  for (let i = 0; i < Math.min(a.dims.length, b.dims.length); i++) {
    if (a.dims[i]! !== b.dims[i]!) return a.dims[i]! - b.dims[i]!;
  }
  return a.dims.length - b.dims.length;
}

function recordCompare(a: PgRecord, b: PgRecord, ctx: CompareCtx): number {
  const n = Math.min(a.values.length, b.values.length);
  for (let i = 0; i < n; i++) {
    const av = a.values[i]!;
    const bv = b.values[i]!;
    if (av === null && bv === null) continue;
    if (av === null) return 1;
    if (bv === null) return -1;
    const c = datumCompare(a.types[i] ?? "text", av, bv, ctx);
    if (c !== 0) return c;
  }
  if (a.values.length !== b.values.length) {
    throw pgError("datatype_mismatch", "cannot compare record types with different numbers of columns");
  }
  return 0;
}

export function datumEquals(t: TypeId, a: Datum, b: Datum, ctx: CompareCtx = DEFAULT_COMPARE_CTX): boolean {
  return datumCompare(t, a, b, ctx) === 0;
}

/**
 * Canonical grouping/uniqueness key. Equal values (2.50 = 2.5, +0 = -0)
 * must map to the same key.
 */
export function datumKey(t: TypeId, v: Datum): string {
  if (v === null) return "\u0000N";
  if (isArrayType(t)) {
    const arr = v as PgArray;
    return `A[${arr.dims.join(",")}]${arr.items.map((it) => (it === null ? "\u0000N" : datumKey(arrayElemType(t), it))).join("\u0001")}`;
  }
  if (isEnumType(t)) return `E${v as string}`;
  if (isRangeType(t)) return rangeKey(t, v as PgRange);
  if (isCompositeType(t)) return datumKey("record", v);
  if (isMultirangeType(t)) return multirangeKey(t, v as PgMultirange);
  switch (t) {
    case "bool":
      return v ? "t" : "f";
    case "int2":
    case "int4":
    case "oid":
    case "regclass":
    case "xid":
    case "date":
      return `i${v}`;
    case "float4":
    case "float8": {
      const f = v as number;
      if (Number.isNaN(f)) return "fNaN";
      if (f === 0) return "f0";
      return `f${f}`;
    }
    case "int8":
    case "money":
    case "timestamp":
    case "timestamptz":
    case "time":
      return `i${v}`;
    case "numeric": {
      const n = numericStripTrailingZeros(v as Numeric);
      return `n${numericText(n)}`;
    }
    case "text":
    case "varchar":
    case "bpchar":
    case "name":
    case "unknown":
    case "uuid":
    case "regtype":
    case "regproc":
    case "json":
    case "tsvector":
    case "tsquery":
    case "bit":
    case "varbit":
    case "inet":
    case "cidr":
    case "macaddr":
    case "tid":
      return `s${v}`;
    case "vector":
      return `s${vectorKey(v)}`;
    case "bytea":
      return `b${byteaText(v as Uint8Array)}`;
    case "interval": {
      const iv = v as Interval;
      // equal intervals (1 mon vs 30 days) compare equal in PG
      return `v${(BigInt(iv.months) * 30n + BigInt(iv.days)) * 86_400_000_000n + iv.micros}`;
    }
    case "jsonb":
      return `j${jsonbKeyText(v as JsonbWrap)}`;
    case "record": {
      const r = v as PgRecord;
      return `r(${r.values.map((val, i) => (val === null ? "\u0000N" : datumKey(r.types[i] ?? "text", val))).join("\u0001")})`;
    }
    default:
      if (isNumeric(v)) return `n${numericText(numericStripTrailingZeros(v))}`;
      return `s${String(v)}`;
  }
}

function jsonbKeyText(w: JsonbWrap): string {
  // canonical text is already normalized (sorted keys, canonical numbers)
  return JSON.stringify(canonicalJsonb(w.value));
}

function canonicalJsonb(v: import("./jsonb.ts").JsonbValue): unknown {
  switch (v.j) {
    case "null":
      return null;
    case "bool":
      return v.v;
    case "num":
      return numericText(numericStripTrailingZeros(v.v));
    case "str":
      return `s${v.v}`;
    case "arr":
      return v.v.map(canonicalJsonb);
    case "obj": {
      const keys = [...v.v.keys()].sort();
      return keys.map((k) => [k, canonicalJsonb(v.v.get(k)!)]);
    }
  }
}
