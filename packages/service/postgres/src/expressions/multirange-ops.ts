import { pgError } from "../errors/error.ts";
import { castTo } from "../types/cast.ts";
import {
  isMultirangeType,
  multirangeContains,
  multirangeContainsElem,
  multirangeIntersect,
  multirangeMinus,
  multirangeOverlaps,
  multirangePosition,
  multirangeRange,
  multirangeUnion,
  type PgMultirange,
} from "../types/multirange.ts";
import { type PgRange, rangeContainsElem, rangeSubtype } from "../types/range.ts";
import { isRangeType } from "../types/range-types.ts";
import { type TypedValue, type TypeId, tv, typeDisplayName } from "../types/value.ts";
import type { EngineCtx } from "./context.ts";

/**
 * Operators with a multirange operand: containment (`@>`, `<@`) of elements, ranges and
 * multiranges, `&&`, the position operators `<<` `>>` `&<` `&>` `-|-` against ranges or multiranges,
 * and `+` / `*` / `-` between multiranges. Null when neither operand is a multirange.
 */

const OPS = new Set(["@>", "<@", "&&", "<<", ">>", "&<", "&>", "-|-", "+", "*", "-"]);

function opNotExist(op: string, l: TypeId, r: TypeId): never {
  throw pgError("undefined_function", `operator does not exist: ${typeDisplayName(l)} ${op} ${typeDisplayName(r)}`);
}

/** The ranges of a range or multirange operand of the multirange's range type, or null when it is neither. */
function rangesOf(v: TypedValue, rangeType: string): readonly PgRange[] | null {
  if (v.t === rangeType) return [v.v as PgRange];
  if (isMultirangeType(v.t) && multirangeRange(v.t) === rangeType) return (v.v as PgMultirange).ranges;
  return null;
}

export function evalMultirangeBinary(ctx: EngineCtx, op: string, l0: TypedValue, r0: TypedValue): TypedValue | null {
  if (!isMultirangeType(l0.t) && !isMultirangeType(r0.t)) return null;
  if (!OPS.has(op)) return null;
  let l = l0;
  let r = r0;
  // an unknown literal against a multirange is read as that multirange
  if (l.t === "unknown" && isMultirangeType(r.t)) l = castTo(ctx, l, r.t);
  if (r.t === "unknown" && isMultirangeType(l.t)) r = castTo(ctx, r, l.t);
  const multi = isMultirangeType(l.t) ? l.t : r.t;
  const rangeType = multirangeRange(multi);
  const sub = rangeSubtype(rangeType);
  if (op === "+" || op === "*" || op === "-") {
    if (l.t !== multi || r.t !== multi) opNotExist(op, l.t, r.t);
    if (l.v === null || r.v === null) return tv(multi, null);
    const a = l.v as PgMultirange;
    const b = r.v as PgMultirange;
    const out =
      op === "+"
        ? multirangeUnion(rangeType, a, b, ctx)
        : op === "*"
          ? multirangeIntersect(rangeType, a, b, ctx)
          : multirangeMinus(rangeType, a, b, ctx);
    return tv(multi, out);
  }
  // element containment
  if (op === "@>" && isMultirangeType(l.t) && !isRangeType(r.t) && !isMultirangeType(r.t)) {
    const elem = r.t === sub ? r : castTo(ctx, r, sub);
    if (l.v === null || elem.v === null) return tv("bool", null);
    return tv("bool", multirangeContainsElem(rangeType, l.v as PgMultirange, elem.v, ctx));
  }
  if (op === "<@" && isMultirangeType(r.t) && !isRangeType(l.t) && !isMultirangeType(l.t)) {
    const elem = l.t === sub ? l : castTo(ctx, l, sub);
    if (r.v === null || elem.v === null) return tv("bool", null);
    return tv("bool", multirangeContainsElem(rangeType, r.v as PgMultirange, elem.v, ctx));
  }
  if (l.v === null || r.v === null) {
    if (rangesOf(l, rangeType) === null && l.v !== null) opNotExist(op, l.t, r.t);
    return tv("bool", null);
  }
  const a = rangesOf(l, rangeType);
  const b = rangesOf(r, rangeType);
  if (a === null || b === null) opNotExist(op, l.t, r.t);
  switch (op) {
    case "@>":
      return tv("bool", multirangeContains(rangeType, a, b, ctx));
    case "<@":
      return tv("bool", multirangeContains(rangeType, b, a, ctx));
    case "&&":
      return tv("bool", multirangeOverlaps(rangeType, a, b, ctx));
    default:
      return tv("bool", multirangePosition(op as "<<" | ">>" | "&<" | "&>" | "-|-", rangeType, a, b, ctx));
  }
}

export { rangeContainsElem };
