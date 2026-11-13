import { pgError, unsupported } from "../errors/error.ts";
import {
  DATE_NEG_INF,
  DATE_POS_INF,
  type Interval,
  makeInterval,
  splitTs,
  type TimeTz,
  TS_NEG_INF,
  TS_POS_INF,
  todayAt,
  USECS_PER_DAY,
} from "./datetime.ts";
import { type JsonbValue, jsonbText, parseJsonText } from "./jsonb.ts";
import {
  applyNumericTypmod,
  makeNumeric,
  type Numeric,
  numericFromBigInt,
  numericFromNumber,
  numericRescale,
  numericToBigInt,
  numericToNumber,
  parseNumeric,
} from "./numeric.ts";
import {
  arrayElemType,
  checkInt2,
  checkInt4,
  checkInt8,
  type Datum,
  datumFromText,
  datumText,
  enumTypeName,
  INT2_MAX,
  INT2_MIN,
  INT4_MAX,
  INT4_MIN,
  type InputCtx,
  isArrayType,
  isCompositeType,
  isEnumType,
  type JsonbWrap,
  makeArray,
  type OutputCtx,
  type PgArray,
  type PgRecord,
  type TypedValue,
  type TypeId,
  type TypeMod,
  tv,
  typeDisplayName,
  wrapJsonb,
} from "./value.ts";
import { networkCastText, networkInput, networkToCidr } from "./network.ts";
import { DEFAULT_COMPARE_CTX } from "./compare.ts";
import { isMultirangeType, makeMultirange, multirangeRange } from "./multirange.ts";
import type { PgRange } from "./range.ts";
import { isRangeType } from "./range-types.ts";
import { oidFromInteger } from "./regnamespace.ts";
import { checkExpectedDim, vectorCast, vectorDims } from "./vector.ts";

export interface CastEnv extends OutputCtx, InputCtx {
  enumLabels(enumType: TypeId): string[] | null;
  /** The oid a regtype / regproc name stands for, and the name of an oid (null when none has it). */
  regOid?(t: "regtype" | "regproc", name: string): number | null;
  regName?(t: "regtype" | "regproc", oid: number): string | null;
}

export const UTC_CAST_ENV: CastEnv = {
  zoneOffsetAt: () => 0,
  zoneOffsetForNaive: () => 0,
  enumLabels: () => null,
};

function cannotCast(from: TypeId, to: TypeId): never {
  throw pgError("cannot_coerce", `cannot cast type ${typeDisplayName(from)} to ${typeDisplayName(to)}`);
}

