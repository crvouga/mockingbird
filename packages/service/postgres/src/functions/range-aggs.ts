import { pgError } from "../errors/error.ts";
import type { EngineCtx } from "../expressions/context.ts";
import {
  isMultirangeType,
  makeMultirange,
  multirangeIntersect,
  multirangeRange,
  type PgMultirange,
  rangeMultirange,
} from "../types/multirange.ts";
import { type PgRange, rangeIntersect } from "../types/range.ts";
import { isRangeType } from "../types/range-types.ts";
import { type TypedValue, type TypeId, tv, typeDisplayName } from "../types/value.ts";
import type { AggregateAcc, AggregateFactory } from "./aggregates.ts";

/** `range_agg` and `range_intersect_agg` over ranges and multiranges (issue #692). */

/** range_agg(range | multirange): the union of the inputs as a multirange. */
class RangeAggAcc implements AggregateAcc {
  private ranges: PgRange[] = [];
  private seen = false;
  constructor(
    private readonly ctx: EngineCtx,
    private readonly argType: TypeId,
  ) {}
  step(args: TypedValue[]): void {
    const v = args[0];
    if (!v || v.v === null) return;
    this.seen = true;
    if (isMultirangeType(v.t)) this.ranges.push(...(v.v as PgMultirange).ranges);
    else this.ranges.push(v.v as PgRange);
  }
  result(): TypedValue {
    const multiType = isMultirangeType(this.argType) ? this.argType : rangeMultirange(this.argType);
    if (!this.seen) return tv(multiType, null);
    return tv(multiType, makeMultirange(multirangeRange(multiType), this.ranges, this.ctx));
  }
}

/** range_intersect_agg(range | multirange): the intersection of the inputs. */
class RangeIntersectAggAcc implements AggregateAcc {
  private acc: PgRange | PgMultirange | null = null;
  constructor(
    private readonly ctx: EngineCtx,
    private readonly argType: TypeId,
  ) {}
  step(args: TypedValue[]): void {
    const v = args[0];
    if (!v || v.v === null) return;
    if (isMultirangeType(this.argType)) {
      const m = v.v as PgMultirange;
      this.acc =
        this.acc === null
          ? m
          : multirangeIntersect(multirangeRange(this.argType), this.acc as PgMultirange, m, this.ctx);
    } else {
      const r = v.v as PgRange;
      this.acc = this.acc === null ? r : rangeIntersect(this.argType, this.acc as PgRange, r, this.ctx);
    }
  }
  result(): TypedValue {
    return tv(this.argType, this.acc);
  }
}

function requireRangeArg(name: string, argTypes: TypeId[]): TypeId {
  const t = argTypes[0];
  if (argTypes.length !== 1 || t === undefined || (!isRangeType(t) && !isMultirangeType(t))) {
    throw pgError(
      "undefined_function",
      `function ${name}(${argTypes.map((a) => typeDisplayName(a)).join(", ")}) does not exist`,
      "42883",
    );
  }
  return t;
}

export const rangeAgg: AggregateFactory = (ctx, argTypes) =>
  new RangeAggAcc(ctx, requireRangeArg("range_agg", argTypes));
export const rangeIntersectAgg: AggregateFactory = (ctx, argTypes) =>
  new RangeIntersectAggAcc(ctx, requireRangeArg("range_intersect_agg", argTypes));
