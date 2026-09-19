import { pgError } from "../errors/error.ts";
import type { EngineCtx } from "../expressions/context.ts";
import { castTo } from "../types/cast.ts";
import {
  JSONB_NULL,
  type JsonbValue,
  jsonbArr,
  jsonbBool,
  jsonbCompactText,
  jsonbNum,
  jsonbObj,
  jsonbStr,
  jsonbText,
  parseJsonText,
  validateJsonText,
} from "../types/jsonb.ts";
import { jsonpathQueryFirst } from "../types/jsonpath.ts";
import { type Numeric, numericFromBigInt, numericFromNumber } from "../types/numeric.ts";
import {
  arrayElemType,
  type Datum,
  datumFromText,
  isArrayType,
  isJsonbWrap,
  isPgArray,
  isPgRecord,
  type JsonbWrap,
  type PgArray,
  type PgRecord,
  type TypedValue,
  type TypeId,
  tv,
  UNKNOWN,
  UTC_INPUT,
  wrapJsonb,
} from "../types/value.ts";
import { argText, type ScalarFn, strict } from "./util.ts";

/** Convert an engine Datum to a JsonbValue tree (to_jsonb / jsonb_build_*). */
export function datumToJsonb(ctx: EngineCtx, t: TypeId, v: Datum): JsonbValue {
  if (v === null) return JSONB_NULL;
  if (isJsonbWrap(v)) return v.value;
  switch (t) {
    case "bool":
      return jsonbBool(v as boolean);
    case "int2":
    case "int4":
      return jsonbNum(numericFromBigInt(BigInt(v as number)));
    case "int8":
      return jsonbNum(numericFromBigInt(v as bigint));
    case "numeric":
      return jsonbNum(v as Numeric);
    case "float4":
    case "float8": {
      const f = v as number;
      if (!Number.isFinite(f)) {
        throw pgError("invalid_text_representation", "cannot convert non-finite float to jsonb", "22P02");
      }
      return jsonbNum(numericFromNumber(f));
    }
    case "json": {
      return parseJsonText(v as string);
    }
    default:
      break;
  }
  if (isArrayType(t)) {
    const arr = v as PgArray;
    const elem = arrayElemType(t);
    return jsonbArr(arr.items.map((item) => datumToJsonb(ctx, elem, item)));
  }
  if (isPgRecord(v)) {
    const rec = v as PgRecord;
    const entries: Array<[string, JsonbValue]> = rec.values.map((f, i) => [
      rec.names?.[i] ?? `f${i + 1}`,
      datumToJsonb(ctx, rec.types[i]!, f),
    ]);
    return jsonbObj(entries);
  }
  // everything else renders through its text output
  const text = castTo(ctx, tv(t, v), "text", { explicit: true }).v as string;
  return jsonbStr(text);
}

function jsonArg(_ctx: EngineCtx, a: TypedValue): JsonbValue {
  if (a.t === "jsonb" || isJsonbWrap(a.v)) return (a.v as JsonbWrap).value;
  if (a.t === "json" || a.t === UNKNOWN || a.t === "text") {
    return parseJsonText(a.v as string);
  }
  throw pgError("datatype_mismatch", `cannot use type ${a.t} as json`);
}

function _isJsonType(a: TypedValue): boolean {
  return a.t === "json";
}

/** Render a JsonbValue as `json` text (preserves nothing — we canonicalize like jsonb). */
function outJson(v: JsonbValue): TypedValue {
  return tv("json", jsonbCompactText(v));
}

function outJsonb(v: JsonbValue): TypedValue {
  return tv("jsonb", wrapJsonb(v));
}

