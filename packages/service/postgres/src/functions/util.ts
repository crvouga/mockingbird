import { pgError } from "../errors/error.ts";
import type { EngineCtx } from "../expressions/context.ts";
import { castTo } from "../types/cast.ts";
import { isNumeric, type Numeric, numericToNumber } from "../types/numeric.ts";
import { type Datum, type TypedValue, type TypeId, tv } from "../types/value.ts";

export type ScalarFn = (ctx: EngineCtx, args: TypedValue[]) => TypedValue;

/** Wrap a function so any NULL argument short-circuits to a NULL result. */
export function strict(resultType: TypeId, fn: ScalarFn): ScalarFn {
  return (ctx, args) => {
    for (const a of args) {
      if (a.v === null) return tv(resultType, null);
    }
    return fn(ctx, args);
  };
}

export function argText(ctx: EngineCtx, v: TypedValue): string {
  return castTo(ctx, v, "text", { explicit: true }).v as string;
}

export function argInt(ctx: EngineCtx, v: TypedValue): number {
  const cast = castTo(ctx, v, "int4", {});
  return cast.v as number;
}

export function argBigInt(ctx: EngineCtx, v: TypedValue): bigint {
  const cast = castTo(ctx, v, "int8", {});
  return cast.v as bigint;
}

export function argFloat(ctx: EngineCtx, v: TypedValue): number {
  const cast = castTo(ctx, v, "float8", { explicit: true });
  return cast.v as number;
}

export function argNumeric(ctx: EngineCtx, v: TypedValue): Numeric {
  const cast = castTo(ctx, v, "numeric", { explicit: true });
  return cast.v as Numeric;
}

export function argBool(ctx: EngineCtx, v: TypedValue): boolean {
  return castTo(ctx, v, "bool", {}).v as boolean;
}

export function numericAsNumber(v: Datum): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (isNumeric(v)) return numericToNumber(v);
  throw pgError("datatype_mismatch", "expected numeric value");
}

export function arityError(name: string, args: TypedValue[]): never {
  throw pgError("undefined_function", `function ${name}(${args.map((a) => a.t).join(", ")}) does not exist`, "42883");
}
