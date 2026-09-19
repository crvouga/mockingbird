import { pgError } from "../errors/error.ts";
import { castTo, unifyTypes } from "../types/cast.ts";
import { datumCompare, datumEquals } from "../types/compare.ts";
import {
  arrayElemType,
  arrayTypeOf,
  type Datum,
  isArrayType,
  makeArray,
  type PgArray,
  type TypeId,
  tv,
  UNKNOWN,
} from "../types/value.ts";
import { argInt, argText, type ScalarFn, strict } from "./util.ts";

function requireArray(v: { t: TypeId; v: Datum }, fname: string): PgArray {
  if (!isArrayType(v.t)) {
    throw pgError("undefined_function", `function ${fname}(${v.t}) does not exist`, "42883");
  }
  return v.v as PgArray;
}

function dimsOf(arr: PgArray): number[] {
  return arr.dims.length > 0 ? arr.dims : arr.items.length === 0 ? [] : [arr.items.length];
}

function lbsOf(arr: PgArray): number[] {
  const dims = dimsOf(arr);
  return arr.lbs.length === dims.length ? arr.lbs : dims.map(() => 1);
}

export function getArrayFunctions(): Map<string, ScalarFn> {
  const m = new Map<string, ScalarFn>();

  m.set(
    "array_length",
    strict("int4", (ctx, args) => {
      const arr = requireArray(args[0]!, "array_length");
      const dim = argInt(ctx, args[1]!);
      const dims = dimsOf(arr);
      if (dim < 1 || dim > dims.length) return tv("int4", null);
      return tv("int4", dims[dim - 1]!);
    }),
  );
  m.set(
    "array_upper",
    strict("int4", (ctx, args) => {
      const arr = requireArray(args[0]!, "array_upper");
      const dim = argInt(ctx, args[1]!);
      const dims = dimsOf(arr);
      const lbs = lbsOf(arr);
      if (dim < 1 || dim > dims.length) return tv("int4", null);
      return tv("int4", lbs[dim - 1]! + dims[dim - 1]! - 1);
    }),
  );
  m.set(
    "array_lower",
    strict("int4", (ctx, args) => {
      const arr = requireArray(args[0]!, "array_lower");
      const dim = argInt(ctx, args[1]!);
      const dims = dimsOf(arr);
      const lbs = lbsOf(arr);
      if (dim < 1 || dim > dims.length) return tv("int4", null);
      return tv("int4", lbs[dim - 1]!);
    }),
  );
  m.set(
    "array_ndims",
    strict("int4", (_ctx, args) => {
      const arr = requireArray(args[0]!, "array_ndims");
      const dims = dimsOf(arr);
      return tv("int4", dims.length === 0 ? null : dims.length);
    }),
  );
  m.set(
    "cardinality",
    strict("int4", (_ctx, args) => {
      const arr = requireArray(args[0]!, "cardinality");
      return tv("int4", arr.items.length);
    }),
  );
  m.set(
    "array_dims",
    strict("text", (_ctx, args) => {
      const arr = requireArray(args[0]!, "array_dims");
      const dims = dimsOf(arr);
      if (dims.length === 0) return tv("text", null);
      const lbs = lbsOf(arr);
      let out = "";
      for (let i = 0; i < dims.length; i++) {
        out += `[${lbs[i]}:${lbs[i]! + dims[i]! - 1}]`;
      }
      return tv("text", out);
    }),
  );
  m.set("array_append", (ctx, args) => {
    const a = args[0]!;
    const elemT = isArrayType(a.t) ? arrayElemType(a.t) : args[1]!.t === UNKNOWN ? "text" : args[1]!.t;
    const arr = a.v === null ? makeArray(elemT, []) : (a.v as PgArray);
    const el = castTo(ctx, args[1]!, elemT, {});
    if ((arr.dims.length || 1) > 1) throw pgError("array_subscript_error", "cannot append to multidimensional array");
    return tv(arrayTypeOf(elemT), makeArray(elemT, [...arr.items, el.v]));
  });
  m.set("array_prepend", (ctx, args) => {
    const a = args[1]!;
    const elemT = isArrayType(a.t) ? arrayElemType(a.t) : args[0]!.t === UNKNOWN ? "text" : args[0]!.t;
    const arr = a.v === null ? makeArray(elemT, []) : (a.v as PgArray);
    const el = castTo(ctx, args[0]!, elemT, {});
    return tv(arrayTypeOf(elemT), makeArray(elemT, [el.v, ...arr.items]));
  });
  m.set("array_cat", (ctx, args) => {
    const a = args[0]!;
    const b = args[1]!;
    if (a.v === null) return b;
    if (b.v === null) return a;
    const ea = arrayElemType(a.t);
    const eb = arrayElemType(b.t);
    const elem = unifyTypes(ea === UNKNOWN ? eb : ea, eb === UNKNOWN ? ea : eb) ?? "text";
    const arrA = castTo(ctx, a, arrayTypeOf(elem), {}).v as PgArray;
    const arrB = castTo(ctx, b, arrayTypeOf(elem), {}).v as PgArray;
    return tv(arrayTypeOf(elem), makeArray(elem, [...arrA.items, ...arrB.items]));
  });
  m.set("array_remove", (ctx, args) => {
    const a = args[0]!;
    if (a.v === null) return tv(a.t, null);
    const arr = requireArray(a, "array_remove");
    const elemT = arrayElemType(a.t);
    const target = castTo(ctx, args[1]!, elemT, {});
    const items = arr.items.filter((item) => {
      if (item === null) return target.v !== null;
      if (target.v === null) return true;
      return !datumEquals(elemT, item, target.v, ctx);
    });
    return tv(a.t, makeArray(elemT, items));
  });
  m.set("array_replace", (ctx, args) => {
    const a = args[0]!;
    if (a.v === null) return tv(a.t, null);
    const arr = requireArray(a, "array_replace");
    const elemT = arrayElemType(a.t);
    const from = castTo(ctx, args[1]!, elemT, {});
    const to = castTo(ctx, args[2]!, elemT, {});
    const items = arr.items.map((item) => {
      const matches = item === null ? from.v === null : from.v !== null && datumEquals(elemT, item, from.v, ctx);
      return matches ? to.v : item;
    });
    return tv(a.t, makeArray(elemT, items, arr.dims, arr.lbs));
  });
  m.set("array_position", (ctx, args) => {
    const a = args[0]!;
    if (a.v === null) return tv("int4", null);
    const arr = requireArray(a, "array_position");
    if (dimsOf(arr).length > 1) {
      throw pgError("array_subscript_error", "searching for elements in multidimensional arrays is not supported");
    }
    const elemT = arrayElemType(a.t);
    const target = castTo(ctx, args[1]!, elemT, {});
    const start = args.length > 2 ? argInt(ctx, args[2]!) : 1;
    const lb = lbsOf(arr)[0] ?? 1;
    for (let i = Math.max(start - lb, 0); i < arr.items.length; i++) {
      const item = arr.items[i]!;
      const eq = item === null ? target.v === null : target.v !== null && datumEquals(elemT, item, target.v, ctx);
      if (eq) return tv("int4", i + lb);
    }
    return tv("int4", null);
  });
  m.set("array_positions", (ctx, args) => {
    const a = args[0]!;
    if (a.v === null) return tv("int4[]", null);
    const arr = requireArray(a, "array_positions");
    if (dimsOf(arr).length > 1) {
      throw pgError("array_subscript_error", "searching for elements in multidimensional arrays is not supported");
    }
    const elemT = arrayElemType(a.t);
    const target = castTo(ctx, args[1]!, elemT, {});
    const lb = lbsOf(arr)[0] ?? 1;
    const out: Datum[] = [];
    for (let i = 0; i < arr.items.length; i++) {
      const item = arr.items[i]!;
      const eq = item === null ? target.v === null : target.v !== null && datumEquals(elemT, item, target.v, ctx);
      if (eq) out.push(i + lb);
    }
    return tv("int4[]", makeArray("int4", out));
  });
  m.set(
    "array_fill",
    strict("text[]", (_ctx, args) => {
      const value = args[0]!;
      const dimsArr = args[1]!.v as PgArray;
      const dims = dimsArr.items.map((d) => Number(d));
      const lbs = args.length > 2 ? (args[2]!.v as PgArray).items.map((d) => Number(d)) : dims.map(() => 1);
      const total = dims.reduce((a, b) => a * b, 1);
      if (dims.some((d) => d < 0)) throw pgError("invalid_parameter_value", "dimension array entry must be positive");
      const elemT = value.t === UNKNOWN ? "text" : value.t;
      const items: Datum[] = new Array(total).fill(value.v);
      return tv(arrayTypeOf(elemT), makeArray(elemT, items, dims, lbs));
    }),
  );
  m.set(
    "trim_array",
    strict("text[]", (ctx, args) => {
      const a = args[0]!;
      const arr = requireArray(a, "trim_array");
      const n = argInt(ctx, args[1]!);
      if (n < 0 || n > arr.items.length) {
        throw pgError(
          "array_element_error",
          `number of elements to trim must be between 0 and ${arr.items.length}`,
          "2202E",
        );
      }
      return tv(a.t, makeArray(arrayElemType(a.t), arr.items.slice(0, arr.items.length - n)));
    }),
  );
  m.set("array_to_string", (ctx, args) => {
    const a = args[0]!;
    if (a.v === null || args[1]!.v === null) return tv("text", null);
    const arr = requireArray(a, "array_to_string");
    const sep = argText(ctx, args[1]!);
    const nullStr = args.length > 2 && args[2]!.v !== null ? argText(ctx, args[2]!) : null;
    const elemT = arrayElemType(a.t);
    const parts: string[] = [];
    for (const item of arr.items) {
      if (item === null) {
        if (nullStr !== null) parts.push(nullStr);
        continue;
      }
      parts.push(castTo(ctx, tv(elemT, item), "text", { explicit: true }).v as string);
    }
    return tv("text", parts.join(sep));
  });
  m.set(
    "array_sort",
    strict("text[]", (ctx, args) => {
      const a = args[0]!;
      const arr = requireArray(a, "array_sort");
      const elemT = arrayElemType(a.t);
      const items = [...arr.items].sort((x, y) => {
        if (x === null) return y === null ? 0 : 1;
        if (y === null) return -1;
        return datumCompare(elemT, x, y, ctx);
      });
      return tv(a.t, makeArray(elemT, items));
    }),
  );
  m.set(
    "array_reverse",
    strict("text[]", (_ctx, args) => {
      const a = args[0]!;
      const arr = requireArray(a, "array_reverse");
      return tv(a.t, makeArray(arrayElemType(a.t), [...arr.items].reverse()));
    }),
  );
  m.set(
    "array_shuffle",
    strict("text[]", (ctx, args) => {
      const a = args[0]!;
      const arr = requireArray(a, "array_shuffle");
      const items = [...arr.items];
      for (let i = items.length - 1; i > 0; i--) {
        const j = ctx.state.prng.nextInt(0, i);
        [items[i], items[j]] = [items[j]!, items[i]!];
      }
      return tv(a.t, makeArray(arrayElemType(a.t), items));
    }),
  );
  m.set(
    "array_sample",
    strict("text[]", (ctx, args) => {
      const a = args[0]!;
      const arr = requireArray(a, "array_sample");
      const n = argInt(ctx, args[1]!);
      if (n < 0 || n > arr.items.length) {
        throw pgError("invalid_parameter_value", `sample size must be between 0 and ${arr.items.length}`, "22023");
      }
      const items = [...arr.items];
      const out: Datum[] = [];
      for (let i = 0; i < n; i++) {
        const j = ctx.state.prng.nextInt(0, items.length - 1);
        out.push(items[j]!);
        items.splice(j, 1);
      }
      return tv(a.t, makeArray(arrayElemType(a.t), out));
    }),
  );

  return m;
}
