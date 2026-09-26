import { pgError, unsupported } from "../errors/error.ts";
import { parseTsqueryText, parseTsvector, tsqueryText } from "../tsearch/tsearch.ts";
import {
  formatDate,
  formatInterval,
  formatTimeOfDay,
  formatTimestamp,
  formatTimestampTz,
  type Interval,
  parseDate,
  parseInterval,
  parseTime,
  parseTimestamp,
  parseTimestampTz,
} from "./datetime.ts";
import { type JsonbValue, jsonbText, parseJsonText, validateJsonText } from "./jsonb.ts";
import { parseJsonpath } from "./jsonpath.ts";
import { type Numeric, numericText, parseNumeric } from "./numeric.ts";

/**
 * Canonical type ids are lowercase PG internal names: "int4", "text",
 * "timestamptz", … Arrays are `elem + "[]"`. Enums are `"enum:" + qualified
 * name`. "unknown" is the type of untyped string literals; "null" never
 * appears (null datums carry whatever type context provides).
 */
export type TypeId = string;

export type Datum =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | Numeric
  | Interval
  | PgArray
  | PgRecord
  | JsonbWrap;

export interface PgArray {
  readonly kind: "pgarray";
  readonly elem: TypeId;
  /** dimension lengths, outermost first; empty array => [] */
  readonly dims: number[];
  /** lower bounds per dimension (default 1) */
  readonly lbs: number[];
  /** row-major flattened items */
  readonly items: Datum[];
}

export interface PgRecord {
  readonly kind: "pgrecord";
  readonly types: TypeId[];
  readonly values: Datum[];
  readonly names?: string[];
}

/** jsonb datums are wrapped so `typeof` dispatch stays unambiguous. */
export interface JsonbWrap {
  readonly kind: "jsonb";
  readonly value: JsonbValue;
}

export function wrapJsonb(value: JsonbValue): JsonbWrap {
  return { kind: "jsonb", value };
}

export function isJsonbWrap(v: unknown): v is JsonbWrap {
  return typeof v === "object" && v !== null && (v as any).kind === "jsonb";
}

export function isPgArray(v: unknown): v is PgArray {
  return typeof v === "object" && v !== null && (v as any).kind === "pgarray";
}

export function isPgRecord(v: unknown): v is PgRecord {
  return typeof v === "object" && v !== null && (v as any).kind === "pgrecord";
}

export function makeArray(elem: TypeId, items: Datum[], dims?: number[], lbs?: number[]): PgArray {
  const d = dims ?? (items.length === 0 ? [] : [items.length]);
  const l = lbs ?? d.map(() => 1);
  return { kind: "pgarray", elem, dims: d, lbs: l, items };
}

export interface TypedValue {
  readonly t: TypeId;
  readonly v: Datum;
}

export function tv(t: TypeId, v: Datum): TypedValue {
  return { t, v };
}

export const UNKNOWN = "unknown";

// --- type name normalization ---------------------------------------------

export interface TypeMod {
  /** varchar(n)/bpchar(n): max chars; numeric: precision; time/timestamp: fractional digits */
  readonly a?: number;
  /** numeric scale */
  readonly b?: number;
}

export interface ColumnType {
  readonly id: TypeId;
  readonly mod: TypeMod | null;
}

const TYPE_ALIASES: Record<string, TypeId> = {
  bool: "bool",
  boolean: "bool",
  int2: "int2",
  smallint: "int2",
  int4: "int4",
  int: "int4",
  integer: "int4",
  int8: "int8",
  bigint: "int8",
  float4: "float4",
  real: "float4",
  float8: "float8",
  "double precision": "float8",
  float: "float8",
  numeric: "numeric",
  decimal: "numeric",
  money: "money",
  text: "text",
  varchar: "varchar",
  "character varying": "varchar",
  bpchar: "bpchar",
  character: "bpchar",
  char: "bpchar",
  name: "name",
  bytea: "bytea",
  date: "date",
  time: "time",
  "time without time zone": "time",
  timetz: "timetz",
  "time with time zone": "timetz",
  timestamp: "timestamp",
  "timestamp without time zone": "timestamp",
  timestamptz: "timestamptz",
  "timestamp with time zone": "timestamptz",
  interval: "interval",
  uuid: "uuid",
  json: "json",
  jsonb: "jsonb",
  jsonpath: "jsonpath",
  regclass: "regclass",
  regtype: "regtype",
  regproc: "regproc",
  oid: "oid",
  void: "void",
  record: "record",
  tsvector: "tsvector",
  tsquery: "tsquery",
  bit: "bit",
  "bit varying": "varbit",
  varbit: "varbit",
  serial: "int4",
  serial4: "int4",
  serial8: "int8",
  bigserial: "int8",
  smallserial: "int2",
  serial2: "int2",
};

