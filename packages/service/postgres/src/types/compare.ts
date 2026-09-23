import { pgError } from "../errors/error.ts";
import { type Interval, intervalCmp } from "./datetime.ts";
import { jsonbCompare } from "./jsonb.ts";
import { isNumeric, type Numeric, numericCmp, numericStripTrailingZeros, numericText } from "./numeric.ts";
import {
  arrayElemType,
  byteaText,
  type Datum,
  isArrayType,
  isEnumType,
  type JsonbWrap,
  type PgArray,
  type PgRecord,
  type TypeId,
} from "./value.ts";

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
    case "tsvector":
    case "tsquery":
    case "bit":
    case "varbit":
      return cmpString(a as string, b as string);
    case "bytea": {
      const ba = a as Uint8Array;
      const bb = b as Uint8Array;
      const n = Math.min(ba.length, bb.length);
      for (let i = 0; i < n; i++) {
        if (ba[i]! !== bb[i]!) return ba[i]! < bb[i]! ? -1 : 1;
      }
      return ba.length - bb.length;
    }
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

/** C-locale: compare by code units of UTF-8 bytes. */
function cmpString(a: string, b: string): number {
  if (a === b) return 0;
  const ea = utf8(a);
  const eb = utf8(b);
  const n = Math.min(ea.length, eb.length);
  for (let i = 0; i < n; i++) {
    if (ea[i]! !== eb[i]!) return ea[i]! < eb[i]! ? -1 : 1;
  }
  return ea.length - eb.length;
}

const encoder = new TextEncoder();
function utf8(s: string): Uint8Array {
  return encoder.encode(s);
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
  switch (t) {
    case "bool":
      return v ? "t" : "f";
    case "int2":
    case "int4":
    case "oid":
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
    case "json":
    case "tsvector":
    case "tsquery":
    case "bit":
    case "varbit":
      return `s${v}`;
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
