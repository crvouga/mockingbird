import { sqliteAtoF } from "./sqlite-atof.ts";
import { formatRealAsTextSqlite } from "./sqlite-real-format.ts";

/** SQLite storage class of a {@link SqlValue} (`null` / `integer` / `real` / `text` / `blob`). */
export type StorageClass = "null" | "integer" | "real" | "text" | "blob";

/** Integer-valued REAL that must not collapse to the integer storage class. */
export class SqlReal {
  /** IEEE float payload (`-0` already canonicalized to `+0`). */
  readonly value: number;
  constructor(value: number) {
    this.value = canonicalizeNumber(value);
  }
  valueOf(): number {
    return this.value;
  }
  toString(): string {
    return String(this.value);
  }
}

/** SQLite JSON subtype (74 / 'J') — text that nested JSON APIs treat as JSON, not a string. */
export const JSON_SUBTYPE = 74;

/** TEXT value with SQLite JSON subtype 74 — nested JSON APIs treat it as JSON, not a string. */
export class SqlJsonText {
  readonly value: string;
  readonly subtype = JSON_SUBTYPE;
  constructor(value: string) {
    this.value = value;
  }
  valueOf(): string {
    return this.value;
  }
  toString(): string {
    return this.value;
  }
}

/** A SQLite value: NULL, integer/real, text, blob, or a typed REAL/JSON wrapper. */
export type SqlValue = null | number | bigint | string | Uint8Array | SqlReal | SqlJsonText;

/**
 * A value as it appears in query result rows.
 * {@link SqlReal} and {@link SqlJsonText} wrappers are unwrapped at the JS API surface.
 */
export type QueryValue = null | number | bigint | string | Uint8Array;

/** A result row keyed by column name. Duplicate SELECT names keep the last value. */
export type QueryRow = Record<string, QueryValue>;

/**
 * Values accepted by bind slots (`?`, `?NNN`, `:name`, `@name`, `$name`).
 * Booleans become integer 0/1; {@link ArrayBuffer} is copied as a BLOB.
 */
export type BindValue = SqlValue | boolean | ArrayBuffer;

/** Column type affinity from a declared type name (SQLite affinity rules). */
export type Affinity = "TEXT" | "NUMERIC" | "INTEGER" | "REAL" | "BLOB";

/** Canonicalize IEEE `-0` to `+0` for cross-runtime determinism. */
export function canonicalizeNumber(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

/** Wrap `value` as {@link SqlReal} so it stays REAL even when it is an integer. */
export function asSqlReal(value: number): SqlReal {
  return new SqlReal(value);
}

/** `true` when `value` is a {@link SqlReal} wrapper. */
export function isSqlReal(value: SqlValue): value is SqlReal {
  return value instanceof SqlReal;
}

/** `true` when `value` is a {@link SqlJsonText} wrapper. */
export function isSqlJsonText(value: SqlValue): value is SqlJsonText {
  return value instanceof SqlJsonText;
}

/** Wrap `value` as {@link SqlJsonText} (JSON subtype 74). */
export function asSqlJsonText(value: string): SqlJsonText {
  return new SqlJsonText(value);
}

/** Strip ephemeral JSON subtype for table storage / non-JSON contexts. */
export function unwrapSqlValue(value: SqlValue): SqlValue {
  if (value instanceof SqlJsonText) return value.value;
  return value;
}

export function subtypeOf(value: SqlValue): number {
  if (value instanceof SqlJsonText) return JSON_SUBTYPE;
  return 0;
}

export function numberValueOf(value: number | bigint | SqlReal): number {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof SqlReal) return value.value;
  return value;
}

/** SQLite storage class of `value` (`null` / `integer` / `real` / `text` / `blob`). */
export function storageClassOf(value: SqlValue): StorageClass {
  if (value === null) return "null";
  if (value instanceof SqlReal) return "real";
  if (value instanceof SqlJsonText) return "text";
  if (typeof value === "bigint") return "integer";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "real";
  }
  if (typeof value === "string") return "text";
  return "blob";
}

/** SQLite `typeof()` string for `value`. */
export function typeofSql(value: SqlValue): string {
  const sc = storageClassOf(value);
  if (sc === "null") return "null";
  if (sc === "integer") return "integer";
  if (sc === "real") return "real";
  if (sc === "text") return "text";
  return "blob";
}

/** Determine column affinity from a declared type name (SQLite rules). */
export function affinityFromTypeName(typeName: string | null | undefined): Affinity {
  if (!typeName) return "BLOB";
  const t = typeName.toUpperCase();
  if (t.includes("INT")) return "INTEGER";
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return "TEXT";
  if (t.includes("BLOB")) return "BLOB";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return "REAL";
  return "NUMERIC";
}

