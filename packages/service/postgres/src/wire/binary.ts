import type { BindValue } from "../api/bind.ts";
import { PostgresError } from "../errors/error.ts";
import {
  formatDate,
  formatInterval,
  formatTimeOfDay,
  formatTimestamp,
  formatTimestampTz,
  makeInterval,
  parseDate,
  parseInterval,
  parseTime,
  parseTimestamp,
  parseTimestampTz,
} from "../types/datetime.ts";
import {
  makeNumeric,
  NUMERIC_NAN,
  NUMERIC_NINF,
  NUMERIC_PINF,
  type Numeric,
  numericText,
  parseNumeric,
} from "../types/numeric.ts";
import {
  ARRAY_OIDS,
  arrayElemType,
  datumFromText,
  datumText,
  float4Text,
  float8Text,
  isArrayType,
  isEnumType,
  isPgArray,
  moneyText,
  TYPE_OIDS,
  UTC_INPUT,
  UTC_OUTPUT,
  parseMoneyText,
} from "../types/value.ts";
import { utf8 } from "./protocol.ts";

/**
 * Binary (format code 1) values on the wire. The engine's rows are text, so a binary result
 * cell is the text parsed back to the value and written in the type's `typsend` layout; a
 * binary parameter is read with the type's `typreceive` layout and handed to the engine as
 * text (or as the JS value that already means the same). Layouts: PostgreSQL's
 * `src/backend/utils/adt/*.c` `*_send` / `*_recv`, checked against a real server's bytes.
 */

const TEXT_TYPES = new Set(["text", "varchar", "bpchar", "name", "json", "xml", "unknown"]);
const NUMERIC_NAN_SIGN = 0xc000;
const NUMERIC_PINF_SIGN = 0xd000;
const NUMERIC_NINF_SIGN = 0xf000;
const NUMERIC_NEG_SIGN = 0x4000;

const unsupported = (message: string): PostgresError => new PostgresError("internal", message, "0A000");
const malformed = (message: string): PostgresError => new PostgresError("internal", message, "22P03");

