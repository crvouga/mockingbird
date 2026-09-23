import { pgError } from "../errors/error.ts";
import type { EngineCtx } from "../expressions/context.ts";
import { pgRegexToJs, regexFlags } from "../expressions/pattern.ts";
import { castTo } from "../types/cast.ts";
import {
  civilToDays,
  daysInMonth,
  daysToCivil,
  intervalTotalMicros,
  isInterval,
  splitTs,
  USECS_PER_DAY,
} from "../types/datetime.ts";
import { type JsonbValue, jsonbCompactText, parseJsonText } from "../types/jsonb.ts";
import { type Numeric, numericAdd, numericCmp, numericSign } from "../types/numeric.ts";
import {
  arrayElemType,
  type Datum,
  isArrayType,
  isJsonbWrap,
  type JsonbWrap,
  makeArray,
  type PgArray,
  type TypedValue,
  type TypeId,
  tv,
  UNKNOWN,
  wrapJsonb,
} from "../types/value.ts";
import { argInt, argText } from "./util.ts";

export interface SrfResult {
  columns: Array<{ name: string; type: TypeId }>;
  rows: Datum[][];
}

export type SrfFn = (ctx: EngineCtx, args: TypedValue[], alias: string) => SrfResult;

function jsonInput(ctx: EngineCtx, a: TypedValue): JsonbValue {
  void ctx;
  if (a.t === "jsonb" || isJsonbWrap(a.v)) return (a.v as JsonbWrap).value;
  return parseJsonText(a.v as string);
}

const SRFS = new Map<string, SrfFn>();

SRFS.set("generate_series", (ctx, args, alias) => {
  if (args.length < 2 || args.length > 3) {
    throw pgError(
      "undefined_function",
      `function generate_series(${args.map((a) => a.t).join(", ")}) does not exist`,
      "42883",
    );
  }
  const a = args[0]!;
  const b = args[1]!;
  if (a.v === null || b.v === null || (args[2] !== undefined && args[2].v === null)) {
    return { columns: [{ name: alias, type: a.t === UNKNOWN ? "int4" : a.t }], rows: [] };
  }
  // timestamp series
  if (a.t === "timestamp" || a.t === "timestamptz" || b.t === "timestamp" || b.t === "timestamptz" || a.t === "date") {
    const t: TypeId = a.t === "timestamptz" || b.t === "timestamptz" ? "timestamptz" : "timestamp";
    const start = castTo(ctx, a, t, { explicit: true }).v as bigint;
    const stop = castTo(ctx, b, t, { explicit: true }).v as bigint;
    const stepArg = args[2];
    if (stepArg === undefined || !isInterval(stepArg.v)) {
      throw pgError(
        "undefined_function",
        "function generate_series(timestamp, timestamp) requires an interval step",
        "42883",
      );
    }
    const step = stepArg.v;
    const rows: Datum[][] = [];
    if (step.months !== 0) {
      // month-wise stepping
      let i = 0;
      for (;;) {
        const { days, tod } = splitTs(start);
        const c = daysToCivil(days);
        const totalMonths = c.y * 12 + (c.m - 1) + step.months * i;
        const y = Math.floor(totalMonths / 12);
        const mo = (totalMonths % 12) + 1;
        const d = Math.min(c.d, daysInMonth(y, mo));
        const cur = BigInt(civilToDays(y, mo, d) + step.days * i) * USECS_PER_DAY + tod + step.micros * BigInt(i);
        if (step.months > 0 || step.days > 0 || step.micros > 0n ? cur > stop : cur < stop) break;
        rows.push([cur]);
        i++;
        if (i > 10_000_000) throw pgError("program_limit_exceeded", "generate_series result set too large", "54000");
      }
      return { columns: [{ name: alias, type: t }], rows };
    }
    const stepMicros = intervalTotalMicros(step);
    if (stepMicros === 0n) throw pgError("invalid_parameter_value", "step size cannot equal zero", "22023");
    if (stepMicros > 0n) {
      for (let cur = start; cur <= stop; cur += stepMicros) rows.push([cur]);
    } else {
      for (let cur = start; cur >= stop; cur += stepMicros) rows.push([cur]);
    }
    return { columns: [{ name: alias, type: t }], rows };
  }
  // numeric series
  if (a.t === "numeric" || b.t === "numeric" || args[2]?.t === "numeric") {
    const start = castTo(ctx, a, "numeric", { explicit: true }).v as Numeric;
    const stop = castTo(ctx, b, "numeric", { explicit: true }).v as Numeric;
    const step = args[2]
      ? (castTo(ctx, args[2], "numeric", { explicit: true }).v as Numeric)
      : (castTo(ctx, tv("int4", 1), "numeric", { explicit: true }).v as Numeric);
    if (numericSign(step) === 0) throw pgError("invalid_parameter_value", "step size cannot equal zero", "22023");
    const rows: Datum[][] = [];
    let cur = start;
    const ascending = numericSign(step) > 0;
    while (ascending ? numericCmp(cur, stop) <= 0 : numericCmp(cur, stop) >= 0) {
      rows.push([cur]);
      cur = numericAdd(cur, step);
      if (rows.length > 10_000_000)
        throw pgError("program_limit_exceeded", "generate_series result set too large", "54000");
    }
    return { columns: [{ name: alias, type: "numeric" }], rows };
  }
  const useBig = a.t === "int8" || b.t === "int8" || args[2]?.t === "int8";
  const t: TypeId = useBig ? "int8" : "int4";
  const start = castTo(ctx, a, "int8", {}).v as bigint;
  const stop = castTo(ctx, b, "int8", {}).v as bigint;
  const step = args[2] ? (castTo(ctx, args[2], "int8", {}).v as bigint) : 1n;
  if (step === 0n) throw pgError("invalid_parameter_value", "step size cannot equal zero", "22023");
  const rows: Datum[][] = [];
  if (step > 0n) {
    for (let cur = start; cur <= stop; cur += step) {
      rows.push([useBig ? cur : Number(cur)]);
      if (rows.length > 10_000_000)
        throw pgError("program_limit_exceeded", "generate_series result set too large", "54000");
    }
  } else {
    for (let cur = start; cur >= stop; cur += step) {
      rows.push([useBig ? cur : Number(cur)]);
      if (rows.length > 10_000_000)
        throw pgError("program_limit_exceeded", "generate_series result set too large", "54000");
    }
  }
  return { columns: [{ name: alias, type: t }], rows };
});

