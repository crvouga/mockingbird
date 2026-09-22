import type { Expr, FrameBound, FrameSpec, FuncCall, OrderByItem, WindowSpec } from "../ast/nodes.ts";
import { pgError } from "../errors/error.ts";
import type { EngineCtx } from "../expressions/context.ts";
import { evalBinary } from "../expressions/operators.ts";
import { createAggregate, isAggregateName } from "../functions/aggregates.ts";
import { isWindowFunctionName } from "../functions/window.ts";
import { castTo } from "../types/cast.ts";
import { datumCompare, datumKey } from "../types/compare.ts";
import { type Datum, type TypedValue, type TypeId, tv, UNKNOWN } from "../types/value.ts";

/** Evaluator callback: evaluate `e` in the context of source row `rowIdx`. */
export type RowEval = (rowIdx: number, e: Expr) => TypedValue;

interface SortKey {
  values: Datum[];
  types: TypeId[];
  dirs: Array<"asc" | "desc">;
  nullsFirst: boolean[];
}

function compareKeys(ctx: EngineCtx, a: SortKey, b: SortKey): number {
  for (let i = 0; i < a.values.length; i++) {
    const av = a.values[i]!;
    const bv = b.values[i]!;
    const desc = a.dirs[i] === "desc";
    const nullsFirst = a.nullsFirst[i]!;
    if (av === null || bv === null) {
      if (av === null && bv === null) continue;
      const nullCmp = av === null ? -1 : 1;
      const cmp = nullsFirst ? nullCmp : -nullCmp;
      if (cmp !== 0) return cmp;
      continue;
    }
    let c = datumCompare(a.types[i]!, av, bv, ctx);
    if (desc) c = -c;
    if (c !== 0) return c;
  }
  return 0;
}

/**
 * Compute all window function results for one SELECT.
 * Returns per-call arrays indexed by source row.
 */
export function computeWindowValues(
  ctx: EngineCtx,
  calls: FuncCall[],
  rowCount: number,
  evalAt: RowEval,
  namedWindows: ReadonlyArray<{ name: string; spec: WindowSpec }>,
): Map<FuncCall, TypedValue[]> {
  const out = new Map<FuncCall, TypedValue[]>();
  for (const call of calls) {
    const spec = resolveWindowSpec(call.over!, namedWindows);
    out.set(call, computeOneWindow(ctx, call, spec, rowCount, evalAt));
  }
  return out;
}

function resolveWindowSpec(spec: WindowSpec, named: ReadonlyArray<{ name: string; spec: WindowSpec }>): WindowSpec {
  if (!spec.name) return spec;
  const base = named.find((w) => w.name === spec.name);
  if (!base) throw pgError("undefined_object", `window "${spec.name}" does not exist`, "42704");
  return {
    partitionBy: base.spec.partitionBy.length > 0 ? base.spec.partitionBy : spec.partitionBy,
    orderBy: base.spec.orderBy.length > 0 ? base.spec.orderBy : spec.orderBy,
    frame: spec.frame ?? base.spec.frame,
  };
}

function computeOneWindow(
  ctx: EngineCtx,
  call: FuncCall,
  spec: WindowSpec,
  rowCount: number,
  evalAt: RowEval,
): TypedValue[] {
  // 1. partition rows
  const partitions = new Map<string, number[]>();
  const partitionOf: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const keyParts: string[] = [];
    for (const p of spec.partitionBy) {
      const v = evalAt(i, p);
      keyParts.push(v.v === null ? "\u0000N" : datumKey(v.t === UNKNOWN ? "text" : v.t, v.v));
    }
    const key = keyParts.join("\u0001");
    partitionOf.push(key);
    const list = partitions.get(key) ?? [];
    list.push(i);
    partitions.set(key, list);
  }

  const results: TypedValue[] = new Array(rowCount);
  for (const rowIdxs of partitions.values()) {
    computePartition(ctx, call, spec, rowIdxs, evalAt, results);
  }
  return results;
}

