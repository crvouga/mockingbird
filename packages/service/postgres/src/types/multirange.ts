import { pgError } from "../errors/error.ts";
import type { CompareCtx } from "./compare.ts";
import { MULTIRANGE_RANGES } from "./range-types.ts";
import {
  EMPTY_RANGE,
  makeRange,
  type PgRange,
  parseRangeText,
  rangeAdjacent,
  rangeBefore,
  rangeCompare,
  rangeContains,
  rangeContainsElem,
  rangeIntersect,
  rangeKey,
  rangeOverLeft,
  rangeOverlaps,
  rangeOverRight,
  rangeText,
  rangeUnion,
} from "./range.ts";
import type { Datum, InputCtx, OutputCtx } from "./value.ts";

/**
 * Multirange types (https://www.postgresql.org/docs/18/rangetypes.html#RANGETYPES-BUILTIN):
 * `int4multirange`, ..., `tstzmultirange`. A datum is canonical — its ranges non-empty, sorted
 * and with no two overlapping or adjacent — so structural equality is multirange equality.
 */
export interface PgMultirange {
  readonly kind: "pgmultirange";
  readonly ranges: readonly PgRange[];
}

export function isMultirangeType(t: string): boolean {
  return MULTIRANGE_RANGES[t] !== undefined;
}

/** The range type a multirange type is made of. */
export function multirangeRange(t: string): string {
  const range = MULTIRANGE_RANGES[t];
  if (range === undefined) throw pgError("internal", `not a multirange type: ${t}`, "XX000");
  return range;
}

/** The multirange type over a range type. */
export function rangeMultirange(rangeType: string): string {
  for (const [multi, range] of Object.entries(MULTIRANGE_RANGES)) if (range === rangeType) return multi;
  throw pgError("internal", `no multirange type over ${rangeType}`, "XX000");
}

/** Sort, drop empties and merge overlapping or adjacent ranges. */
export function makeMultirange(rangeType: string, ranges: readonly PgRange[], ctx: CompareCtx): PgMultirange {
  const sorted = ranges.filter((r) => !r.empty).sort((a, b) => rangeCompare(rangeType, a, b, ctx));
  const out: PgRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && (rangeOverlaps(rangeType, last, r, ctx) || rangeAdjacent(rangeType, last, r, ctx))) {
      out[out.length - 1] = rangeUnion(rangeType, last, r, false, ctx);
    } else out.push(r);
  }
  return { kind: "pgmultirange", ranges: out };
}

export function multirangeText(t: string, m: PgMultirange, ctx: OutputCtx): string {
  const rangeType = multirangeRange(t);
  return `{${m.ranges.map((r) => rangeText(rangeType, r, ctx)).join(",")}}`;
}

/** multirange_in: `{range, range, ...}`; each range in range_in's syntax. */
export function parseMultirangeText(t: string, text: string, ctx: InputCtx & CompareCtx): PgMultirange {
  const rangeType = multirangeRange(t);
  const malformed = () => pgError("invalid_text_representation", `malformed multirange literal: "${text}"`, "22P02");
  let pos = 0;
  const skip = () => {
    while (pos < text.length && /\s/.test(text[pos]!)) pos++;
  };
  skip();
  if (text[pos] !== "{") throw malformed();
  pos++;
  const ranges: PgRange[] = [];
  skip();
  if (text[pos] === "}") {
    pos++;
  } else {
    for (;;) {
      skip();
      const start = pos;
      if (text.slice(pos, pos + 5).toLowerCase() === "empty") pos += 5;
      else {
        if (text[pos] !== "[" && text[pos] !== "(") throw malformed();
        pos++;
        let quoted = false;
        while (pos < text.length) {
          const c = text[pos]!;
          if (quoted) {
            if (c === "\\") pos++;
            else if (c === '"') quoted = false;
          } else if (c === '"') quoted = true;
          else if (c === "]" || c === ")") break;
          pos++;
        }
        if (pos >= text.length) throw malformed();
        pos++;
      }
      ranges.push(parseRangeText(rangeType, text.slice(start, pos), ctx));
      skip();
      if (text[pos] === ",") {
        pos++;
        continue;
      }
      if (text[pos] === "}") {
        pos++;
        break;
      }
      throw malformed();
    }
  }
  skip();
  if (pos !== text.length) throw malformed();
  return makeMultirange(rangeType, ranges, ctx);
}

export function multirangeKey(t: string, m: PgMultirange): string {
  const rangeType = multirangeRange(t);
  return `M{${m.ranges.map((r) => rangeKey(rangeType, r)).join("\u0002")}}`;
}