/** round-half-to-even for float→int casts (PG rint semantics) */
function rint(v: number): number {
  const floor = Math.floor(v);
  const diff = v - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

const NUMERIC_TYPES = new Set(["int2", "int4", "int8", "float4", "float8", "numeric"]);
const TEXT_TYPES = new Set(["text", "varchar", "bpchar", "name", "unknown"]);
const DATETIME_TYPES = new Set(["date", "time", "timetz", "timestamp", "timestamptz", "interval"]);

export function isTextType(t: TypeId): boolean {
  return TEXT_TYPES.has(t);
}

export function isNumericType(t: TypeId): boolean {
  return NUMERIC_TYPES.has(t);
}

export function isDatetimeType(t: TypeId): boolean {
  return DATETIME_TYPES.has(t);
}

/** implicit-cast reachability (subset of pg_cast castcontext = 'i') */
export function canImplicitCast(from: TypeId, to: TypeId): boolean {
  if (from === to) return true;
  if (from === "unknown") return true;
  if (isArrayType(from) && isArrayType(to)) return canImplicitCast(arrayElemType(from), arrayElemType(to));
  const key = `${from}->${to}`;
  return IMPLICIT_CASTS.has(key);
}

const IMPLICIT_CASTS = new Set([
  "int2->int4",
  "int2->int8",
  "int2->numeric",
  "int2->float4",
  "int2->float8",
  "int4->int8",
  "int4->numeric",
  "int4->float4",
  "int4->float8",
  "int2->oid",
  "int4->oid",
  "int8->oid",
  "regnamespace->oid",
  "regrole->oid",
  "oid->regrole",
  "cidr->inet",
  "regclass->oid",
  "oid->regclass",
  // regtype / regproc compare with an oid as the oid (the explicit oid -> reg* casts stay explicit here)
  "regtype->oid",
  "regproc->oid",
  "int2->regclass",
  "int4->regclass",
  "int8->regclass",
  "int8->numeric",
  "int8->float4",
  "int8->float8",
  "numeric->float4",
  "numeric->float8",
  "float4->float8",
  "text->varchar",
  "varchar->text",
  "bpchar->text",
  "text->name",
  "name->text",
  "varchar->name",
  "date->timestamp",
  "date->timestamptz",
  "timestamp->timestamptz",
  "time->timetz",
  "time->interval",
  "int4->money",
  "int8->money",
  "numeric->money",
  // pgvector: vector -> real[] is implicit
  "vector->float4[]",
  "bit->varbit",
  "varbit->bit",
]);

/** assignment casts additionally allowed when storing into a column */
const ASSIGNMENT_CASTS = new Set([
  "int4->int2",
  "int8->int2",
  "int8->int4",
  "numeric->int2",
  "numeric->int4",
  "numeric->int8",
  "float4->int2",
  "float4->int4",
  "float4->int8",
  "float8->int2",
  "float8->int4",
  "float8->int8",
  "float8->float4",
  "float4->numeric",
  "float8->numeric",
  "money->numeric",
  "text->bpchar",
  "varchar->bpchar",
  "bpchar->varchar",
  "bpchar->name",
  "name->varchar",
  "name->bpchar",
  "timestamp->date",
  "timestamptz->date",
  "timestamp->time",
  "timestamptz->time",
  "timestamptz->timestamp",
  "timestamptz->timetz",
  "timetz->time",
  "interval->time",
  // pgvector: int[] / real[] / double precision[] / numeric[] -> vector
  "int4[]->vector",
  "float4[]->vector",
  "float8[]->vector",
  "numeric[]->vector",
]);

export function canAssignCast(from: TypeId, to: TypeId): boolean {
  if (canImplicitCast(from, to)) return true;
  if (isArrayType(from) && isArrayType(to)) return canAssignCast(arrayElemType(from), arrayElemType(to));
  if (isEnumType(to) && TEXT_TYPES.has(from)) return true;
  return ASSIGNMENT_CASTS.has(`${from}->${to}`);
}

export interface CastOptions {
  explicit?: boolean;
  mod?: TypeMod | null;
  /** true for INSERT/UPDATE assignment (allows assignment casts + typmod coercion with truncation errors) */
  assignment?: boolean;
}

/** Cast a typed value to `target`. */
export function castTo(env: CastEnv, value: TypedValue, target: TypeId, opts: CastOptions = {}): TypedValue {
  if (isCompositeType(target) || isCompositeType(value.t)) {
    const composite = castComposite(env, value, target, opts);
    if (composite) return composite;
  }
  // a range is the one-range multirange of its type
  if (isMultirangeType(target) && isRangeType(value.t) && multirangeRange(target) === value.t) {
    return tv(target, value.v === null ? null : makeMultirange(value.t, [value.v as PgRange], DEFAULT_COMPARE_CTX));
  }
  const { t: from, v } = value;
  if (v === null) return tv(target, applyNullTypmod(target, opts));
  if (from === target) {
    return tv(target, applyTypmod(env, target, v, opts));
  }

  // unknown (string literal) → parse via typinput
  if (
    from === "unknown" ||
    (TEXT_TYPES.has(from) && (opts.explicit || opts.assignment || TEXT_TYPES.has(target) || target === "unknown"))
  ) {
    if (TEXT_TYPES.has(target)) {
      // bpchar → text/varchar strips trailing blanks (rtrim cast in PG)
      const s = from === "bpchar" && target !== "bpchar" ? (v as string).replace(/ +$/, "") : (v as string);
      return tv(target, applyTypmod(env, target, s, opts));
    }
    if (from === "unknown") {
      const parsed = datumFromText(target, v as string, env);
      return tv(target, applyTypmod(env, target, parsed, opts));
    }
  }

  // text-ish → anything (explicit or assignment): via typinput
  if (TEXT_TYPES.has(from) && !TEXT_TYPES.has(target)) {
    if (target === "bytea" && from !== "unknown") {
      // text → bytea explicit is allowed only via convert_to; ::bytea parses literal
      const parsed = datumFromText("bytea", v as string, env);
      return tv(target, parsed);
    }
    const parsed = datumFromText(target, v as string, env);
    return tv(target, applyTypmod(env, target, parsed, opts));
  }

  // anything → text-ish: via typoutput (bool special-cases to true/false)
  if (TEXT_TYPES.has(target)) {
    let text: string;
    if (from === "bool") text = (v as boolean) ? "true" : "false";
    else if (from === "inet") text = networkCastText(v as string);
    else text = datumText(from, v, env);
    return tv(target, applyTypmod(env, target, text, opts));
  }

  // numeric family
  if (NUMERIC_TYPES.has(from) && NUMERIC_TYPES.has(target)) {
    return tv(target, applyTypmod(env, target, numericFamilyCast(from, target, v), opts));
  }

  // bool ↔ int4
  if (from === "bool" && target === "int4") return tv(target, (v as boolean) ? 1 : 0);
  if (from === "int4" && target === "bool") return tv(target, (v as number) !== 0);

  // bytea ↔ integer (new in PG 18): big-endian two's complement
  if (from === "bytea" && (target === "int2" || target === "int4" || target === "int8")) {
    const bytes = v as Uint8Array;
    const width = target === "int2" ? 2 : target === "int4" ? 4 : 8;
    if (bytes.length > width) {
      const label = target === "int2" ? "smallint" : target === "int4" ? "integer" : "bigint";
      throw pgError("numeric_value_out_of_range", `${label} out of range`, "22003");
    }
    let acc = 0n;
    for (const b of bytes) acc = (acc << 8n) | BigInt(b);
    // shorter inputs zero-extend; sign bit applies only at full width
    const signed = bytes.length === width ? BigInt.asIntN(width * 8, acc) : acc;
    return tv(target, target === "int8" ? signed : Number(signed));
  }
  if ((from === "int2" || from === "int4" || from === "int8") && target === "bytea") {
    const width = from === "int2" ? 2 : from === "int4" ? 4 : 8;
    const acc = BigInt.asUintN(width * 8, typeof v === "bigint" ? v : BigInt(v as number));
    const bytes = new Uint8Array(width);
    for (let i = width - 1; i >= 0; i--) bytes[i] = Number((acc >> BigInt((width - 1 - i) * 8)) & 0xffn);
    return tv(target, bytes);
  }

  // money
  if (from === "money" && target === "numeric") {
    return tv(target, applyTypmod(env, target, makeNumeric(v as bigint, 2), opts));
  }
  if (NUMERIC_TYPES.has(from) && target === "money") {
    const n = numericFamilyCast(from, "numeric", v) as Numeric;
    return tv(target, numericRescale(n, 2).coef);
  }

  // datetime
  if (DATETIME_TYPES.has(from) && DATETIME_TYPES.has(target)) {
    return tv(target, datetimeCast(env, from, target, v));
  }

  // enum ↔ text handled above (enum output). text → enum:
  if (isEnumType(target) && TEXT_TYPES.has(from)) {
    const labels = env.enumLabels(target);
    const label = v as string;
    if (labels && !labels.includes(label)) {
      throw pgError("invalid_text_representation", `invalid input value for enum ${enumTypeName(target)}: "${label}"`);
    }
    return tv(target, label);
  }
  if (isEnumType(from) && TEXT_TYPES.has(target)) {
    return tv(target, applyTypmod(env, target, v as string, opts));
  }

  // json/jsonb
  if (from === "json" && target === "jsonb") return tv(target, wrapJsonb(parseJsonText(v as string)));
  if (from === "jsonb" && target === "json") return tv(target, jsonbText((v as JsonbWrap).value));
  if (from === "jsonb" && (NUMERIC_TYPES.has(target) || target === "bool")) {
    return tv(target, jsonbScalarCast((v as JsonbWrap).value, target));
  }

  // pgvector: arrays -> vector (assignment), vector -> real[] (implicit)
  if (target === "vector" || from === "vector") {
    const allowed = opts.explicit || opts.assignment || canImplicitCast(from, target);
    const cast = allowed ? vectorCast(from, target, v, opts.mod?.a) : undefined;
    if (cast !== undefined) return tv(target, cast);
  }

  // arrays
  if (isArrayType(from) && isArrayType(target)) {
    const fromElem = arrayElemType(from);
    const toElem = arrayElemType(target);
    const arr = v as PgArray;
    const items = arr.items.map((item) =>
      item === null
        ? null
        : castTo(env, tv(fromElem, item), toElem, { explicit: opts.explicit, assignment: opts.assignment }).v,
    );
    return tv(target, makeArray(toElem, items, arr.dims.slice(), arr.lbs.slice()));
  }

  // cidr -> inet keeps the address and mask; inet -> cidr drops the host bits (an assignment cast)
  if (from === "cidr" && target === "inet") return tv(target, networkInput("inet", v as string));
  if (from === "inet" && target === "cidr") return tv(target, networkToCidr(v as string));

  // oid family
  if (from === "oid" && (target === "regnamespace" || target === "regclass" || target === "regrole")) {
    return tv(target, v);
  }
  if (
    (from === "regnamespace" || from === "regclass" || from === "regrole") &&
    (target === "oid" || target === "int4" || target === "int8")
  ) {
    return tv(target, target === "int8" ? BigInt(v as number) : v);
  }
  if (
    (from === "int4" || from === "int8" || from === "int2") &&
    (target === "oid" || target === "regnamespace" || target === "regrole")
  ) {
    return tv(target, oidFromInteger(v as number | bigint));
  }
  // xid8 -> xid keeps the low 32 bits (the epoch is dropped)
  if (from === "xid8" && target === "xid") return tv(target, Number(BigInt.asUintN(32, v as bigint)));
  if ((from === "int4" || from === "int8" || from === "int2") && target === "regclass") {
    return tv(target, Number(v));
  }
  // regtype / regproc keep the name their output prints; the oid comes from the catalog
  if ((from === "regtype" || from === "regproc") && (target === "oid" || target === "int4" || target === "int8")) {
    const oid = env.regOid?.(from, v as string) ?? 0;
    return tv(target, target === "int8" ? BigInt(oid) : oid);
  }
  if (
    (from === "oid" || from === "int4" || from === "int8" || from === "int2") &&
    (target === "regtype" || target === "regproc")
  ) {
    const oid = oidFromInteger(v as number | bigint);
    return tv(target, env.regName?.(target, oid) ?? String(oid));
  }
  if (from === "oid" && (target === "int4" || target === "int8")) {
    return tv(target, target === "int8" ? BigInt(v as number) : (v as number));
  }

  const bits = castBitString(env, from, target, v, opts);
  if (bits !== null) return bits;

  if (!opts.explicit && !opts.assignment) cannotCast(from, target);
  cannotCast(from, target);
}

const isBitType = (t: TypeId): boolean => t === "bit" || t === "varbit";

/** bit ↔ varbit (length coercion), int4/int8 → bit(n) and bit → int4/int8; null when none applies. */
function castBitString(env: CastEnv, from: TypeId, target: TypeId, v: Datum, opts: CastOptions): TypedValue | null {
  if (isBitType(from) && isBitType(target)) return tv(target, applyTypmod(env, target, v, opts));
  if ((from === "int4" || from === "int8") && target === "bit" && opts.explicit) {
    // bitfromint4/8: the low n bits of the two's complement value, sign-extended past its width
    const n = opts.mod?.a ?? 1;
    const raw = typeof v === "bigint" ? v : BigInt(v as number);
    return tv(target, n === 0 ? "" : BigInt.asUintN(n, raw).toString(2).padStart(n, "0"));
  }
  if (from === "bit" && (target === "int4" || target === "int8") && opts.explicit) {
    const s = v as string;
    const width = target === "int4" ? 32 : 64;
    if (s.length > width) {
      throw pgError("numeric_value_out_of_range", `${target === "int4" ? "integer" : "bigint"} out of range`, "22003");
    }
    const acc = s.length === 0 ? 0n : BigInt(`0b${s}`);
    const signed = BigInt.asIntN(width, acc);
    return tv(target, target === "int8" ? signed : Number(signed));
  }
  return null;
}

/**
 * Casts to and from composite types: a row of the composite's width takes its attribute types (each
 * field assignment-cast), a composite is a record. Null when the generic rules apply (text I/O).
 */
function castComposite(env: CastEnv, value: TypedValue, target: TypeId, opts: CastOptions): TypedValue | null {
  if (!isCompositeType(target)) {
    return isCompositeType(value.t) && target === "record" ? tv("record", value.v) : null;
  }
  if (value.t === target) return value.v === null ? tv(target, null) : value;
  if (value.t !== "record" && !isCompositeType(value.t)) return null;
  if (value.v === null) return tv(target, null);
  const attrs = env.compositeAttributes?.(target);
  if (!attrs) throw pgError("undefined_object", `type "${typeDisplayName(target)}" does not exist`, "42704");
  const rec = value.v as PgRecord;
  if (rec.values.length !== attrs.types.length) {
    throw pgError(
      "cannot_coerce",
      `cannot cast type ${typeDisplayName(value.t)} to ${typeDisplayName(target)}`,
      "42846",
    );
  }
  const values = attrs.types.map(
    (type, i) =>
      castTo(env, tv(rec.types[i] ?? "unknown", rec.values[i] ?? null), type, {
        explicit: opts.explicit,
        assignment: true,
      }).v,
  );
  return tv(target, { kind: "pgrecord", types: attrs.types.slice(), values, names: attrs.names.slice() });
}

function applyNullTypmod(_target: TypeId, _opts: CastOptions): null {
  return null;
}

function jsonbScalarCast(j: JsonbValue, target: TypeId): Datum {
  if (target === "bool") {
    if (j.j !== "bool")
      throw pgError("invalid_parameter_value", `cannot cast jsonb ${jsonbTypeName(j)} to type boolean`, "22023");
    return j.v;
  }
  if (j.j !== "num") {
    throw pgError(
      "invalid_parameter_value",
      `cannot cast jsonb ${jsonbTypeName(j)} to type ${typeDisplayName(target)}`,
      "22023",
    );
  }
  return numericFamilyCast("numeric", target, j.v);
}

function jsonbTypeName(j: JsonbValue): string {
  switch (j.j) {
    case "null":
      return "null";
    case "bool":
      return "boolean";
    case "num":
      return "numeric";
    case "str":
      return "string";
    case "arr":
      return "array";
    case "obj":
      return "object";
  }
}

export function numericFamilyCast(from: TypeId, to: TypeId, v: Datum): Datum {
  if (from === to) return v;
  const asNumber = (): number => {
    if (from === "int8") return Number(v as bigint);
    if (from === "numeric") return numericToNumber(v as Numeric);
    return v as number;
  };
  switch (to) {
    case "int2": {
      if (from === "float4" || from === "float8") {
        const f = v as number;
        if (Number.isNaN(f) || !Number.isFinite(f))
          throw pgError("numeric_value_out_of_range", "smallint out of range");
        return checkInt2(rint(f));
      }
      if (from === "int8") {
        const b = v as bigint;
        if (b < BigInt(INT2_MIN) || b > BigInt(INT2_MAX))
          throw pgError("numeric_value_out_of_range", "smallint out of range");
        return Number(b);
      }
      if (from === "numeric") {
        const b = numericToBigInt(v as Numeric);
        if (b < BigInt(INT2_MIN) || b > BigInt(INT2_MAX))
          throw pgError("numeric_value_out_of_range", "smallint out of range");
        return Number(b);
      }
      return checkInt2(v as number);
    }
    case "int4": {
      if (from === "float4" || from === "float8") {
        const f = v as number;
        if (Number.isNaN(f) || !Number.isFinite(f)) throw pgError("numeric_value_out_of_range", "integer out of range");
        return checkInt4(rint(f));
      }
      if (from === "int8") {
        const b = v as bigint;
        if (b < BigInt(INT4_MIN) || b > BigInt(INT4_MAX))
          throw pgError("numeric_value_out_of_range", "integer out of range");
        return Number(b);
      }
      if (from === "numeric") {
        const b = numericToBigInt(v as Numeric);
        if (b < BigInt(INT4_MIN) || b > BigInt(INT4_MAX))
          throw pgError("numeric_value_out_of_range", "integer out of range");
        return Number(b);
      }
      return checkInt4(v as number);
    }
    case "int8": {
      if (from === "float4" || from === "float8") {
        const f = v as number;
        if (Number.isNaN(f) || !Number.isFinite(f)) throw pgError("numeric_value_out_of_range", "bigint out of range");
        const r = rint(f);
        if (r < -(2 ** 63) || r >= 2 ** 63) {
          throw pgError("numeric_value_out_of_range", "bigint out of range");
        }
        return BigInt(r);
      }
      if (from === "numeric") {
        const b = numericToBigInt(v as Numeric);
        return checkInt8(b);
      }
      return BigInt(v as number);
    }
    case "float4": {
      const f = Math.fround(asNumber());
      if (!Number.isFinite(f) && Number.isFinite(asNumber())) {
        throw pgError("numeric_value_out_of_range", `value out of range: overflow`);
      }
      return f;
    }
    case "float8":
      return asNumber();
    case "numeric": {
      if (from === "int8") return numericFromBigInt(v as bigint);
      if (from === "int2" || from === "int4") return numericFromBigInt(BigInt(v as number));
      // float → numeric via shortest representation
      const f = v as number;
      if (Number.isNaN(f)) return parseNumeric("NaN");
      if (f === Number.POSITIVE_INFINITY) return parseNumeric("Infinity");
      if (f === Number.NEGATIVE_INFINITY) return parseNumeric("-Infinity");
      return numericFromNumber(f);
    }
    default:
      cannotCast(from, to);
  }
}

function datetimeCast(env: CastEnv, from: TypeId, to: TypeId, v: Datum): Datum {
  const key = `${from}->${to}`;
  switch (key) {
    case "date->timestamp": {
      const d = v as number;
      if (d === DATE_POS_INF) return TS_POS_INF;
      if (d === DATE_NEG_INF) return TS_NEG_INF;
      return BigInt(d) * USECS_PER_DAY;
    }
    case "date->timestamptz": {
      const d = v as number;
      if (d === DATE_POS_INF) return TS_POS_INF;
      if (d === DATE_NEG_INF) return TS_NEG_INF;
      const naive = BigInt(d) * USECS_PER_DAY;
      return naive - BigInt(env.zoneOffsetForNaive(naive)) * 1_000_000n;
    }
    case "timestamp->date": {
      const ts = v as bigint;
      if (ts === TS_POS_INF) return DATE_POS_INF;
      if (ts === TS_NEG_INF) return DATE_NEG_INF;
      return splitTs(ts).days;
    }
    case "timestamptz->date": {
      const ts = v as bigint;
      if (ts === TS_POS_INF) return DATE_POS_INF;
      if (ts === TS_NEG_INF) return DATE_NEG_INF;
      const local = ts + BigInt(env.zoneOffsetAt(ts)) * 1_000_000n;
      return splitTs(local).days;
    }
    case "timestamp->timestamptz": {
      const ts = v as bigint;
      if (ts === TS_POS_INF || ts === TS_NEG_INF) return ts;
      return ts - BigInt(env.zoneOffsetForNaive(ts)) * 1_000_000n;
    }
    case "timestamptz->timestamp": {
      const ts = v as bigint;
      if (ts === TS_POS_INF || ts === TS_NEG_INF) return ts;
      return ts + BigInt(env.zoneOffsetAt(ts)) * 1_000_000n;
    }
    case "timestamp->time":
      return splitTs(v as bigint).tod;
    case "timestamptz->time": {
      const ts = v as bigint;
      const local = ts + BigInt(env.zoneOffsetAt(ts)) * 1_000_000n;
      return splitTs(local).tod;
    }
    case "time->interval":
      return makeInterval(0, 0, v as bigint);
    case "interval->time": {
      const iv = v as Interval;
      let micros = iv.micros % USECS_PER_DAY;
      if (micros < 0n) micros += USECS_PER_DAY;
      return micros;
    }
    case "time->timetz": {
      // time_timetz: the session zone's offset on the current date
      const micros = v as bigint;
      return { micros, offsetSec: env.zoneOffsetForNaive(todayAt(env.datetimeNow?.(), micros)) } as unknown as Datum;
    }
    case "timestamptz->timetz": {
      const ts = v as bigint;
      // timestamptz_timetz returns NULL for ±infinity
      if (ts === TS_POS_INF || ts === TS_NEG_INF) return null;
      const offsetSec = env.zoneOffsetAt(ts);
      return { micros: splitTs(ts + BigInt(offsetSec) * 1_000_000n).tod, offsetSec } as unknown as Datum;
    }
    case "timetz->time":
      return (v as unknown as { micros: bigint }).micros;
    default:
      cannotCast(from, to);
  }
}

/** Apply typmod (varchar(n) truncation checks, numeric(p,s), bpchar padding, time precision). */
export function applyTypmod(_env: CastEnv, t: TypeId, v: Datum, opts: CastOptions): Datum {
  const mod = opts.mod;
  if (v === null) return v;
  if (!mod || mod.a === undefined) {
    if (t === "bpchar" && typeof v === "string") return v;
    return v;
  }
  switch (t) {
    case "varchar": {
      const s = v as string;
      const n = mod.a;
      if ([...s].length <= n) return s;
      const trimmed = trimForCharType(s, n);
      if (trimmed !== null && (opts.assignment || opts.explicit)) {
        if (opts.explicit && !opts.assignment) return [...s].slice(0, n).join("");
        if (trimmed.ok) return trimmed.value;
      }
      throw pgError("string_data_right_truncation", `value too long for type character varying(${n})`, "22001");
    }
    case "bpchar": {
      const s = v as string;
      const n = mod.a;
      const chars = [...s];
      if (chars.length === n) return s;
      if (chars.length < n) return s + " ".repeat(n - chars.length);
      const trimmed = trimForCharType(s, n);
      if (opts.explicit && !opts.assignment) return chars.slice(0, n).join("");
      if (trimmed?.ok) return trimmed.value.padEnd(n, " ");
      throw pgError("string_data_right_truncation", `value too long for type character(${n})`, "22001");
    }
    case "numeric": {
      if (mod.b === undefined) return applyNumericTypmod(v as Numeric, mod.a, 0);
      return applyNumericTypmod(v as Numeric, mod.a, mod.b);
    }
    case "time":
    case "timestamp":
    case "timestamptz": {
      const p = mod.a;
      if (p >= 6) return v;
      const factor = 10n ** BigInt(6 - p);
      const ts = v as bigint;
      if (ts === TS_POS_INF || ts === TS_NEG_INF) return ts;
      const half = factor / 2n;
      const rounded = ts >= 0n ? ((ts + half) / factor) * factor : -((-ts + half) / factor) * factor;
      return rounded;
    }
    case "timetz": {
      const p = mod.a;
      if (p >= 6) return v;
      const tz = v as unknown as TimeTz;
      const factor = 10n ** BigInt(6 - p);
      return { micros: ((tz.micros + factor / 2n) / factor) * factor, offsetSec: tz.offsetSec } as unknown as Datum;
    }
    case "interval":
      return v;
    case "bit": {
      // explicit casts zero-pad or truncate on the right; assignment needs the exact length
      const s = v as string;
      const n = mod.a;
      if (s.length === n) return s;
      if (opts.explicit && !opts.assignment) return s.length > n ? s.slice(0, n) : s.padEnd(n, "0");
      throw pgError("data_exception", `bit string length ${s.length} does not match type bit(${n})`, "22026");
    }
    case "varbit": {
      const s = v as string;
      const n = mod.a;
      if (s.length <= n) return s;
      if (opts.explicit && !opts.assignment) return s.slice(0, n);
      throw pgError("string_data_right_truncation", `bit string too long for type bit varying(${n})`, "22001");
    }
    case "vector":
      checkExpectedDim(mod.a, vectorDims(v));
      return v;
    default:
      return v;
  }
}

function trimForCharType(s: string, n: number): { ok: boolean; value: string } | null {
  const chars = [...s];
  const excess = chars.slice(n);
  if (excess.every((c) => c === " ")) {
    return { ok: true, value: chars.slice(0, n).join("") };
  }
  return { ok: false, value: s };
}

/** unify two types for comparison/set operations (simplified union type resolution) */
export function unifyTypes(a: TypeId, b: TypeId): TypeId | null {
  if (a === b) return a;
  if (a === "unknown") return b === "unknown" ? "text" : b;
  if (b === "unknown") return a;
  if (NUMERIC_TYPES.has(a) && NUMERIC_TYPES.has(b)) {
    const ladder = ["int2", "int4", "int8", "numeric", "float4", "float8"];
    const ia = ladder.indexOf(a);
    const ib = ladder.indexOf(b);
    return ladder[Math.max(ia, ib)]!;
  }
  if (TEXT_TYPES.has(a) && TEXT_TYPES.has(b)) return "text";
  if (canImplicitCast(a, b)) return b;
  if (canImplicitCast(b, a)) return a;
  // regrole = 10, regnamespace = int4 column: both sides cast implicitly to oid (oideq)
  if (canImplicitCast(a, "oid") && canImplicitCast(b, "oid")) return "oid";
  if (isArrayType(a) && isArrayType(b)) {
    const e = unifyTypes(arrayElemType(a), arrayElemType(b));
    return e === null ? null : `${e}[]`;
  }
  return null;
}

export { unsupported };