function computePartition(
  ctx: EngineCtx,
  call: FuncCall,
  spec: WindowSpec,
  rowIdxs: number[],
  evalAt: RowEval,
  results: TypedValue[],
): void {
  // 2. sort partition by ORDER BY
  const keys = new Map<number, SortKey>();
  if (spec.orderBy.length > 0) {
    for (const i of rowIdxs) {
      keys.set(i, sortKeyFor(ctx, spec.orderBy, i, evalAt));
    }
    rowIdxs = [...rowIdxs].sort((a, b) => compareKeys(ctx, keys.get(a)!, keys.get(b)!));
  }
  const n = rowIdxs.length;

  // peer groups (rows equal under ORDER BY)
  const peerGroup: number[] = new Array(n);
  let group = 0;
  for (let pos = 0; pos < n; pos++) {
    if (pos > 0) {
      const same =
        spec.orderBy.length === 0 || compareKeys(ctx, keys.get(rowIdxs[pos - 1]!)!, keys.get(rowIdxs[pos]!)!) === 0;
      if (!same) group++;
    }
    peerGroup[pos] = group;
  }
  const groupCount = n === 0 ? 0 : peerGroup[n - 1]! + 1;

  const name = call.name[call.name.length - 1]!;

  if (isWindowFunctionName(name)) {
    computeRankingFunction(ctx, name, call, rowIdxs, peerGroup, groupCount, evalAt, results, spec);
    return;
  }

  if (!isAggregateName(name)) {
    throw pgError("undefined_function", `function ${name} does not exist as a window function`, "42883");
  }

  // 3. window aggregate over frames
  const frame = spec.frame ?? defaultFrame(spec);
  if (!call.filter && (name === "sum" || name === "count") && isRunningRowsFrame(frame, spec)) {
    computeRunningAgg(ctx, call, name, rowIdxs, evalAt, results);
    return;
  }
  for (let pos = 0; pos < n; pos++) {
    const [lo, hi] = frameBounds(ctx, frame, pos, rowIdxs, peerGroup, keys, spec, evalAt);
    const included: number[] = [];
    for (let p = Math.max(lo, 0); p <= Math.min(hi, n - 1); p++) {
      if (excluded(frame, p, pos, peerGroup)) continue;
      included.push(p);
    }
    // evaluate agg over included rows
    const argRows: TypedValue[][] = [];
    for (const p of included) {
      if (call.filter) {
        const f = evalAt(rowIdxs[p]!, call.filter);
        if (f.v !== true) continue;
      }
      argRows.push(call.star ? [] : call.args.map((a) => evalAt(rowIdxs[p]!, a)));
    }
    const argTypes: TypeId[] = call.args.map((_, ai) => {
      for (const r of argRows) {
        const t = r[ai]!.t;
        if (t !== UNKNOWN) return t;
      }
      return UNKNOWN;
    });
    const acc = createAggregate(ctx, name, argTypes);
    for (const r of argRows) acc.step(r);
    results[rowIdxs[pos]!] = acc.result();
  }
}

function sortKeyFor(_ctx: EngineCtx, orderBy: OrderByItem[], rowIdx: number, evalAt: RowEval): SortKey {
  const values: Datum[] = [];
  const types: TypeId[] = [];
  const dirs: Array<"asc" | "desc"> = [];
  const nullsFirst: boolean[] = [];
  for (const ob of orderBy) {
    const v = evalAt(rowIdx, ob.expr);
    values.push(v.v);
    types.push(v.t === UNKNOWN ? "text" : v.t);
    const dir = ob.dir ?? "asc";
    dirs.push(dir);
    nullsFirst.push(ob.nulls ? ob.nulls === "first" : dir === "desc");
  }
  return { values, types, dirs, nullsFirst };
}

function defaultFrame(spec: WindowSpec): FrameSpec {
  return {
    mode: "range",
    start: { kind: "unbounded_preceding" },
    end: spec.orderBy.length > 0 ? { kind: "current_row" } : { kind: "unbounded_following" },
    exclusion: null,
  };
}