export function getJsonFunctions(): Map<string, ScalarFn> {
  const m = new Map<string, ScalarFn>();

  m.set(
    "to_json",
    strict("json", (ctx, args) => outJson(datumToJsonb(ctx, args[0]!.t, args[0]!.v))),
  );
  m.set(
    "to_jsonb",
    strict("jsonb", (ctx, args) => outJsonb(datumToJsonb(ctx, args[0]!.t, args[0]!.v))),
  );
  m.set(
    "row_to_json",
    strict("json", (ctx, args) => outJson(datumToJsonb(ctx, args[0]!.t, args[0]!.v))),
  );
  m.set(
    "array_to_json",
    strict("json", (ctx, args) => outJson(datumToJsonb(ctx, args[0]!.t, args[0]!.v))),
  );

  // json_build_* renders with PG's `json_build` spacing at the top level: `[1, 2]`, `{"a" : 1}`.
  m.set("json_build_array", (ctx, args) =>
    tv("json", `[${args.map((a) => jsonbCompactText(datumToJsonb(ctx, a.t, a.v))).join(", ")}]`),
  );
  m.set("jsonb_build_array", (ctx, args) => outJsonb(jsonbArr(args.map((a) => datumToJsonb(ctx, a.t, a.v)))));
  m.set("json_build_object", (ctx, args) => tv("json", buildSpacedObjectText(buildObject(ctx, args))));
  m.set("jsonb_build_object", (ctx, args) => outJsonb(buildObject(ctx, args)));

  m.set(
    "json_object",
    strict("json", (ctx, args) => tv("json", buildSpacedObjectText(jsonObjectFromArrays(ctx, args)))),
  );
  m.set(
    "jsonb_object",
    strict("jsonb", (ctx, args) => outJsonb(jsonObjectFromArrays(ctx, args))),
  );

  const typeofFn = strict("text", (ctx: EngineCtx, args: TypedValue[]) => {
    const v = jsonArg(ctx, args[0]!);
    switch (v.j) {
      case "null":
        return tv("text", "null");
      case "bool":
        return tv("text", "boolean");
      case "num":
        return tv("text", "number");
      case "str":
        return tv("text", "string");
      case "arr":
        return tv("text", "array");
      case "obj":
        return tv("text", "object");
    }
  });
  m.set("json_typeof", typeofFn);
  m.set("jsonb_typeof", typeofFn);

  const jsonpathArg = (ctx: EngineCtx, arg: TypedValue): string =>
    arg.t === "jsonpath" ? (arg.v as string) : argText(ctx, arg);

  m.set("jsonb_path_query_first", (ctx, args) => {
    if (args.length < 2) {
      throw pgError(
        "undefined_function",
        `function jsonb_path_query_first(${args.map((a) => a.t).join(", ")}) does not exist`,
        "42883",
      );
    }
    if (args[0]!.v === null || args[1]!.v === null) return tv("jsonb", null);
    const doc = jsonArg(ctx, args[0]!);
    const found = jsonpathQueryFirst(doc, jsonpathArg(ctx, args[1]!));
    if (found === null) return tv("jsonb", null);
    return outJsonb(found);
  });

  m.set("jsonb_path_exists", (ctx, args) => {
    if (args.length < 2) {
      throw pgError(
        "undefined_function",
        `function jsonb_path_exists(${args.map((a) => a.t).join(", ")}) does not exist`,
        "42883",
      );
    }
    if (args[0]!.v === null || args[1]!.v === null) return tv("bool", null);
    const doc = jsonArg(ctx, args[0]!);
    return tv("bool", jsonpathQueryFirst(doc, jsonpathArg(ctx, args[1]!)) !== null);
  });

  m.set(
    "json_array_length",
    strict("int4", (ctx, args) => {
      const v = jsonArg(ctx, args[0]!);
      if (v.j !== "arr") {
        throw pgError("invalid_parameter_value", `cannot get array length of a non-array`, "22023");
      }
      return tv("int4", v.v.length);
    }),
  );
  m.set("jsonb_array_length", m.get("json_array_length")!);

  m.set(
    "jsonb_pretty",
    strict("text", (ctx, args) => {
      const v = jsonArg(ctx, args[0]!);
      return tv("text", prettyJsonb(v, 0));
    }),
  );

  const extractPath = (asText: boolean, jsonOut: boolean): ScalarFn =>
    strict(asText ? "text" : jsonOut ? "json" : "jsonb", (ctx, args) => {
      let current: JsonbValue | null = jsonArg(ctx, args[0]!);
      for (const pathArg of args.slice(1)) {
        if (current === null) break;
        const key = argText(ctx, pathArg);
        if (current.j === "obj") {
          current = current.v.get(key) ?? null;
        } else if (current.j === "arr") {
          const idx = Number.parseInt(key, 10);
          if (Number.isNaN(idx)) {
            current = null;
          } else {
            const arr: JsonbValue[] = current.v;
            const i: number = idx < 0 ? arr.length + idx : idx;
            current = arr[i] ?? null;
          }
        } else {
          current = null;
        }
      }
      if (current === null) return tv(asText ? "text" : jsonOut ? "json" : "jsonb", null);
      if (asText) {
        if (current.j === "null") return tv("text", null);
        if (current.j === "str") return tv("text", current.v);
        return tv("text", jsonbCompactText(current));
      }
      return jsonOut ? outJson(current) : outJsonb(current);
    });
  m.set("json_extract_path", extractPath(false, true));
  m.set("jsonb_extract_path", extractPath(false, false));
  m.set("json_extract_path_text", extractPath(true, true));
  m.set("jsonb_extract_path_text", extractPath(true, false));

  m.set(
    "jsonb_set",
    strict("jsonb", (ctx, args) => {
      const target = jsonArg(ctx, args[0]!);
      const path = pathTexts(args[1]!);
      const newValue = jsonArg(ctx, args[2]!);
      const createMissing = args.length > 3 ? (castTo(ctx, args[3]!, "bool", {}).v as boolean) : true;
      return outJsonb(jsonbSetPath(target, path, newValue, createMissing, "set"));
    }),
  );
  m.set("jsonb_set_lax", (ctx, args) => {
    if (args[0]!.v === null || args[1]!.v === null) return tv("jsonb", null);
    const treatment = args.length > 4 && args[4]!.v !== null ? argText(ctx, args[4]!) : "use_json_null";
    if (args[2]!.v === null) {
      const target = jsonArg(ctx, args[0]!);
      const path = pathTexts(args[1]!);
      const createMissing =
        args.length > 3 && args[3]!.v !== null ? (castTo(ctx, args[3]!, "bool", {}).v as boolean) : true;
      switch (treatment) {
        case "use_json_null":
          return outJsonb(jsonbSetPath(target, path, JSONB_NULL, createMissing, "set"));
        case "delete_key":
          return outJsonb(jsonbSetPath(target, path, JSONB_NULL, false, "delete"));
        case "return_target":
          return outJsonb(target);
        case "raise_exception":
          throw pgError("null_value_not_allowed", "JSON value must not be null", "22004");
        default:
          throw pgError(
            "invalid_parameter_value",
            `null_value_treatment must be "delete_key", "return_target", "use_json_null", or "raise_exception"`,
          );
      }
    }
    return m.get("jsonb_set")!(ctx, args.slice(0, 4));
  });
  m.set(
    "jsonb_insert",
    strict("jsonb", (ctx, args) => {
      const target = jsonArg(ctx, args[0]!);
      const path = pathTexts(args[1]!);
      const newValue = jsonArg(ctx, args[2]!);
      const after = args.length > 3 ? (castTo(ctx, args[3]!, "bool", {}).v as boolean) : false;
      return outJsonb(jsonbInsertPath(target, path, newValue, after));
    }),
  );
  m.set(
    "jsonb_strip_nulls",
    strict("jsonb", (ctx, args) => outJsonb(stripNulls(jsonArg(ctx, args[0]!)))),
  );
  m.set(
    "json_strip_nulls",
    strict("json", (ctx, args) => outJson(stripNulls(jsonArg(ctx, args[0]!)))),
  );

  m.set(
    "jsonb_object_keys_check",
    strict("bool", () => tv("bool", true)),
  );

  m.set(
    "json_is_valid_check",
    strict("bool", (ctx, args) => {
      try {
        validateJsonText(argText(ctx, args[0]!));
        return tv("bool", true);
      } catch {
        return tv("bool", false);
      }
    }),
  );

  return m;
}