export function normalizeTypeName(name: string): TypeId | null {
  const lower = name.trim().toLowerCase().replace(/\s+/g, " ");
  return TYPE_ALIASES[lower] ?? null;
}

export function isArrayType(t: TypeId): boolean {
  return t.endsWith("[]");
}

export function arrayElemType(t: TypeId): TypeId {
  return t.slice(0, -2);
}

export function arrayTypeOf(elem: TypeId): TypeId {
  // PG arrays are one-level: int4[][] is still _int4
  return isArrayType(elem) ? elem : `${elem}[]`;
}

export function isEnumType(t: TypeId): boolean {
  return t.startsWith("enum:");
}

export function enumTypeName(t: TypeId): string {
  return t.slice(5);
}

/** SQL-facing type name (format_type / pg_typeof style). */
export function typeDisplayName(t: TypeId): string {
  if (isArrayType(t)) return `${typeDisplayName(arrayElemType(t))}[]`;
  if (isEnumType(t)) return enumTypeName(t);
  switch (t) {
    case "bool":
      return "boolean";
    case "int2":
      return "smallint";
    case "int4":
      return "integer";
    case "int8":
      return "bigint";
    case "float4":
      return "real";
    case "float8":
      return "double precision";
    case "varchar":
      return "character varying";
    case "bpchar":
      return "character";
    case "timestamp":
      return "timestamp without time zone";
    case "timestamptz":
      return "timestamp with time zone";
    case "time":
      return "time without time zone";
    case "timetz":
      return "time with time zone";
    default:
      return t;
  }
}

// --- OIDs (for catalog output and oracle-conformant field metadata) -------

export const TYPE_OIDS: Record<string, number> = {
  bool: 16,
  bytea: 17,
  name: 19,
  int8: 20,
  int2: 21,
  int4: 23,
  regproc: 24,
  text: 25,
  oid: 26,
  json: 114,
  float4: 700,
  float8: 701,
  money: 790,
  bpchar: 1042,
  varchar: 1043,
  date: 1082,
  time: 1083,
  timestamp: 1114,
  timestamptz: 1184,
  interval: 1186,
  timetz: 1266,
  bit: 1560,
  varbit: 1562,
  numeric: 1700,
  regclass: 2205,
  regtype: 2206,
  record: 2249,
  uuid: 2950,
  jsonb: 3802,
  jsonpath: 4072,
  tsvector: 3614,
  tsquery: 3615,
  void: 2278,
  unknown: 705,
};

const ARRAY_OIDS: Record<string, number> = {
  bool: 1000,
  bytea: 1001,
  name: 1003,
  int8: 1016,
  int2: 1005,
  int4: 1007,
  text: 1009,
  oid: 1028,
  json: 199,
  float4: 1021,
  float8: 1022,
  money: 791,
  bpchar: 1014,
  varchar: 1015,
  date: 1182,
  time: 1183,
  timestamp: 1115,
  timestamptz: 1185,
  interval: 1187,
  timetz: 1270,
  numeric: 1231,
  record: 2287,
  uuid: 2951,
  jsonb: 3807,
};

export function typeOid(t: TypeId): number {
  if (isArrayType(t)) return ARRAY_OIDS[arrayElemType(t)] ?? 2277;
  return TYPE_OIDS[t] ?? 705;
}