/** multirange_cmp: range by range; a prefix sorts first. */
export function multirangeCompare(t: string, a: PgMultirange, b: PgMultirange, ctx: CompareCtx): number {
  const rangeType = multirangeRange(t);
  const n = Math.min(a.ranges.length, b.ranges.length);
  for (let i = 0; i < n; i++) {
    const c = rangeCompare(rangeType, a.ranges[i]!, b.ranges[i]!, ctx);
    if (c !== 0) return c;
  }
  return a.ranges.length - b.ranges.length;
}

/** The smallest range covering the multirange (range_merge(multirange)); empty for an empty one. */
export function multirangeSpan(rangeType: string, m: PgMultirange, ctx: CompareCtx): PgRange {
  if (m.ranges.length === 0) return EMPTY_RANGE;
  return rangeUnion(rangeType, m.ranges[0]!, m.ranges[m.ranges.length - 1]!, false, ctx);
}

export function multirangeContainsElem(rangeType: string, m: PgMultirange, v: Datum, ctx: CompareCtx): boolean {
  return m.ranges.some((r) => rangeContainsElem(rangeType, r, v, ctx));
}

/** Every range of `b` lies inside one range of `a`. */
export function multirangeContains(
  rangeType: string,
  a: readonly PgRange[],
  b: readonly PgRange[],
  ctx: CompareCtx,
): boolean {
  return b.every((r) => r.empty || a.some((outer) => rangeContains(rangeType, outer, r, ctx)));
}

export function multirangeOverlaps(
  rangeType: string,
  a: readonly PgRange[],
  b: readonly PgRange[],
  ctx: CompareCtx,
): boolean {
  return a.some((x) => b.some((y) => rangeOverlaps(rangeType, x, y, ctx)));
}

/** `<<`, `>>`, `&<`, `&>`, `-|-` on the spans of two range lists (an empty one answers false). */
export function multirangePosition(
  op: "<<" | ">>" | "&<" | "&>" | "-|-",
  rangeType: string,
  a: readonly PgRange[],
  b: readonly PgRange[],
  ctx: CompareCtx,
): boolean {
  const xs = a.filter((r) => !r.empty);
  const ys = b.filter((r) => !r.empty);
  if (xs.length === 0 || ys.length === 0) return false;
  const [firstA, lastA, firstB, lastB] = [xs[0]!, xs[xs.length - 1]!, ys[0]!, ys[ys.length - 1]!];
  switch (op) {
    case "<<":
      return rangeBefore(rangeType, lastA, firstB, ctx);
    case ">>":
      return rangeBefore(rangeType, lastB, firstA, ctx);
    case "&<":
      return rangeOverLeft(rangeType, lastA, lastB, ctx);
    case "&>":
      return rangeOverRight(rangeType, firstA, firstB, ctx);
    case "-|-":
      return rangeAdjacent(rangeType, lastA, firstB, ctx) || rangeAdjacent(rangeType, lastB, firstA, ctx);
  }
}

export function multirangeUnion(rangeType: string, a: PgMultirange, b: PgMultirange, ctx: CompareCtx): PgMultirange {
  return makeMultirange(rangeType, [...a.ranges, ...b.ranges], ctx);
}

export function multirangeIntersect(
  rangeType: string,
  a: PgMultirange,
  b: PgMultirange,
  ctx: CompareCtx,
): PgMultirange {
  const out: PgRange[] = [];
  for (const x of a.ranges) for (const y of b.ranges) out.push(rangeIntersect(rangeType, x, y, ctx));
  return makeMultirange(rangeType, out, ctx);
}

/** `r` minus `cut`: zero, one or two pieces. */
function subtract(rangeType: string, r: PgRange, cut: PgRange, ctx: CompareCtx): PgRange[] {
  if (r.empty || cut.empty || !rangeOverlaps(rangeType, r, cut, ctx)) return [r];
  const pieces: PgRange[] = [];
  if (cut.lower !== null) {
    pieces.push(rangeIntersect(rangeType, r, makeRange(rangeType, null, cut.lower, false, !cut.lowerInc, ctx), ctx));
  }
  if (cut.upper !== null) {
    pieces.push(rangeIntersect(rangeType, r, makeRange(rangeType, cut.upper, null, !cut.upperInc, false, ctx), ctx));
  }
  return pieces.filter((p) => !p.empty);
}

export function multirangeMinus(rangeType: string, a: PgMultirange, b: PgMultirange, ctx: CompareCtx): PgMultirange {
  let pieces = a.ranges.slice();
  for (const cut of b.ranges) pieces = pieces.flatMap((r) => subtract(rangeType, r, cut, ctx));
  return makeMultirange(rangeType, pieces, ctx);
}