/** json_build_object / json_object output spacing: `{"a" : 1, "b" : 2}`. */
function buildSpacedObjectText(obj: JsonbValue): string {
  if (obj.j !== "obj") return jsonbCompactText(obj);
  const body = [...obj.v.entries()].map(([k, x]) => `${JSON.stringify(k)} : ${jsonbCompactText(x)}`).join(", ");
  return `{${body}}`;
}

function buildObject(ctx: EngineCtx, args: TypedValue[]): JsonbValue {
  if (args.length % 2 !== 0) {
    throw pgError("invalid_parameter_value", "argument list must have even number of elements", "22023");
  }
  const entries: Array<[string, JsonbValue]> = [];
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]!;
    if (k.v === null) {
      throw pgError("invalid_parameter_value", "argument 1: key must not be null", "22004");
    }
    const key = castTo(ctx, k, "text", { explicit: true }).v as string;
    entries.push([key, datumToJsonb(ctx, args[i + 1]!.t, args[i + 1]!.v)]);
  }
  return jsonbObj(entries);
}

function jsonObjectFromArrays(_ctx: EngineCtx, args: TypedValue[]): JsonbValue {
  if (args.length === 1) {
    const arr = args[0]!.v as PgArray;
    if (arr.dims.length === 2) {
      const entries: Array<[string, JsonbValue]> = [];
      for (let i = 0; i < arr.items.length; i += 2) {
        const k = arr.items[i];
        if (k === null || k === undefined)
          throw pgError("null_value_not_allowed", "null value not allowed for object key", "22004");
        entries.push([String(k), arr.items[i + 1] == null ? JSONB_NULL : jsonbStr(String(arr.items[i + 1]))]);
      }
      return jsonbObj(entries);
    }
    if (arr.items.length % 2 !== 0) {
      throw pgError("invalid_parameter_value", "array must have even number of elements", "22023");
    }
    const entries: Array<[string, JsonbValue]> = [];
    for (let i = 0; i < arr.items.length; i += 2) {
      const k = arr.items[i];
      if (k === null) throw pgError("null_value_not_allowed", "null value not allowed for object key", "22004");
      entries.push([String(k), arr.items[i + 1] == null ? JSONB_NULL : jsonbStr(String(arr.items[i + 1]))]);
    }
    return jsonbObj(entries);
  }
  const keys = args[0]!.v as PgArray;
  const values = args[1]!.v as PgArray;
  if (keys.items.length !== values.items.length) {
    throw pgError("invalid_parameter_value", "mismatched array dimensions", "22023");
  }
  const entries: Array<[string, JsonbValue]> = [];
  for (let i = 0; i < keys.items.length; i++) {
    const k = keys.items[i];
    if (k === null) throw pgError("null_value_not_allowed", "null value not allowed for object key", "22004");
    entries.push([String(k), values.items[i] == null ? JSONB_NULL : jsonbStr(String(values.items[i]))]);
  }
  return jsonbObj(entries);
}