// --- float rendering (PG shortest round-trip format) ----------------------

/** Extract shortest digits+exponent for a finite double. */
function shortestParts(v: number): { neg: boolean; digits: string; exp: number } {
  const s = Math.abs(v).toString();
  if (s.includes("e") || s.includes("E")) {
    const m = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s)!;
    const digits = (m[1]! + (m[2] ?? "")).replace(/0+$/, "") || "0";
    const exp = Number(m[3]) + m[1]!.length - 1;
    return { neg: v < 0, digits, exp };
  }
  const dot = s.indexOf(".");
  if (dot === -1) {
    const trimmed = s.replace(/0+$/, "");
    const digits = trimmed === "" ? "0" : trimmed;
    return { neg: v < 0, digits, exp: s.length - 1 };
  }
  const intPart = s.slice(0, dot);
  const fracPart = s.slice(dot + 1);
  if (intPart === "0") {
    let lead = 0;
    while (lead < fracPart.length && fracPart[lead] === "0") lead++;
    const digits = fracPart.slice(lead).replace(/0+$/, "") || "0";
    return { neg: v < 0, digits, exp: -(lead + 1) };
  }
  const digits = (intPart + fracPart).replace(/0+$/, "") || "0";
  return { neg: v < 0, digits, exp: intPart.length - 1 };
}