/** Apply column {@link Affinity} conversion rules to `value`. */
export function applyAffinity(value: SqlValue, affinity: Affinity): SqlValue {
  if (value === null) return null;

  switch (affinity) {
    case "TEXT":
      // BLOB and TEXT are not converted under TEXT affinity (SQLite rules).
      if (value instanceof Uint8Array) return value;
      if (value instanceof SqlJsonText) return value.value;
      if (typeof value === "string") return value;
      if (value instanceof SqlReal) return formatRealAsText(value.value);
      if (typeof value === "number") return String(canonicalizeNumber(value));
      if (typeof value === "bigint") return value.toString();
      return String(value);
    case "INTEGER": {
      if (value instanceof Uint8Array) return value;
      const n = coerceToNumber(value);
      if (n === null) return value;
      if (typeof value === "bigint") return value;
      return Number.isInteger(n) && Number.isSafeInteger(n) ? Math.trunc(n) : canonicalizeNumber(n);
    }
    case "REAL": {
      if (value instanceof Uint8Array) return value;
      const n = coerceToNumber(value);
      return n === null ? value : asSqlReal(n);
    }
    case "NUMERIC": {
      if (value instanceof Uint8Array) return value;
      const n = coerceToNumber(value);
      if (n === null) return value;
      if (Number.isInteger(n) && Number.isSafeInteger(n)) return Math.trunc(n);
      return canonicalizeNumber(n);
    }
    case "BLOB":
      // BLOB affinity never converts storage classes.
      return value;
  }
}

/** Format a REAL for TEXT affinity / CAST AS TEXT (SQLite `%!.15g`). */
export function formatRealAsText(value: number): string {
  return formatRealAsTextSqlite(canonicalizeNumber(value));
}

/**
 * Apply SQLite comparison affinity rules before comparing two values.
 * A null affinity represents an expression with no affinity.
 */
export function applyComparisonAffinity(
  left: SqlValue,
  right: SqlValue,
  leftAffinity: Affinity | null,
  rightAffinity: Affinity | null,
): [SqlValue, SqlValue] {
  const leftNumeric = leftAffinity === "INTEGER" || leftAffinity === "REAL" || leftAffinity === "NUMERIC";
  const rightNumeric = rightAffinity === "INTEGER" || rightAffinity === "REAL" || rightAffinity === "NUMERIC";
  const leftNone = leftAffinity === null || leftAffinity === "BLOB";
  const rightNone = rightAffinity === null || rightAffinity === "BLOB";

  if (leftNumeric && (rightAffinity === "TEXT" || rightNone)) {
    const affinity = leftAffinity === "REAL" ? "REAL" : "NUMERIC";
    return [left, applyAffinity(right, affinity)];
  }
  if (rightNumeric && (leftAffinity === "TEXT" || leftNone)) {
    const affinity = rightAffinity === "REAL" ? "REAL" : "NUMERIC";
    return [applyAffinity(left, affinity), right];
  }
  if (leftAffinity === "TEXT" && rightNone) return [left, applyAffinity(right, "TEXT")];
  if (rightAffinity === "TEXT" && leftNone) return [applyAffinity(left, "TEXT"), right];
  return [left, right];
}

/** Prefix numeric parse for arithmetic / boolean (sqlite3AtoF). */
export function coerceToNumberPrefix(value: SqlValue): number {
  if (value === null) return 0;
  if (value instanceof SqlReal) return value.value;
  if (value instanceof SqlJsonText) return coerceToNumberPrefix(value.value);
  if (typeof value === "number") return canonicalizeNumber(value);
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return canonicalizeNumber(sqliteAtoF(value));
  if (value instanceof Uint8Array) return canonicalizeNumber(sqliteAtoF(utf8Decode(value)));
  return 0;
}

/** Parse `value` as a number, or `null` when it is not numeric. */
export function coerceToNumber(value: SqlValue): number | null {
  if (value === null) return null;
  if (value instanceof SqlReal) return value.value;
  if (value instanceof SqlJsonText) return coerceToNumber(value.value);
  if (typeof value === "number") return canonicalizeNumber(value);
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const s = value.trim();
    if (s === "") return null;
    const n = Number(s);
    if (!Number.isNaN(n) && /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
      return canonicalizeNumber(n);
    }
    return null;
  }
  if (value instanceof Uint8Array) {
    return coerceToNumber(utf8Decode(value));
  }
  return null;
}

/** Truncate `value` toward zero as an integer, or `null` when it is not numeric. */
export function toInteger(value: SqlValue): number | bigint | null {
  if (value === null) return null;
  if (typeof value === "bigint") return value;
  if (value instanceof SqlReal) return Math.trunc(value.value);
  if (value instanceof SqlJsonText) return toInteger(value.value);
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "string") {
    const n = coerceToNumber(value);
    return n === null ? null : Math.trunc(n);
  }
  return null;
}

