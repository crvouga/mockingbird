import { pgError } from "../errors/error.ts";
import { castTo } from "../types/cast.ts";
import {
  networkAdd,
  networkBitwise,
  networkDiff,
  networkNot,
  networkOverlaps,
  networkSubnetOf,
} from "../types/network-ops.ts";
import {
  type PgRange,
  rangeAdjacent,
  rangeBefore,
  rangeContains,
  rangeContainsElem,
  rangeIntersect,
  rangeMinus,
  rangeOverLeft,
  rangeOverlaps,
  rangeOverRight,
  rangeSubtype,
  rangeUnion,
} from "../types/range.ts";
import { isRangeType } from "../types/range-types.ts";
import { type TypedValue, type TypeId, tv, typeDisplayName } from "../types/value.ts";
import type { EngineCtx } from "./context.ts";
import { evalMultirangeBinary } from "./multirange-ops.ts";

/**
 * Operators on range types and on `inet` / `cidr`, plus `xid = int4`. `evalBinary` asks here
 * first; a null answer means the operands are not ours and the generic operators apply.
 */

function opNotExist(op: string, l: TypeId, r: TypeId): never {
  throw pgError("undefined_function", `operator does not exist: ${typeDisplayName(l)} ${op} ${typeDisplayName(r)}`);
}

const RANGE_OPS = new Set(["@>", "<@", "&&", "<<", ">>", "&<", "&>", "-|-", "+", "*", "-"]);
const NETWORK_TYPES = new Set(["inet", "cidr"]);
const NETWORK_OPS = new Set(["<<", "<<=", ">>", ">>=", "&&", "&", "|", "+", "-"]);
const INTEGER_TYPES = new Set(["int2", "int4", "int8"]);

export function evalRangeOrNetworkBinary(ctx: EngineCtx, op: string, l: TypedValue, r: TypedValue): TypedValue | null {
  const multirange = evalMultirangeBinary(ctx, op, l, r);
  if (multirange) return multirange;
  if (isRangeType(l.t) || isRangeType(r.t)) return RANGE_OPS.has(op) ? evalRangeOp(ctx, op, l, r) : null;
  if (NETWORK_TYPES.has(l.t) || NETWORK_TYPES.has(r.t))
    return NETWORK_OPS.has(op) ? evalNetworkOp(ctx, op, l, r) : null;
  if (l.t === "xid" && INTEGER_TYPES.has(r.t) && (op === "=" || op === "<>")) {
    // xideqint4 / xidneqint4 (no ordering operators exist on xid)
    if (l.v === null || r.v === null) return tv("bool", null);
    const equal = BigInt(l.v as number) === BigInt(r.v as number | bigint);
    return tv("bool", op === "=" ? equal : !equal);
  }
  return null;
}

export function evalRangeOrNetworkUnary(op: string, operand: TypedValue): TypedValue | null {
  if (op === "~" && NETWORK_TYPES.has(operand.t)) {
    return tv("inet", operand.v === null ? null : networkNot(operand.v as string));
  }
  return null;
}