function formatFloatParts(neg: boolean, digits: string, exp: number, sciLow: number, sciHigh: number): string {
  const sign = neg ? "-" : "";
  if (digits === "0") return "0";
  if (exp < sciLow || exp >= sciHigh) {
    const mant = digits.length === 1 ? digits : `${digits[0]}.${digits.slice(1)}`;
    const absExp = Math.abs(exp);
    const expStr = absExp < 10 ? `0${absExp}` : String(absExp);
    return `${sign}${mant}e${exp < 0 ? "-" : "+"}${expStr}`;
  }
  if (exp >= digits.length - 1) {
    return sign + digits + "0".repeat(exp - (digits.length - 1));
  }
  if (exp >= 0) {
    return `${sign}${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
  }
  return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
}

export function float8Text(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Number.POSITIVE_INFINITY) return "Infinity";
  if (v === Number.NEGATIVE_INFINITY) return "-Infinity";
  if (v === 0) return Object.is(v, -0) ? "-0" : "0";
  const { neg, digits, exp } = shortestParts(v);
  return formatFloatParts(neg, digits, exp, -4, 15);
}

/** Shortest digits that round-trip through float32. */
function float4ShortestDigits(v: number): { neg: boolean; digits: string; exp: number } {
  for (let p = 1; p <= 9; p++) {
    const cand = v.toPrecision(p);
    if (Math.fround(Number(cand)) === v) {
      const n = Number(cand);
      return shortestParts(n);
    }
  }
  return shortestParts(v);
}

export function float4Text(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Number.POSITIVE_INFINITY) return "Infinity";
  if (v === Number.NEGATIVE_INFINITY) return "-Infinity";
  if (v === 0) return Object.is(v, -0) ? "-0" : "0";
  const { neg, digits, exp } = float4ShortestDigits(v);
  return formatFloatParts(neg, digits, exp, -4, 6);
}

export function parseFloatText(text: string, type: "float4" | "float8"): number {
  const t = text.trim().toLowerCase();
  if (t === "nan") return Number.NaN;
  if (t === "infinity" || t === "inf" || t === "+infinity" || t === "+inf") return Number.POSITIVE_INFINITY;
  if (t === "-infinity" || t === "-inf") return Number.NEGATIVE_INFINITY;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) {
    throw pgError(
      "invalid_text_representation",
      `invalid input syntax for type ${type === "float4" ? "real" : "double precision"}: "${text}"`,
    );
  }
  let v = Number(t);
  if (type === "float4") {
    v = Math.fround(v);
    if (!Number.isFinite(v) && Number.isFinite(Number(t))) {
      throw pgError("numeric_value_out_of_range", `"${text}" is out of range for type real`);
    }
  }
  // PG keeps -0 for float literals (e.g. '-0.0'::float8).
  if (Number(t) === 0 && t.startsWith("-")) return -0;
  return v;
}

// --- integers --------------------------------------------------------------

export const INT2_MIN = -32768;
export const INT2_MAX = 32767;
export const INT4_MIN = -2147483648;
export const INT4_MAX = 2147483647;
export const INT8_MIN = -9223372036854775808n;
export const INT8_MAX = 9223372036854775807n;

export function checkInt2(v: number): number {
  if (!Number.isInteger(v) || v < INT2_MIN || v > INT2_MAX) {
    throw pgError("numeric_value_out_of_range", "smallint out of range");
  }
  return v;
}

export function checkInt4(v: number): number {
  if (!Number.isInteger(v) || v < INT4_MIN || v > INT4_MAX) {
    throw pgError("numeric_value_out_of_range", "integer out of range");
  }
  return v;
}

export function checkInt8(v: bigint): bigint {
  if (v < INT8_MIN || v > INT8_MAX) {
    throw pgError("numeric_value_out_of_range", "bigint out of range");
  }
  return v;
}

function parseIntegerText(text: string, type: "int2" | "int4" | "int8"): number | bigint {
  const t = text.trim();
  const names = { int2: "smallint", int4: "integer", int8: "bigint" } as const;
  if (!/^[+-]?\d+$/.test(t)) {
    throw pgError("invalid_text_representation", `invalid input syntax for type ${names[type]}: "${text}"`);
  }
  const big = BigInt(t);
  if (type === "int8") {
    if (big < INT8_MIN || big > INT8_MAX) {
      throw pgError("numeric_value_out_of_range", `value "${text}" is out of range for type bigint`);
    }
    return big;
  }
  const n = Number(big);
  const [min, max] = type === "int2" ? [INT2_MIN, INT2_MAX] : [INT4_MIN, INT4_MAX];
  if (big < BigInt(min) || big > BigInt(max)) {
    throw pgError("numeric_value_out_of_range", `value "${text}" is out of range for type ${names[type]}`);
  }
  return n;
}

// --- bool ------------------------------------------------------------------

export function parseBoolText(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t === "t" || t === "true" || t === "yes" || t === "on" || t === "y" || t === "1" || t === "tr" || t === "tru")
    return true;
  if (
    t === "f" ||
    t === "false" ||
    t === "no" ||
    t === "off" ||
    t === "n" ||
    t === "0" ||
    t === "fa" ||
    t === "fal" ||
    t === "fals"
  )
    return false;
  throw pgError("invalid_text_representation", `invalid input syntax for type boolean: "${text}"`);
}

// --- bytea -------------------------------------------------------------------

export function parseByteaText(text: string): Uint8Array {
  if (text.startsWith("\\x") || text.startsWith("\\X")) {
    const hex = text.slice(2).replace(/\s/g, "");
    if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
      throw pgError("invalid_text_representation", `invalid hexadecimal data: odd number of digits`);
    }
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  // escape format
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") {
      const next = text[i + 1];
      if (next === "\\") {
        bytes.push(92);
        i += 1;
      } else if (next !== undefined && /[0-3]/.test(next) && /^[0-7]{3}$/.test(text.slice(i + 1, i + 4))) {
        bytes.push(Number.parseInt(text.slice(i + 1, i + 4), 8));
        i += 3;
      } else {
        throw pgError("invalid_text_representation", `invalid input syntax for type bytea`);
      }
    } else {
      bytes.push(c.charCodeAt(0));
    }
  }
  return new Uint8Array(bytes);
}

export function byteaText(v: Uint8Array): string {
  let out = "\\x";
  for (const b of v) out += b.toString(16).padStart(2, "0");
  return out;
}

// --- uuid ---------------------------------------------------------------------

const UUID_RE = /^\{?([0-9a-fA-F]{8})-?([0-9a-fA-F]{4})-?([0-9a-fA-F]{4})-?([0-9a-fA-F]{4})-?([0-9a-fA-F]{12})\}?$/;

export function parseUuidText(text: string): string {
  const m = UUID_RE.exec(text.trim());
  if (!m) {
    throw pgError("invalid_text_representation", `invalid input syntax for type uuid: "${text}"`);
  }
  return `${m[1]}-${m[2]}-${m[3]}-${m[4]}-${m[5]}`.toLowerCase();
}

// --- money -----------------------------------------------------------------

export function parseMoneyText(text: string): bigint {
  const t = text.trim().replace(/[$,]/g, "");
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(t) ?? /^\((\d*)(?:\.(\d*))?\)$/.exec(t);
  if (!m || t.replace(/[+\-().]/g, "") === "") {
    throw pgError("invalid_text_representation", `invalid input syntax for type money: "${text}"`);
  }
  if (t.startsWith("(")) {
    const mm = /^\((\d*)(?:\.(\d*))?\)$/.exec(t)!;
    return -moneyCents(mm[1] ?? "0", mm[2] ?? "");
  }
  const sign = m[1] === "-" ? -1n : 1n;
  return sign * moneyCents(m[2] ?? "0", m[3] ?? "");
}

function moneyCents(intPart: string, fracPart: string): bigint {
  const frac = (fracPart + "000").slice(0, 3);
  const cents = BigInt(intPart || "0") * 100n + BigInt(frac.slice(0, 2) || "0");
  // round on third fractional digit
  return Number(frac[2] ?? "0") >= 5 ? cents + 1n : cents;
}

export function moneyText(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const whole = abs / 100n;
  const frac = abs % 100n;
  // C locale money formatting with thousands separators
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = `$${wholeStr}.${frac.toString().padStart(2, "0")}`;
  return neg ? `-${body}` : body;
}

// --- array text ---------------------------------------------------------------

function arrayElemNeedsQuote(s: string): boolean {
  if (s.length === 0) return true;
  if (/^null$/i.test(s)) return true;
  return /[\s{},"\\]/.test(s);
}

function quoteArrayElem(s: string): string {
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export interface OutputCtx {
  /** offset seconds east of UTC for rendering timestamptz at given UTC micros */
  zoneOffsetAt(utcMicros: bigint): number;
}

export const UTC_OUTPUT: OutputCtx = { zoneOffsetAt: () => 0 };

export function arrayText(arr: PgArray, ctx: OutputCtx): string {
  if (arr.dims.length === 0) return "{}";
  const needsLb = arr.lbs.some((l) => l !== 1);
  let idx = 0;
  const renderDim = (dim: number): string => {
    const len = arr.dims[dim]!;
    const parts: string[] = [];
    for (let i = 0; i < len; i++) {
      if (dim === arr.dims.length - 1) {
        const item = arr.items[idx++]!;
        if (item === null) {
          parts.push("NULL");
        } else {
          const s = datumText(arr.elem, item, ctx);
          parts.push(arrayElemNeedsQuote(s) ? quoteArrayElem(s) : s);
        }
      } else {
        parts.push(renderDim(dim + 1));
      }
    }
    return `{${parts.join(",")}}`;
  };
  const body = renderDim(0);
  if (!needsLb) return body;
  const spec = arr.dims.map((d, i) => `[${arr.lbs[i]}:${arr.lbs[i]! + d - 1}]`).join("");
  return `${spec}=${body}`;
}

function recordFieldNeedsQuote(s: string): boolean {
  if (s.length === 0) return true;
  return /[\s(),"\\]/.test(s);
}

export function recordText(rec: PgRecord, ctx: OutputCtx): string {
  const parts = rec.values.map((v, i) => {
    if (v === null) return "";
    const s = datumText(rec.types[i] ?? "text", v, ctx);
    return recordFieldNeedsQuote(s) ? `"${s.replaceAll('"', '""').replaceAll("\\", "\\\\")}"` : s;
  });
  return `(${parts.join(",")})`;
}