function isRunningRowsFrame(frame: FrameSpec, spec: WindowSpec): boolean {
  if (frame.exclusion) return false;
  if (frame.mode !== "rows") return false;
  if (frame.start.kind !== "unbounded_preceding") return false;
  const end =
    frame.end ??
    (spec.orderBy.length > 0 ? { kind: "current_row" as const } : { kind: "unbounded_following" as const });
  return end.kind === "current_row";
}

function computeRunningAgg(
  ctx: EngineCtx,
  call: FuncCall,
  name: string,
  rowIdxs: number[],
  evalAt: RowEval,
  results: TypedValue[],
): void {
  const argTypes: TypeId[] = call.args.map((_, ai) => {
    for (const rowIdx of rowIdxs) {
      const v = evalAt(rowIdx, call.args[ai]!);
      if (v.t !== UNKNOWN) return v.t;
    }
    return UNKNOWN;
  });
  const acc = createAggregate(ctx, name, argTypes);
  for (const rowIdx of rowIdxs) {
    const argRows = call.star ? [] : call.args.map((a) => evalAt(rowIdx, a));
    acc.step(argRows);
    results[rowIdx] = acc.result();
  }
}

function excluded(frame: FrameSpec, pos: number, current: number, peerGroup: number[]): boolean {
  switch (frame.exclusion) {
    case "current_row":
      return pos === current;
    case "group":
      return peerGroup[pos] === peerGroup[current];
    case "ties":
      return peerGroup[pos] === peerGroup[current] && pos !== current;
    default:
      return false;
  }
}

/** [lo, hi] positions (inclusive) of the frame for row at `pos`. */
function frameBounds(
  ctx: EngineCtx,
  frame: FrameSpec,
  pos: number,
  rowIdxs: number[],
  peerGroup: number[],
  keys: Map<number, SortKey>,
  spec: WindowSpec,
  evalAt: RowEval,
): [number, number] {
  const n = rowIdxs.length;
  const end: FrameBound = frame.end ?? { kind: "current_row" };
  const lo = boundPos(ctx, frame.mode, frame.start, true, pos, rowIdxs, peerGroup, keys, spec, evalAt, n);
  const hi = boundPos(ctx, frame.mode, end, false, pos, rowIdxs, peerGroup, keys, spec, evalAt, n);
  return [lo, hi];
}