/** SQLite `=` / `IS` equality for two non-NULL values (`NULL = NULL` is false here). */
export function sqlValueEquals(a: SqlValue, b: SqlValue): boolean {
  if (a === null || b === null) return false;
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  const an = a instanceof SqlReal ? a.value : a instanceof SqlJsonText ? a.value : a;
  const bn = b instanceof SqlReal ? b.value : b instanceof SqlJsonText ? b.value : b;
  if (typeof an === "bigint" || typeof bn === "bigint") {
    try {
      return BigInt(an as number | bigint) === BigInt(bn as number | bigint);
    } catch {
      return false;
    }
  }
  if (typeof an === "number" && typeof bn === "number") return Object.is(an, bn);
  return an === bn;
}

/**
 * SQLite comparison for ORDER BY / inequalities.
 * Returns -1, 0, 1, or null if either side is NULL (SQL NULL).
 */
export function compareSql(a: SqlValue, b: SqlValue): number | null {
  if (a === null || b === null) return null;

  const ca = comparisonClass(a);
  const cb = comparisonClass(b);
  if (ca !== cb) return ca < cb ? -1 : 1;

  if (ca === 1) {
    // numbers — compare floats before BigInt conversion (NaN/Inf must not reach BigInt)
    const fa = a instanceof SqlReal ? a.value : typeof a === "number" ? a : typeof a === "bigint" ? null : Number(a);
    const fb = b instanceof SqlReal ? b.value : typeof b === "number" ? b : typeof b === "bigint" ? null : Number(b);
    if (typeof a === "bigint" && typeof b === "bigint") {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    }
    if (typeof a === "bigint" || typeof b === "bigint") {
      const left = typeof a === "bigint" ? Number(a) : (fa as number);
      const right = typeof b === "bigint" ? Number(b) : (fb as number);
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    }
    const left = fa as number;
    const right = fb as number;
    if (Number.isNaN(left) && Number.isNaN(right)) return 0;
    if (Number.isNaN(left)) return 1;
    if (Number.isNaN(right)) return -1;
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }

  if (ca === 2) {
    const sa = a instanceof SqlJsonText ? a.value : String(a);
    const sb = b instanceof SqlJsonText ? b.value : String(b);
    if (sa < sb) return -1;
    if (sa > sb) return 1;
    return 0;
  }

  // blobs
  const ba = a instanceof Uint8Array ? a : utf8Encode(String(a));
  const bb = b instanceof Uint8Array ? b : utf8Encode(String(b));
  const len = Math.min(ba.length, bb.length);
  for (let i = 0; i < len; i++) {
    const d = (ba[i] ?? 0) - (bb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (ba.length < bb.length) return -1;
  if (ba.length > bb.length) return 1;
  return 0;
}

/** SQLite sort order: NULL < numbers < text < blob */
function comparisonClass(v: SqlValue): number {
  if (v === null) return 0;
  if (v instanceof SqlReal || typeof v === "number" || typeof v === "bigint") return 1;
  if (typeof v === "string" || v instanceof SqlJsonText) return 2;
  return 3;
}

/** UTF-8 encode `s` (SQLite TEXT → BLOB). */
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export function utf8Encode(s: string): Uint8Array {
  return TEXT_ENCODER.encode(s);
}

/** UTF-8 decode `b` (SQLite BLOB → TEXT). */
export function utf8Decode(b: Uint8Array): string {
  return TEXT_DECODER.decode(b);
}

/** Deep-copy blobs and REAL/JSON wrappers; primitives are returned as-is. */
export function cloneSqlValue(v: SqlValue): SqlValue {
  if (v instanceof Uint8Array) return new Uint8Array(v);
  if (v instanceof SqlReal) return new SqlReal(v.value);
  if (v instanceof SqlJsonText) return new SqlJsonText(v.value);
  return v;
}

/**
 * SQLite boolean truthiness (WHERE / HAVING / CASE / AND / OR / NOT).
 * Text/blob use longest-prefix numeric conversion (sqlite3AtoF); non-numeric → 0.
 */
export function isTruthySql(v: SqlValue): boolean | null {
  if (v === null) return null;
  if (v instanceof SqlReal) return v.value !== 0;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "bigint") return v !== 0n;
  if (typeof v === "string" || v instanceof Uint8Array || v instanceof SqlJsonText) {
    const text = typeof v === "string" ? v : v instanceof SqlJsonText ? v.value : utf8Decode(v);
    const n = sqliteAtoF(text);
    return n !== 0 && !Number.isNaN(n);
  }
  return false;
}