// --- typoutput -------------------------------------------------------------

/** Render a non-null datum of type `t` to PG wire text. */
export function datumText(t: TypeId, v: Datum, ctx: OutputCtx): string {
  if (v === null) throw pgError("internal", "datumText called with null");
  if (isArrayType(t)) return arrayText(v as PgArray, ctx);
  if (isEnumType(t)) return v as string;
  switch (t) {
    case "bool":
      return (v as boolean) ? "t" : "f";
    case "int2":
    case "int4":
    case "oid":
      return String(v);
    case "int8":
      return String(v);
    case "float4":
      return float4Text(v as number);
    case "float8":
      return float8Text(v as number);
    case "numeric":
      return numericText(v as Numeric);
    case "money":
      return moneyText(v as bigint);
    case "text":
    case "varchar":
    case "bpchar":
    case "name":
    case "unknown":
    case "json":
    case "regclass":
    case "regtype":
    case "regproc":
    case "jsonpath":
    case "tsvector":
    case "tsquery":
    case "bit":
    case "varbit":
      return v as string;
    case "bytea":
      return byteaText(v as Uint8Array);
    case "date":
      return formatDate(v as number);
    case "time":
      return formatTimeOfDay(v as bigint);
    case "timetz": {
      const tz = v as unknown as { micros: bigint; offsetSec: number };
      const base = formatTimeOfDay(tz.micros);
      const off = tz.offsetSec;
      const abs = Math.abs(off);
      const oh = Math.floor(abs / 3600);
      const om = Math.floor((abs % 3600) / 60);
      let zone = `${off < 0 ? "-" : "+"}${oh < 10 ? `0${oh}` : oh}`;
      if (om !== 0) zone += `:${om < 10 ? `0${om}` : om}`;
      return base + zone;
    }
    case "timestamp":
      return formatTimestamp(v as bigint);
    case "timestamptz":
      return formatTimestampTz(v as bigint, ctx.zoneOffsetAt(v as bigint));
    case "interval":
      return formatInterval(v as Interval);
    case "uuid":
      return v as string;
    case "jsonb":
      return jsonbText((v as JsonbWrap).value);
    case "record":
      return recordText(v as PgRecord, ctx);
    case "void":
      return "";
    default:
      if (isPgRecord(v)) return recordText(v, ctx);
      throw unsupported(`output of type ${t}`);
  }
}