function pathTexts(pathArg: TypedValue): string[] {
  // untyped literals ('{a,b}') arrive as strings; parse them as text[]
  const v = isPgArray(pathArg.v) ? pathArg.v : (datumFromText("text[]", String(pathArg.v), UTC_INPUT) as PgArray);
  return v.items.map((i) => {
    if (i === null) throw pgError("null_value_not_allowed", "path element cannot be null", "22004");
    return String(i);
  });
}

function jsonbSetPath(
  target: JsonbValue,
  path: string[],
  newValue: JsonbValue,
  createMissing: boolean,
  mode: "set" | "delete",
): JsonbValue {
  if (path.length === 0) return target;
  const [head, ...rest] = path as [string, ...string[]];
  if (target.j === "obj") {
    const map = new Map(target.v);
    const exists = map.has(head);
    if (rest.length === 0) {
      if (mode === "delete") {
        map.delete(head);
      } else if (exists || createMissing) {
        map.set(head, newValue);
      }
    } else {
      const child = map.get(head);
      if (child !== undefined) {
        map.set(head, jsonbSetPath(child, rest, newValue, createMissing, mode));
      }
    }
    return jsonbObj(map.entries());
  }
  if (target.j === "arr") {
    const idx = Number.parseInt(head, 10);
    if (Number.isNaN(idx)) {
      throw pgError("invalid_text_representation", `path element at position 1 is not an integer: "${head}"`, "22P02");
    }
    const items = [...target.v];
    let i = idx < 0 ? items.length + idx : idx;
    if (rest.length === 0) {
      if (mode === "delete") {
        if (i >= 0 && i < items.length) items.splice(i, 1);
      } else if (i >= 0 && i < items.length) {
        items[i] = newValue;
      } else if (createMissing) {
        if (i < 0) items.unshift(newValue);
        else items.push(newValue);
      }
    } else {
      if (i < 0) i = 0;
      if (i < items.length) items[i] = jsonbSetPath(items[i]!, rest, newValue, createMissing, mode);
    }
    return jsonbArr(items);
  }
  throw pgError("invalid_parameter_value", `cannot set path in scalar`, "22023");
}

