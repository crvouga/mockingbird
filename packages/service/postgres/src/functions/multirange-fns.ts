import { pgError } from "../errors/error.ts";
import type { EngineCtx } from "../expressions/context.ts";
import { castTo } from "../types/cast.ts";
import {
  isMultirangeType,
  makeMultirange,
  multirangeRange,
  multirangeSpan,
  type PgMultirange,
  rangeMultirange,
} from "../types/multirange.ts";
import { type PgRange, rangeSubtype } from "../types/range.ts";
import { isRangeType, MULTIRANGE_RANGES } from "../types/range-types.ts";
import { type TypedValue, type TypeId, tv, typeDisplayName } from "../types/value.ts";
import type { ScalarFn } from "./util.ts";

/**
 * Multirange functions (https://www.postgresql.org/docs/18/functions-range.html): the
 * constructors, `multirange(range)`, the accessors shared with ranges, `range_merge(multirange)`,
 * `unnest(multirange)` and the aggregates `range_agg` / `range_intersect_agg`.
 */

function noSuchFunction(name: string, args: TypedValue[]): never {
  throw pgError(
    "undefined_function",
    `function ${name}(${args.map((a) => typeDisplayName(a.t)).join(", ")}) does not exist`,
    "42883",
  );
}

/** `int4multirange(VARIADIC int4range[])` and the zero-argument form. */
function constructor(multiType: string): ScalarFn {
  const rangeType = multirangeRange(multiType);
  return (ctx, args) => {
    const ranges: PgRange[] = [];
    for (const arg of args) {
      const value = arg.t === "unknown" ? castTo(ctx, arg, rangeType) : arg;
      if (value.t !== rangeType) noSuchFunction(multiType, args);
      if (value.v === null) {
        throw pgError("null_value_not_allowed", "multirange values cannot contain null members", "22004");
      }
      ranges.push(value.v as PgRange);
    }
    return tv(multiType, makeMultirange(rangeType, ranges, ctx));
  };
}

/** Wrap a range accessor so a multirange argument is answered from its span. */
function overload(
  registry: Map<string, ScalarFn>,
  name: string,
  answer: (ctx: EngineCtx, t: TypeId, m: PgMultirange) => TypedValue,
  nullType: (t: TypeId) => TypeId,
): void {
  const base = registry.get(name);
  registry.set(name, (ctx, args) => {
    const a = args[0];
    if (args.length === 1 && a && isMultirangeType(a.t)) {
      return a.v === null ? tv(nullType(a.t), null) : answer(ctx, a.t, a.v as PgMultirange);
    }
    if (!base) return noSuchFunction(name, args);
    return base(ctx, args);
  });
}

export function overloadMultirangeFunctions(registry: Map<string, ScalarFn>): void {
  for (const multiType of Object.keys(MULTIRANGE_RANGES)) registry.set(multiType, constructor(multiType));
  registry.set("multirange", (ctx, args) => {
    const a = args[0];
    if (args.length !== 1 || !a || !isRangeType(a.t)) return noSuchFunction("multirange", args);
    const multiType = rangeMultirange(a.t);
    return tv(multiType, a.v === null ? null : makeMultirange(a.t, [a.v as PgRange], ctx));
  });
  const span = (ctx: EngineCtx, t: TypeId, m: PgMultirange) => multirangeSpan(multirangeRange(t), m, ctx);
  const sub = (t: TypeId) => rangeSubtype(multirangeRange(t));
  overload(
    registry,
    "lower",
    (ctx, t, m) => {
      const r = span(ctx, t, m);
      return tv(sub(t), r.empty ? null : r.lower);
    },
    sub,
  );
  overload(
    registry,
    "upper",
    (ctx, t, m) => {
      const r = span(ctx, t, m);
      return tv(sub(t), r.empty ? null : r.upper);
    },
    sub,
  );
  overload(
    registry,
    "isempty",
    (_ctx, _t, m) => tv("bool", m.ranges.length === 0),
    () => "bool",
  );
  overload(
    registry,
    "lower_inc",
    (ctx, t, m) => {
      const r = span(ctx, t, m);
      return tv("bool", !r.empty && r.lower !== null && r.lowerInc);
    },
    () => "bool",
  );
  overload(
    registry,
    "upper_inc",
    (ctx, t, m) => {
      const r = span(ctx, t, m);
      return tv("bool", !r.empty && r.upper !== null && r.upperInc);
    },
    () => "bool",
  );
  overload(
    registry,
    "lower_inf",
    (ctx, t, m) => {
      const r = span(ctx, t, m);
      return tv("bool", !r.empty && r.lower === null);
    },
    () => "bool",
  );
  overload(
    registry,
    "upper_inf",
    (ctx, t, m) => {
      const r = span(ctx, t, m);
      return tv("bool", !r.empty && r.upper === null);
    },
    () => "bool",
  );
  overload(
    registry,
    "range_merge",
    (ctx, t, m) => tv(multirangeRange(t), span(ctx, t, m)),
    (t) => multirangeRange(t),
  );
}
