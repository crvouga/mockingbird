import type { Int8Mode } from "../runtime/options.ts";
import { pgError } from "../errors/error.ts";
import { UNIX_EPOCH_MICROS_FROM_PG } from "../types/datetime.ts";
import { type Datum, datumText, type OutputCtx, type TypedValue, type TypeId, tv, UNKNOWN } from "../types/value.ts";

/** JavaScript values accepted as query parameters (`$1..$n`). */
export type BindValue = null | undefined | boolean | number | bigint | string | Uint8Array | Date;

/** JavaScript values produced in query result rows. */
export type JsValue = null | boolean | number | bigint | string | Uint8Array;

/** A result row keyed by column name. */
export type QueryRow = Record<string, JsValue>;

const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;

export function bindValueToTyped(value: BindValue, index: number): TypedValue {
  if (value === null || value === undefined) return tv(UNKNOWN, null);
  switch (typeof value) {
    case "boolean":
      return tv("bool", value);
    case "number":
      if (Number.isInteger(value) && value >= INT4_MIN && value <= INT4_MAX) {
        return tv("int4", value);
      }
      if (Number.isInteger(value) && Number.isSafeInteger(value)) {
        return tv("int8", BigInt(value));
      }
      return tv("float8", value);
    case "bigint":
      if (value < -9223372036854775808n || value > 9223372036854775807n) {
        throw pgError("numeric_value_out_of_range", `bigint parameter $${index + 1} out of int8 range`, "22003");
      }
      return tv("int8", value);
    case "string":
      // like an untyped literal: coerces by context
      return tv(UNKNOWN, value);
    case "object": {
      if (value instanceof Uint8Array) return tv("bytea", value);
      if (value instanceof Date) {
        const ms = value.getTime();
        if (Number.isNaN(ms)) {
          throw pgError("invalid_datetime", `invalid Date parameter $${index + 1}`, "22008");
        }
        return tv("timestamptz", BigInt(Math.round(ms)) * 1000n + UNIX_EPOCH_MICROS_FROM_PG);
      }
      break;
    }
    default:
      break;
  }
  throw pgError("misuse", `unsupported parameter type for $${index + 1}: ${typeof value}`, "XX000");
}

/** Convert an engine datum to the public JS value for result rows. */
export function datumToJs(t: TypeId, v: Datum, ctx: OutputCtx, int8: Int8Mode = "bigint"): JsValue {
  if (v === null) return null;
  switch (t) {
    case "bool":
      return v as boolean;
    case "int2":
    case "int4":
    case "oid":
      return typeof v === "bigint" ? Number(v) : (v as number);
    case "int8": {
      const n = typeof v === "bigint" ? v : BigInt(v as number);
      if (int8 === "string") return n.toString();
      if (int8 === "number") return Number(n);
      return n;
    }
    case "float4":
    case "float8":
      return v as number;
    case "bytea":
      return v as Uint8Array;
    default:
      // numeric, text family, datetime, arrays, json(b), records, enums, …
      // all surface as canonical PostgreSQL text
      return datumText(t === UNKNOWN ? "text" : t, v, ctx);
  }
}