// --- typinput ----------------------------------------------------------------

export interface InputCtx {
  /** session zone offset lookup for naive timestamptz input */
  zoneOffsetForNaive(naiveMicros: bigint): number;
  /** enum label validation: returns true when label is valid for the enum type */
  enumHasLabel?(enumType: TypeId, label: string): boolean;
}

export const UTC_INPUT: InputCtx = { zoneOffsetForNaive: () => 0 };

/** Parse PG wire text into a datum of type `t` (typinput). */
export function datumFromText(t: TypeId, text: string, ctx: InputCtx): Datum {
  if (isArrayType(t)) return parseArrayText(t, text, ctx);
  if (isEnumType(t)) {
    if (ctx.enumHasLabel && !ctx.enumHasLabel(t, text)) {
      throw pgError("invalid_text_representation", `invalid input value for enum ${enumTypeName(t)}: "${text}"`);
    }
    return text;
  }
  switch (t) {
    case "bool":
      return parseBoolText(text);
    case "int2":
    case "int4":
    case "int8":
      return parseIntegerText(text, t);
    case "oid": {
      const n = parseIntegerText(text, "int8") as bigint;
      return Number(n);
    }
    case "float4":
      return Math.fround(parseFloatText(text, "float4"));
    case "float8":
      return parseFloatText(text, "float8");
    case "numeric":
      return parseNumeric(text);
    case "money":
      return parseMoneyText(text);
    case "text":
    case "varchar":
    case "bpchar":
    case "unknown":
      return text;
    case "name":
      return text.slice(0, 63);
    case "json":
      validateJsonText(text);
      return text;
    case "jsonb":
      return wrapJsonb(parseJsonText(text));
    case "jsonpath":
      parseJsonpath(text);
      return text;
    case "bytea":
      return parseByteaText(text);
    case "date":
      return parseDate(text);
    case "time":
      return parseTime(text);
    case "timestamp":
      return parseTimestamp(text);
    case "timestamptz":
      return parseTimestampTz(text, ctx.zoneOffsetForNaive);
    case "interval":
      return parseInterval(text);
    case "uuid":
      return parseUuidText(text);
    case "tsvector":
      return parseTsvector(text);
    case "tsquery": {
      const node = parseTsqueryText(text);
      return tsqueryText(node);
    }
    case "bit":
    case "varbit": {
      if (!/^[01]*$/.test(text)) {
        const bad = [...text].find((c) => c !== "0" && c !== "1")!;
        throw pgError("invalid_text_representation", `"${bad}" is not a valid binary digit`);
      }
      return text;
    }
    default:
      throw unsupported(`input of type ${t}`);
  }
}