const viewOf = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const dv = (n: number): { b: Uint8Array; v: DataView } => {
  const b = new Uint8Array(n);
  return { b, v: new DataView(b.buffer) };
};
const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const hexBytes = (hex: string): Uint8Array | null => {
  if (hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const toHex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

// --- results: text -> binary -------------------------------------------------------------

/** Types a result column can be sent as in binary format (arrays when their element can). */
export const binaryEncodable = (type: string): boolean => {
  if (isArrayType(type)) {
    const elem = arrayElemType(type);
    return !isArrayType(elem) && elem in TYPE_OIDS && binaryEncodable(elem);
  }
  return (
    TEXT_TYPES.has(type) ||
    isEnumType(type) ||
    [
      "bool",
      "int2",
      "int4",
      "oid",
      "xid",
      "int8",
      "float4",
      "float8",
      "bytea",
      "uuid",
      "numeric",
      "money",
      "date",
      "time",
      "timestamp",
      "timestamptz",
      "interval",
      "jsonb",
      "jsonpath",
      "bit",
      "varbit",
    ].includes(type)
  );
};

const numericBinary = (n: Numeric): Uint8Array => {
  const header = (ndigits: number, weight: number, sign: number, dscale: number, digits: number[] = []) => {
    const { b, v } = dv(8 + digits.length * 2);
    v.setInt16(0, ndigits);
    v.setInt16(2, weight);
    v.setUint16(4, sign);
    v.setUint16(6, dscale);
    digits.forEach((digit, i) => {
      v.setInt16(8 + i * 2, digit);
    });
    return b;
  };
  if (n.special === "nan") return header(0, 0, NUMERIC_NAN_SIGN, 0);
  if (n.special === "inf") return header(0, 0, NUMERIC_PINF_SIGN, 0);
  if (n.special === "-inf") return header(0, 0, NUMERIC_NINF_SIGN, 0);
  const negative = n.coef < 0n;
  const digits = (negative ? -n.coef : n.coef).toString().padStart(n.dscale + 1, "0");
  const whole = digits.slice(0, digits.length - n.dscale).replace(/^0+/, "");
  const fraction = digits.slice(digits.length - n.dscale);
  const wholePadded = whole.padStart(Math.ceil(whole.length / 4) * 4, "0");
  const fractionPadded = fraction.padEnd(Math.ceil(fraction.length / 4) * 4, "0");
  const groups = ((wholePadded + fractionPadded).match(/.{4}/g) ?? []).map(Number);
  let weight = wholePadded.length / 4 - 1;
  while (groups.length > 0 && groups[0] === 0) {
    groups.shift();
    weight--;
  }
  while (groups.length > 0 && groups[groups.length - 1] === 0) groups.pop();
  if (groups.length === 0) return header(0, 0, 0, n.dscale);
  return header(groups.length, weight, negative ? NUMERIC_NEG_SIGN : 0, n.dscale, groups);
};

const arrayBinary = (type: string, text: string): Uint8Array | null => {
  const elem = arrayElemType(type);
  const array = datumFromText(type, text, UTC_INPUT);
  if (!isPgArray(array)) return null;
  const header = dv(12 + array.dims.length * 8);
  header.v.setInt32(0, array.dims.length);
  header.v.setInt32(4, array.items.includes(null) ? 1 : 0);
  header.v.setUint32(8, TYPE_OIDS[elem] as number);
  array.dims.forEach((length, i) => {
    header.v.setInt32(12 + i * 8, length);
    header.v.setInt32(16 + i * 8, array.lbs[i] ?? 1);
  });
  const parts: Uint8Array[] = [header.b];
  for (const item of array.items) {
    if (item === null) {
      const nul = dv(4);
      nul.v.setInt32(0, -1);
      parts.push(nul.b);
      continue;
    }
    const cell = binaryResult(elem, datumText(elem, item, UTC_OUTPUT));
    if (cell === null) return null;
    const length = dv(4);
    length.v.setInt32(0, cell.length);
    parts.push(length.b, cell);
  }
  return concat(parts);
};

/** A text-format result cell in binary format; null when the type has no binary encoding here. */
export const binaryResult = (type: string, text: string): Uint8Array | null => {
  if (isArrayType(type)) return binaryEncodable(type) ? arrayBinary(type, text) : null;
  switch (type) {
    case "bool":
      return new Uint8Array([text === "t" ? 1 : 0]);
    case "int2": {
      const { b, v } = dv(2);
      v.setInt16(0, Number(text));
      return b;
    }
    case "int4":
    case "oid":
    case "xid": {
      const { b, v } = dv(4);
      if (type === "int4") v.setInt32(0, Number(text));
      else v.setUint32(0, Number(text));
      return b;
    }
    case "int8": {
      const { b, v } = dv(8);
      v.setBigInt64(0, BigInt(text));
      return b;
    }
    case "float4": {
      const { b, v } = dv(4);
      v.setFloat32(0, Number(text));
      return b;
    }
    case "float8": {
      const { b, v } = dv(8);
      v.setFloat64(0, Number(text));
      return b;
    }
    case "bytea": {
      return text.startsWith("\\x") ? hexBytes(text.slice(2)) : null;
    }
    case "uuid":
      return text.replaceAll("-", "").length === 32 ? hexBytes(text.replaceAll("-", "")) : null;
    case "numeric":
      return numericBinary(parseNumeric(text));
    case "money": {
      const { b, v } = dv(8);
      v.setBigInt64(0, parseMoneyText(text));
      return b;
    }
    case "date": {
      const { b, v } = dv(4);
      v.setInt32(0, parseDate(text));
      return b;
    }
    case "time": {
      const { b, v } = dv(8);
      v.setBigInt64(0, parseTime(text));
      return b;
    }
    case "timestamp": {
      const { b, v } = dv(8);
      v.setBigInt64(0, parseTimestamp(text));
      return b;
    }
    case "timestamptz": {
      const { b, v } = dv(8);
      v.setBigInt64(
        0,
        parseTimestampTz(text, () => 0),
      );
      return b;
    }
    case "interval": {
      const interval = parseInterval(text);
      const { b, v } = dv(16);
      v.setBigInt64(0, interval.micros);
      v.setInt32(8, interval.days);
      v.setInt32(12, interval.months);
      return b;
    }
    case "jsonb":
    case "jsonpath":
      return concat([new Uint8Array([1]), utf8.encode(text)]);
    case "bit":
    case "varbit": {
      const packed = new Uint8Array(4 + Math.ceil(text.length / 8));
      new DataView(packed.buffer).setInt32(0, text.length);
      for (let i = 0; i < text.length; i++) {
        if (text[i] === "1") packed[4 + (i >> 3)] = (packed[4 + (i >> 3)] as number) | (0x80 >> (i & 7));
      }
      return packed;
    }
    default:
      return TEXT_TYPES.has(type) || isEnumType(type) ? utf8.encode(text) : null;
  }
};

// --- parameters: binary -> engine value --------------------------------------------------

const ARRAY_OID_SET = new Set(Object.values(ARRAY_OIDS));

const numericFrom = (bytes: Uint8Array): Numeric => {
  const view = viewOf(bytes);
  if (bytes.length < 8) throw malformed("invalid message format");
  const ndigits = view.getInt16(0);
  const weight = view.getInt16(2);
  const sign = view.getUint16(4);
  const dscale = view.getUint16(6);
  if (sign === NUMERIC_NAN_SIGN) return NUMERIC_NAN;
  if (sign === NUMERIC_PINF_SIGN) return NUMERIC_PINF;
  if (sign === NUMERIC_NINF_SIGN) return NUMERIC_NINF;
  if (sign !== 0 && sign !== NUMERIC_NEG_SIGN) throw malformed('invalid sign in external "numeric" value');
  if (bytes.length < 8 + ndigits * 2) throw malformed("invalid message format");
  let units = 0n;
  for (let i = 0; i < ndigits; i++) units = units * 10_000n + BigInt(view.getInt16(8 + i * 2));
  const shift = (weight - (ndigits - 1)) * 4 + dscale;
  const coef = shift >= 0 ? units * 10n ** BigInt(shift) : units / 10n ** BigInt(-shift);
  return makeNumeric(sign === NUMERIC_NEG_SIGN ? -coef : coef, dscale);
};

/** The text a scalar of type `oid` has for `bytes`, as an array element or a text-bound parameter. */
const scalarText = (oid: number, bytes: Uint8Array): string => {
  const view = viewOf(bytes);
  switch (oid) {
    case 16:
      return bytes[0] !== 0 ? "t" : "f";
    case 21:
      return String(view.getInt16(0));
    case 23:
      return String(view.getInt32(0));
    case 26:
    case 28:
      return String(view.getUint32(0));
    case 20:
      return String(view.getBigInt64(0));
    case 700:
      return float4Text(view.getFloat32(0));
    case 701:
      return float8Text(view.getFloat64(0));
    case 17:
      return `\\x${toHex(bytes)}`;
    case 2950: {
      const hex = toHex(bytes);
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    case 1700:
      return numericText(numericFrom(bytes));
    case 790:
      return moneyText(view.getBigInt64(0));
    case 1082:
      return formatDate(view.getInt32(0));
    case 1083:
      return formatTimeOfDay(view.getBigInt64(0));
    case 1114:
      return formatTimestamp(view.getBigInt64(0));
    case 1184: {
      const micros = view.getBigInt64(0);
      return formatTimestampTz(micros, 0);
    }
    case 1186:
      return formatInterval(makeInterval(view.getInt32(12), view.getInt32(8), view.getBigInt64(0)));
    case 3802:
    case 4072:
      if (bytes[0] !== 1) throw malformed(`unsupported jsonb version number ${bytes[0]}`);
      return utf8.decode(bytes.subarray(1));
    case 1560:
    case 1562: {
      const bits = view.getInt32(0);
      return Array.from({ length: bits }, (_, i) =>
        (bytes[4 + (i >> 3)] as number) & (0x80 >> (i & 7)) ? "1" : "0",
      ).join("");
    }
    case 0:
    case 18:
    case 19:
    case 25:
    case 114:
    case 142:
    case 1042:
    case 1043:
      return utf8.decode(bytes);
    default:
      throw unsupported(`binary parameter format is not supported for type oid ${oid}`);
  }
};

const arrayElementLiteral = (text: string): string =>
  text === "" || /^null$/i.test(text) || /[\s{},"\\]/.test(text)
    ? `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : text;

const arrayText = (bytes: Uint8Array): string => {
  if (bytes.length < 12) throw malformed("invalid message format");
  const view = viewOf(bytes);
  const ndim = view.getInt32(0);
  const elementOid = view.getUint32(8);
  if (ndim < 0 || ndim > 6) throw malformed(`number of array dimensions (${ndim}) exceeds the maximum allowed (6)`);
  if (ndim === 0) return "{}";
  const dims: number[] = [];
  const lowerBounds: number[] = [];
  let at = 12;
  for (let i = 0; i < ndim; i++) {
    dims.push(view.getInt32(at));
    lowerBounds.push(view.getInt32(at + 4));
    at += 8;
  }
  const cells: string[] = [];
  const total = dims.reduce((count, length) => count * length, 1);
  for (let i = 0; i < total; i++) {
    if (at + 4 > bytes.length) throw malformed("insufficient data left in message");
    const length = view.getInt32(at);
    at += 4;
    if (length === -1) {
      cells.push("NULL");
      continue;
    }
    if (length < 0 || at + length > bytes.length) throw malformed("insufficient data left in message");
    cells.push(arrayElementLiteral(scalarText(elementOid, bytes.subarray(at, at + length))));
    at += length;
  }
  let next = 0;
  const level = (dim: number): string =>
    `{${Array.from({ length: dims[dim] as number }, () => (dim === ndim - 1 ? (cells[next++] as string) : level(dim + 1))).join(",")}}`;
  const body = level(0);
  if (lowerBounds.every((bound) => bound === 1)) return body;
  return `${dims.map((length, i) => `[${lowerBounds[i]}:${(lowerBounds[i] as number) + length - 1}]`).join("")}=${body}`;
};

/** A binary-format parameter as the engine takes it: text binds as an untyped literal, binary by its OID. */
export const decodeBinaryParam = (oid: number, bytes: Uint8Array): BindValue => {
  const view = viewOf(bytes);
  switch (oid) {
    case 16:
      return bytes[0] !== 0;
    case 21:
      return view.getInt16(0);
    case 23:
      return view.getInt32(0);
    case 26:
      return view.getUint32(0);
    case 20:
      return view.getBigInt64(0);
    case 700:
      return view.getFloat32(0);
    case 701:
      return view.getFloat64(0);
    case 17:
      return new Uint8Array(bytes);
    default:
      if (ARRAY_OID_SET.has(oid)) return arrayText(bytes);
      return scalarText(oid, bytes);
  }
};