SRFS.set("generate_subscripts", (ctx, args, alias) => {
  const a = args[0]!;
  if (a.v === null || args[1]!.v === null) return { columns: [{ name: alias, type: "int4" }], rows: [] };
  if (!isArrayType(a.t)) throw pgError("datatype_mismatch", "generate_subscripts requires an array", "42804");
  const arr = a.v as PgArray;
  const dim = argInt(ctx, args[1]!);
  const reverse = args.length > 2 && args[2]!.v === true;
  const dims = arr.dims.length > 0 ? arr.dims : arr.items.length === 0 ? [] : [arr.items.length];
  const lbs = arr.lbs.length === dims.length ? arr.lbs : dims.map(() => 1);
  if (dim < 1 || dim > dims.length) return { columns: [{ name: alias, type: "int4" }], rows: [] };
  const lo = lbs[dim - 1]!;
  const hi = lo + dims[dim - 1]! - 1;
  const rows: Datum[][] = [];
  if (reverse) {
    for (let i = hi; i >= lo; i--) rows.push([i]);
  } else {
    for (let i = lo; i <= hi; i++) rows.push([i]);
  }
  return { columns: [{ name: alias, type: "int4" }], rows };
});

SRFS.set("unnest", (_ctx, args, alias) => {
  if (args.length === 1) {
    const a = args[0]!;
    if (a.v === null)
      return { columns: [{ name: alias, type: a.t === UNKNOWN ? "text" : arrayElemType(a.t) }], rows: [] };
    if (!isArrayType(a.t)) throw pgError("datatype_mismatch", "unnest requires an array", "42804");
    const arr = a.v as PgArray;
    return {
      columns: [{ name: alias, type: arrayElemType(a.t) }],
      rows: arr.items.map((item) => [item]),
    };
  }
  // multi-array unnest: zip with nulls
  const arrays = args.map((a) => {
    if (a.v === null) return { elem: a.t === UNKNOWN ? "text" : arrayElemType(a.t), items: [] as Datum[] };
    if (!isArrayType(a.t)) throw pgError("datatype_mismatch", "unnest requires an array", "42804");
    return { elem: arrayElemType(a.t), items: (a.v as PgArray).items };
  });
  const maxLen = Math.max(...arrays.map((a) => a.items.length));
  const rows: Datum[][] = [];
  for (let i = 0; i < maxLen; i++) {
    rows.push(arrays.map((a) => a.items[i] ?? null));
  }
  return {
    columns: arrays.map((a, i) => ({
      name: arrays.length === 1 ? alias : `unnest${i > 0 ? `_${i + 1}` : ""}`,
      type: a.elem,
    })),
    rows,
  };
});

SRFS.set("string_to_table", (ctx, args, alias) => {
  const a = args[0]!;
  if (a.v === null) return { columns: [{ name: alias, type: "text" }], rows: [] };
  const s = argText(ctx, a);
  const delim = args[1]!.v === null ? null : argText(ctx, args[1]!);
  const nullStr = args.length > 2 && args[2]!.v !== null ? argText(ctx, args[2]!) : null;
  let parts: string[];
  if (delim === null) parts = [...s];
  else if (delim === "") parts = [s];
  else parts = s.split(delim);
  const rows = parts.map((p) => [nullStr !== null && p === nullStr ? null : p] as Datum[]);
  return { columns: [{ name: alias, type: "text" }], rows };
});