function boundPos(
  ctx: EngineCtx,
  mode: FrameSpec["mode"],
  bound: FrameBound,
  isStart: boolean,
  pos: number,
  rowIdxs: number[],
  peerGroup: number[],
  _keys: Map<number, SortKey>,
  spec: WindowSpec,
  evalAt: RowEval,
  n: number,
): number {
  switch (bound.kind) {
    case "unbounded_preceding":
      return 0;
    case "unbounded_following":
      return n - 1;
    case "current_row": {
      if (mode === "rows") return pos;
      // range/groups: start = first peer, end = last peer
      const g = peerGroup[pos]!;
      if (isStart) {
        let p = pos;
        while (p > 0 && peerGroup[p - 1] === g) p--;
        return p;
      }
      let p = pos;
      while (p < n - 1 && peerGroup[p + 1] === g) p++;
      return p;
    }
    case "preceding":
    case "following": {
      const offsetTv = evalAt(rowIdxs[pos]!, bound.offset!);
      if (offsetTv.v === null) {
        throw pgError("invalid_parameter_value", "frame starting offset must not be null", "22013");
      }
      if (mode === "rows") {
        const k = Number(castTo(ctx, offsetTv, "int8", {}).v as bigint);
        if (k < 0) {
          throw pgError("invalid_parameter_value", "frame starting offset must not be negative", "22013");
        }
        return bound.kind === "preceding" ? pos - k : pos + k;
      }
      if (mode === "groups") {
        const k = Number(castTo(ctx, offsetTv, "int8", {}).v as bigint);
        if (k < 0) {
          throw pgError("invalid_parameter_value", "frame starting offset must not be negative", "22013");
        }
        const targetGroup = bound.kind === "preceding" ? peerGroup[pos]! - k : peerGroup[pos]! + k;
        if (isStart) {
          for (let p = 0; p < n; p++) {
            if (peerGroup[p]! >= targetGroup) return p;
          }
          return n;
        }
        for (let p = n - 1; p >= 0; p--) {
          if (peerGroup[p]! <= targetGroup) return p;
        }
        return -1;
      }
      // RANGE with offset: single ORDER BY key required
      if (spec.orderBy.length !== 1) {
        throw pgError(
          "windowing_error",
          "RANGE with offset PRECEDING/FOLLOWING requires exactly one ORDER BY column",
          "42P20",
        );
      }
      const ob = spec.orderBy[0]!;
      const desc = (ob.dir ?? "asc") === "desc";
      const cur = evalAt(rowIdxs[pos]!, ob.expr);
      if (cur.v === null) {
        // null ordering group: frame covers the null peers
        const g = peerGroup[pos]!;
        if (isStart) {
          let p = pos;
          while (p > 0 && peerGroup[p - 1] === g) p--;
          return p;
        }
        let p = pos;
        while (p < n - 1 && peerGroup[p + 1] === g) p++;
        return p;
      }
      const back = bound.kind === "preceding" ? !desc : desc;
      const boundary = evalBinary(ctx, back ? "-" : "+", cur, offsetTv);
      // find range of rows whose key satisfies the comparison with boundary
      if (isStart) {
        for (let p = 0; p < n; p++) {
          const v = evalAt(rowIdxs[p]!, ob.expr);
          if (v.v === null) continue;
          const cmp = evalBinary(ctx, desc ? "<=" : ">=", v, boundary);
          if (cmp.v === true) return p;
        }
        return n;
      }
      for (let p = n - 1; p >= 0; p--) {
        const v = evalAt(rowIdxs[p]!, ob.expr);
        if (v.v === null) continue;
        const cmp = evalBinary(ctx, desc ? ">=" : "<=", v, boundary);
        if (cmp.v === true) return p;
      }
      return -1;
    }
  }
}