function parseArrayText(t: TypeId, text: string, ctx: InputCtx): PgArray {
  const elem = arrayElemType(t);
  let s = text.trim();
  let lbs: number[] | null = null;
  // optional dimension spec [1:2][3:4]=
  const dimSpec = /^((?:\[-?\d+:-?\d+\])+)=/.exec(s);
  if (dimSpec) {
    lbs = [...dimSpec[1]!.matchAll(/\[(-?\d+):(-?\d+)\]/g)].map((m) => Number(m[1]));
    s = s.slice(dimSpec[0].length);
  }
  if (!s.startsWith("{")) {
    throw pgError("invalid_text_representation", `malformed array literal: "${text}"`);
  }
  let pos = 0;
  const parseLevel = (): (Datum | Datum[] | any)[] => {
    // assumes s[pos] === '{'
    pos++;
    const out: any[] = [];
    for (;;) {
      while (pos < s.length && /\s/.test(s[pos]!)) pos++;
      const c = s[pos];
      if (c === undefined) throw pgError("invalid_text_representation", `malformed array literal: "${text}"`);
      if (c === "}") {
        pos++;
        return out;
      }
      if (c === ",") {
        pos++;
        continue;
      }
      if (c === "{") {
        out.push(parseLevel());
        continue;
      }
      if (c === '"') {
        pos++;
        let val = "";
        for (;;) {
          const ch = s[pos];
          if (ch === undefined) throw pgError("invalid_text_representation", `malformed array literal: "${text}"`);
          if (ch === "\\") {
            val += s[pos + 1] ?? "";
            pos += 2;
            continue;
          }
          if (ch === '"') {
            pos++;
            break;
          }
          val += ch;
          pos++;
        }
        out.push(datumFromText(elem, val, ctx));
        continue;
      }
      // bare token
      let tok = "";
      while (pos < s.length && !/[,}]/.test(s[pos]!)) {
        tok += s[pos];
        pos++;
      }
      tok = tok.trim();
      if (/^null$/i.test(tok)) out.push(null);
      else out.push(datumFromText(elem, tok, ctx));
    }
  };
  const nested = parseLevel();
  while (pos < s.length && /\s/.test(s[pos]!)) pos++;
  if (pos !== s.length) {
    throw pgError("invalid_text_representation", `malformed array literal: "${text}"`);
  }
  // flatten and compute dims
  const dims: number[] = [];
  let level: any = nested;
  while (Array.isArray(level)) {
    dims.push(level.length);
    level = level[0];
  }
  if (nested.length === 0) return makeArray(elem, [], [], []);
  const items: Datum[] = [];
  const flatten = (arr: any[], depth: number): void => {
    if (arr.length !== dims[depth]) {
      throw pgError("invalid_text_representation", `malformed array literal: "${text}"`);
    }
    for (const item of arr) {
      if (depth === dims.length - 1) {
        if (Array.isArray(item)) throw pgError("invalid_text_representation", `malformed array literal: "${text}"`);
        items.push(item);
      } else {
        if (!Array.isArray(item)) throw pgError("invalid_text_representation", `malformed array literal: "${text}"`);
        flatten(item, depth + 1);
      }
    }
  };
  flatten(nested, 0);
  return makeArray(elem, items, dims, lbs ?? dims.map(() => 1));
}