SRFS.set("regexp_split_to_table", (ctx, args, alias) => {
  const s = args[0]!.v === null ? null : argText(ctx, args[0]!);
  if (s === null || args[1]!.v === null) return { columns: [{ name: alias, type: "text" }], rows: [] };
  const pattern = argText(ctx, args[1]!);
  const flags = args.length > 2 ? argText(ctx, args[2]!) : "";
  const re = new RegExp(pgRegexToJs(pattern), `${regexFlags(flags, true)}g`);
  const out: string[] = [];
  let last = 0;
  for (const match of s.matchAll(re)) {
    if (match[0] === "" && match.index === last && match.index !== s.length) continue;
    out.push(s.slice(last, match.index));
    last = match.index + match[0].length;
  }
  out.push(s.slice(last));
  return { columns: [{ name: alias, type: "text" }], rows: out.map((p) => [p]) };
});

SRFS.set("regexp_matches", (ctx, args, alias) => {
  const s = args[0]!.v === null ? null : argText(ctx, args[0]!);
  if (s === null || args[1]!.v === null) return { columns: [{ name: alias, type: "text[]" }], rows: [] };
  const pattern = argText(ctx, args[1]!);
  const flags = args.length > 2 ? argText(ctx, args[2]!) : "";
  const global = flags.includes("g");
  const re = new RegExp(pgRegexToJs(pattern), `${regexFlags(flags, true)}g`);
  const rows: Datum[][] = [];
  for (const match of s.matchAll(re)) {
    const groups = match.length > 1 ? match.slice(1) : [match[0]];
    rows.push([
      makeArray(
        "text",
        groups.map((g) => (g === undefined ? null : g)),
      ),
    ]);
    if (!global) break;
  }
  return { columns: [{ name: alias, type: "text[]" }], rows };
});

function jsonElementsSrf(asText: boolean, jsonOut: boolean): SrfFn {
  // declared with OUT value — the FROM-clause column is always "value"
  return (ctx, args, _alias) => {
    const t: TypeId = asText ? "text" : jsonOut ? "json" : "jsonb";
    if (args[0]!.v === null) return { columns: [{ name: "value", type: t }], rows: [] };
    const v = jsonInput(ctx, args[0]!);
    if (v.j !== "arr") {
      throw pgError(
        "invalid_parameter_value",
        `cannot extract elements from a ${v.j === "obj" ? "object" : "scalar"}`,
        "22023",
      );
    }
    const rows: Datum[][] = v.v.map((item) => {
      if (asText) return [item.j === "null" ? null : item.j === "str" ? item.v : jsonbCompactText(item)];
      if (jsonOut) return [jsonbCompactText(item)];
      return [wrapJsonb(item)];
    });
    return { columns: [{ name: "value", type: t }], rows };
  };
}
SRFS.set("json_array_elements", jsonElementsSrf(false, true));
SRFS.set("jsonb_array_elements", jsonElementsSrf(false, false));
SRFS.set("json_array_elements_text", jsonElementsSrf(true, true));
SRFS.set("jsonb_array_elements_text", jsonElementsSrf(true, false));

function jsonEachSrf(asText: boolean, jsonOut: boolean): SrfFn {
  return (ctx, args, _alias) => {
    const valT: TypeId = asText ? "text" : jsonOut ? "json" : "jsonb";
    const columns = [
      { name: "key", type: "text" as TypeId },
      { name: "value", type: valT },
    ];
    if (args[0]!.v === null) return { columns, rows: [] };
    const v = jsonInput(ctx, args[0]!);
    if (v.j !== "obj") {
      throw pgError("invalid_parameter_value", "cannot deconstruct a scalar", "22023");
    }
    const rows: Datum[][] = [];
    for (const [k, val] of v.v) {
      if (asText) rows.push([k, val.j === "null" ? null : val.j === "str" ? val.v : jsonbCompactText(val)]);
      else if (jsonOut) rows.push([k, jsonbCompactText(val)]);
      else rows.push([k, wrapJsonb(val)]);
    }
    return { columns, rows };
  };
}
SRFS.set("json_each", jsonEachSrf(false, true));
SRFS.set("jsonb_each", jsonEachSrf(false, false));
SRFS.set("json_each_text", jsonEachSrf(true, true));
SRFS.set("jsonb_each_text", jsonEachSrf(true, false));

function jsonKeysSrf(): SrfFn {
  return (ctx, args, alias) => {
    if (args[0]!.v === null) return { columns: [{ name: alias, type: "text" }], rows: [] };
    const v = jsonInput(ctx, args[0]!);
    if (v.j !== "obj") {
      throw pgError(
        "invalid_parameter_value",
        `cannot call ${alias} on a ${v.j === "arr" ? "array" : "scalar"}`,
        "22023",
      );
    }
    return { columns: [{ name: alias, type: "text" }], rows: [...v.v.keys()].map((k) => [k]) };
  };
}
SRFS.set("json_object_keys", jsonKeysSrf());
SRFS.set("jsonb_object_keys", jsonKeysSrf());

export function getSrfFunctions(): Map<string, SrfFn> {
  return SRFS;
}

export function isSrfName(name: string): boolean {
  return SRFS.has(name);
}