function jsonbInsertPath(target: JsonbValue, path: string[], newValue: JsonbValue, after: boolean): JsonbValue {
  if (path.length === 0) return target;
  const [head, ...rest] = path as [string, ...string[]];
  if (target.j === "obj") {
    const map = new Map(target.v);
    if (rest.length === 0) {
      if (map.has(head)) {
        throw pgError("invalid_parameter_value", "cannot replace existing key", "22023");
      }
      map.set(head, newValue);
    } else {
      const child = map.get(head);
      if (child !== undefined) map.set(head, jsonbInsertPath(child, rest, newValue, after));
    }
    return jsonbObj(map.entries());
  }
  if (target.j === "arr") {
    const idx = Number.parseInt(head, 10);
    if (Number.isNaN(idx)) {
      throw pgError("invalid_text_representation", `path element at position 1 is not an integer: "${head}"`, "22P02");
    }
    const items = [...target.v];
    let i = idx < 0 ? items.length + idx : idx;
    if (rest.length === 0) {
      if (i < 0) i = 0;
      if (i > items.length) i = items.length;
      items.splice(after ? i + 1 : i, 0, newValue);
    } else {
      if (i >= 0 && i < items.length) items[i] = jsonbInsertPath(items[i]!, rest, newValue, after);
    }
    return jsonbArr(items);
  }
  throw pgError("invalid_parameter_value", "cannot insert path in scalar", "22023");
}

function stripNulls(v: JsonbValue): JsonbValue {
  if (v.j === "obj") {
    const entries: Array<[string, JsonbValue]> = [];
    for (const [k, val] of v.v) {
      if (val.j === "null") continue;
      entries.push([k, stripNulls(val)]);
    }
    return jsonbObj(entries);
  }
  if (v.j === "arr") return jsonbArr(v.v.map(stripNulls));
  return v;
}

function prettyJsonb(v: JsonbValue, indent: number): string {
  const pad = "    ".repeat(indent);
  const padIn = "    ".repeat(indent + 1);
  switch (v.j) {
    case "obj": {
      if (v.v.size === 0) return "{}";
      const parts: string[] = [];
      for (const [k, val] of v.v) {
        parts.push(`${padIn}${JSON.stringify(k)}: ${prettyJsonb(val, indent + 1)}`);
      }
      return `{\n${parts.join(",\n")}\n${pad}}`;
    }
    case "arr": {
      if (v.v.length === 0) return "[]";
      const parts = v.v.map((item) => `${padIn}${prettyJsonb(item, indent + 1)}`);
      return `[\n${parts.join(",\n")}\n${pad}]`;
    }
    default:
      return jsonbText(v);
  }
}