function evalRangeOp(ctx: EngineCtx, op: string, l0: TypedValue, r0: TypedValue): TypedValue {
  let l = l0;
  let r = r0;
  // an unknown literal against a range is read as that range type (anyrange beats anyelement)
  if (l.t === "unknown" && isRangeType(r.t)) l = castTo(ctx, l, r.t);
  if (r.t === "unknown" && isRangeType(l.t)) r = castTo(ctx, r, l.t);
  const lr = isRangeType(l.t);
  const rr = isRangeType(r.t);
  const resultBool = op !== "+" && op !== "*" && op !== "-";
  if (lr && rr) {
    if (l.t !== r.t) opNotExist(op, l.t, r.t);
  } else if (op === "@>" && lr) {
    if (r.t !== rangeSubtype(l.t)) opNotExist(op, l.t, r.t);
    if (l.v === null || r.v === null) return tv("bool", null);
    return tv("bool", rangeContainsElem(l.t, l.v as PgRange, r.v, ctx));
  } else if (op === "<@" && rr) {
    if (l.t !== rangeSubtype(r.t)) opNotExist(op, l.t, r.t);
    if (l.v === null || r.v === null) return tv("bool", null);
    return tv("bool", rangeContainsElem(r.t, r.v as PgRange, l.v, ctx));
  } else {
    opNotExist(op, l.t, r.t);
  }
  const t = l.t;
  if (l.v === null || r.v === null) return tv(resultBool ? "bool" : t, null);
  const a = l.v as PgRange;
  const b = r.v as PgRange;
  switch (op) {
    case "@>":
      return tv("bool", rangeContains(t, a, b, ctx));
    case "<@":
      return tv("bool", rangeContains(t, b, a, ctx));
    case "&&":
      return tv("bool", rangeOverlaps(t, a, b, ctx));
    case "<<":
      return tv("bool", rangeBefore(t, a, b, ctx));
    case ">>":
      return tv("bool", rangeBefore(t, b, a, ctx));
    case "&<":
      return tv("bool", rangeOverLeft(t, a, b, ctx));
    case "&>":
      return tv("bool", rangeOverRight(t, a, b, ctx));
    case "-|-":
      return tv("bool", rangeAdjacent(t, a, b, ctx));
    case "+":
      return tv(t, rangeUnion(t, a, b, true, ctx));
    case "*":
      return tv(t, rangeIntersect(t, a, b, ctx));
    default:
      return tv(t, rangeMinus(t, a, b, ctx));
  }
}

function asInet(ctx: EngineCtx, v: TypedValue): TypedValue {
  return v.t === "inet" ? v : castTo(ctx, v, "inet");
}

function evalNetworkOp(ctx: EngineCtx, op: string, l0: TypedValue, r0: TypedValue): TypedValue {
  const ln = NETWORK_TYPES.has(l0.t);
  const rn = NETWORK_TYPES.has(r0.t);
  // inet ± integer, integer + inet
  if (op === "+" || op === "-") {
    const intSide = ln && INTEGER_TYPES.has(r0.t) ? r0 : !ln && op === "+" && INTEGER_TYPES.has(l0.t) ? l0 : null;
    if (intSide !== null) {
      const net = asInet(ctx, intSide === r0 ? l0 : r0);
      if (net.v === null || intSide.v === null) return tv("inet", null);
      const delta = BigInt(intSide.v as number | bigint);
      return tv("inet", networkAdd(net.v as string, op === "+" ? delta : -delta));
    }
    if (op === "+") opNotExist(op, l0.t, r0.t);
  }
  const left = ln ? l0 : l0.t === "unknown" ? castTo(ctx, l0, "inet") : null;
  const right = rn ? r0 : r0.t === "unknown" ? castTo(ctx, r0, "inet") : null;
  if (left === null || right === null) opNotExist(op, l0.t, r0.t);
  const a = asInet(ctx, left);
  const b = asInet(ctx, right);
  const resultType = op === "-" ? "int8" : op === "&" || op === "|" ? "inet" : "bool";
  if (a.v === null || b.v === null) return tv(resultType, null);
  const x = a.v as string;
  const y = b.v as string;
  switch (op) {
    case "<<":
      return tv("bool", networkSubnetOf(x, y, false));
    case "<<=":
      return tv("bool", networkSubnetOf(x, y, true));
    case ">>":
      return tv("bool", networkSubnetOf(y, x, false));
    case ">>=":
      return tv("bool", networkSubnetOf(y, x, true));
    case "&&":
      return tv("bool", networkOverlaps(x, y));
    case "&":
    case "|":
      return tv("inet", networkBitwise(op, x, y));
    default:
      return tv("int8", networkDiff(x, y));
  }
}
