import { pgError } from "../errors/error.ts";
import type { EngineCtx } from "../expressions/context.ts";
import { canImplicitCast, castTo } from "../types/cast.ts";
import { networkHostmask, networkMerge, networkSameFamily, networkSetMasklen } from "../types/network-ops.ts";
import { makeRange, type PgRange, parseRangeFlags, rangeSubtype, rangeUnion } from "../types/range.ts";
import { isRangeType, RANGE_SUBTYPES } from "../types/range-types.ts";
import { type TypedValue, tv, typeDisplayName } from "../types/value.ts";
import type { ScalarFn } from "./util.ts";
import { strict } from "./util.ts";

/**
 * Range constructors and accessors (https://www.postgresql.org/docs/18/functions-range.html),
 * plus the `inet` functions built on network-ops.ts.
 */

function noSuchFunction(name: string, args: TypedValue[]): never {
  throw pgError(
    "undefined_function",
    `function ${name}(${args.map((a) => typeDisplayName(a.t)).join(", ")}) does not exist`,
    "42883",
  );
}

function constructor(rangeType: string): ScalarFn {
  const sub = rangeSubtype(rangeType);
  return (ctx, args) => {
    if (args.length !== 2 && args.length !== 3) noSuchFunction(rangeType, args);
    const [lo, hi, flagsArg] = args as [TypedValue, TypedValue, TypedValue | undefined];
    for (const arg of [lo, hi]) {
      if (arg.t !== sub && !canImplicitCast(arg.t, sub)) noSuchFunction(rangeType, args);
    }
    if (flagsArg !== undefined && flagsArg.t !== "unknown" && flagsArg.t !== "text") noSuchFunction(rangeType, args);
    let flags = { lowerInc: true, upperInc: false };
    if (flagsArg !== undefined) {
      if (flagsArg.v === null) {
        throw pgError("data_exception", "range constructor flags argument must not be null", "22000");
      }
      flags = parseRangeFlags(flagsArg.v as string);
    }
    const lower = castTo(ctx, lo, sub).v;
    const upper = castTo(ctx, hi, sub).v;
    return tv(rangeType, makeRange(rangeType, lower, upper, flags.lowerInc, flags.upperInc, ctx));
  };
}

function rangeArg(name: string, ctx: EngineCtx, args: TypedValue[]): { t: string; r: PgRange | null } {
  const a = args[0];
  if (args.length !== 1 || a === undefined) noSuchFunction(name, args);
  if (isRangeType(a.t)) return { t: a.t, r: a.v as PgRange | null };
  // an unknown literal is ambiguous between the range types
  if (a.t === "unknown") {
    throw pgError("undefined_function", `could not determine polymorphic type because input has type unknown`, "42804");
  }
  void ctx;
  return noSuchFunction(name, args);
}

/** The `lower` / `upper` overloads on ranges; anything else goes to the text function of the same name. */
function boundAccessor(side: "lower" | "upper", textFn: ScalarFn | undefined): ScalarFn {
  return (ctx, args) => {
    if (args.length === 1 && isRangeType(args[0]!.t)) {
      const { t, r } = rangeArg(side, ctx, args);
      const sub = rangeSubtype(t);
      if (r === null || r.empty) return tv(sub, null);
      return tv(sub, side === "lower" ? r.lower : r.upper);
    }
    if (!textFn) return noSuchFunction(side, args);
    return textFn(ctx, args);
  };
}

function rangePredicate(name: string, fn: (r: PgRange) => boolean): ScalarFn {
  return (ctx, args) => {
    const { r } = rangeArg(name, ctx, args);
    return tv("bool", r === null ? null : fn(r));
  };
}

export function getRangeFunctions(): Map<string, ScalarFn> {
  const m = new Map<string, ScalarFn>();
  for (const rangeType of Object.keys(RANGE_SUBTYPES)) m.set(rangeType, constructor(rangeType));
  m.set(
    "isempty",
    rangePredicate("isempty", (r) => r.empty),
  );
  m.set(
    "lower_inc",
    rangePredicate("lower_inc", (r) => !r.empty && r.lower !== null && r.lowerInc),
  );
  m.set(
    "upper_inc",
    rangePredicate("upper_inc", (r) => !r.empty && r.upper !== null && r.upperInc),
  );
  m.set(
    "lower_inf",
    rangePredicate("lower_inf", (r) => !r.empty && r.lower === null),
  );
  m.set(
    "upper_inf",
    rangePredicate("upper_inf", (r) => !r.empty && r.upper === null),
  );
  m.set("range_merge", (ctx, args) => {
    if (args.length !== 2) noSuchFunction("range_merge", args);
    let [a, b] = args as [TypedValue, TypedValue];
    if (a.t === "unknown" && isRangeType(b.t)) a = castTo(ctx, a, b.t);
    if (b.t === "unknown" && isRangeType(a.t)) b = castTo(ctx, b, a.t);
    if (!isRangeType(a.t) || a.t !== b.t) noSuchFunction("range_merge", args);
    if (a.v === null || b.v === null) return tv(a.t, null);
    return tv(a.t, rangeUnion(a.t, a.v as PgRange, b.v as PgRange, false, ctx));
  });

  // inet functions on the same bit arithmetic as the operators
  const inet = (ctx: EngineCtx, arg: TypedValue): string => castTo(ctx, arg, "inet").v as string;
  m.set(
    "inet_same_family",
    strict("bool", (ctx, args) => tv("bool", networkSameFamily(inet(ctx, args[0]!), inet(ctx, args[1]!)))),
  );
  m.set(
    "inet_merge",
    strict("cidr", (ctx, args) => tv("cidr", networkMerge(inet(ctx, args[0]!), inet(ctx, args[1]!)))),
  );
  m.set(
    "hostmask",
    strict("inet", (ctx, args) => tv("inet", networkHostmask(inet(ctx, args[0]!)))),
  );
  m.set(
    "set_masklen",
    strict("inet", (ctx, args) => {
      const type = args[0]!.t === "cidr" ? "cidr" : "inet";
      const bits = castTo(ctx, args[1]!, "int4").v as number;
      return tv(type, networkSetMasklen(type, inet(ctx, args[0]!), bits));
    }),
  );
  return m;
}

/** Wrap the text `lower` / `upper` so a range argument reaches the range accessor. */
export function overloadRangeAccessors(registry: Map<string, ScalarFn>): void {
  registry.set("lower", boundAccessor("lower", registry.get("lower")));
  registry.set("upper", boundAccessor("upper", registry.get("upper")));
}