function computeRankingFunction(
  ctx: EngineCtx,
  name: string,
  call: FuncCall,
  rowIdxs: number[],
  peerGroup: number[],
  _groupCount: number,
  evalAt: RowEval,
  results: TypedValue[],
  spec: WindowSpec,
): void {
  const n = rowIdxs.length;
  switch (name) {
    case "row_number": {
      for (let pos = 0; pos < n; pos++) results[rowIdxs[pos]!] = tv("int8", BigInt(pos + 1));
      return;
    }
    case "rank": {
      const firstOfGroup: number[] = [];
      for (let pos = 0; pos < n; pos++) {
        if (pos === 0 || peerGroup[pos] !== peerGroup[pos - 1]) firstOfGroup[peerGroup[pos]!] = pos;
      }
      for (let pos = 0; pos < n; pos++) {
        results[rowIdxs[pos]!] = tv("int8", BigInt(firstOfGroup[peerGroup[pos]!]! + 1));
      }
      return;
    }
    case "dense_rank": {
      for (let pos = 0; pos < n; pos++) {
        results[rowIdxs[pos]!] = tv("int8", BigInt(peerGroup[pos]! + 1));
      }
      return;
    }
    case "percent_rank": {
      const firstOfGroup: number[] = [];
      for (let pos = 0; pos < n; pos++) {
        if (pos === 0 || peerGroup[pos] !== peerGroup[pos - 1]) firstOfGroup[peerGroup[pos]!] = pos;
      }
      for (let pos = 0; pos < n; pos++) {
        const rank = firstOfGroup[peerGroup[pos]!]! + 1;
        results[rowIdxs[pos]!] = tv("float8", n <= 1 ? 0 : (rank - 1) / (n - 1));
      }
      return;
    }
    case "cume_dist": {
      const lastOfGroup: number[] = [];
      for (let pos = n - 1; pos >= 0; pos--) {
        if (pos === n - 1 || peerGroup[pos] !== peerGroup[pos + 1]) lastOfGroup[peerGroup[pos]!] = pos;
      }
      for (let pos = 0; pos < n; pos++) {
        results[rowIdxs[pos]!] = tv("float8", (lastOfGroup[peerGroup[pos]!]! + 1) / n);
      }
      return;
    }
    case "ntile": {
      const arg = call.args[0];
      if (!arg) throw pgError("undefined_function", "ntile requires an argument", "42883");
      const bucketsTv = evalAt(rowIdxs[0] ?? 0, arg);
      if (bucketsTv.v === null) {
        for (const i of rowIdxs) results[i] = tv("int4", null);
        return;
      }
      const buckets = Number(castTo(ctx, bucketsTv, "int4", {}).v as number);
      if (buckets <= 0)
        throw pgError("invalid_parameter_value", "argument of ntile must be greater than zero", "22014");
      const base = Math.floor(n / buckets);
      const extra = n % buckets;
      let pos = 0;
      for (let b = 1; b <= buckets && pos < n; b++) {
        const size = base + (b <= extra ? 1 : 0);
        for (let k = 0; k < size && pos < n; k++, pos++) {
          results[rowIdxs[pos]!] = tv("int4", b);
        }
      }
      return;
    }
    case "lag":
    case "lead": {
      const dir = name === "lag" ? -1 : 1;
      for (let pos = 0; pos < n; pos++) {
        const cur = evalAt(rowIdxs[pos]!, call.args[0]!);
        const offset = call.args[1]
          ? Number(castTo(ctx, evalAt(rowIdxs[pos]!, call.args[1]), "int4", {}).v as number)
          : 1;
        const target = pos + dir * offset;
        if (target >= 0 && target < n) {
          results[rowIdxs[pos]!] = evalAt(rowIdxs[target]!, call.args[0]!);
        } else if (call.args[2]) {
          const dflt = evalAt(rowIdxs[pos]!, call.args[2]);
          results[rowIdxs[pos]!] = castTo(ctx, dflt, cur.t === UNKNOWN ? dflt.t : cur.t, {});
        } else {
          results[rowIdxs[pos]!] = tv(cur.t, null);
        }
      }
      return;
    }
    case "first_value":
    case "last_value":
    case "nth_value": {
      const frame = spec.frame ?? defaultFrame(spec);
      const keys = new Map<number, SortKey>();
      if (spec.orderBy.length > 0) {
        for (const i of rowIdxs) keys.set(i, sortKeyFor(ctx, spec.orderBy, i, evalAt));
      }
      for (let pos = 0; pos < n; pos++) {
        const [lo0, hi0] = frameBounds(ctx, frame, pos, rowIdxs, peerGroup, keys, spec, evalAt);
        const included: number[] = [];
        for (let p = Math.max(lo0, 0); p <= Math.min(hi0, n - 1); p++) {
          if (excluded(frame, p, pos, peerGroup)) continue;
          included.push(p);
        }
        const cur = evalAt(rowIdxs[pos]!, call.args[0]!);
        if (included.length === 0) {
          results[rowIdxs[pos]!] = tv(cur.t, null);
          continue;
        }
        let targetPos: number | null;
        if (name === "first_value") targetPos = included[0]!;
        else if (name === "last_value") targetPos = included[included.length - 1]!;
        else {
          const nth = Number(castTo(ctx, evalAt(rowIdxs[pos]!, call.args[1]!), "int4", {}).v as number);
          if (nth <= 0)
            throw pgError("invalid_parameter_value", "argument of nth_value must be greater than zero", "22016");
          targetPos = included[nth - 1] ?? null;
        }
        results[rowIdxs[pos]!] = targetPos === null ? tv(cur.t, null) : evalAt(rowIdxs[targetPos]!, call.args[0]!);
      }
      return;
    }
    default:
      throw pgError("undefined_function", `window function ${name} is not implemented`, "42883");
  }
}
