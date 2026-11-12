import { pgError, unsupported } from "../errors/error.ts";
import type { Datum, PgArray, TypeId } from "./value.ts";
import { isPgArray, makeArray } from "./value.ts";

/** One subscript of an assignment target: `[i]` (lower only) or a slice `[lo:hi]` (either bound may be omitted). */
export interface AssignSubscript {
  lower: number | null;
  upper: number | null;
  slice: boolean;
}

const outOfRange = () => pgError("array_subscript_error", "array subscript out of range", "2202E");

/**
 * `arr[i][j] := value` / `arr[lo:hi] := values` as PostgreSQL's array subscripting assignment does
 * it: a NULL or empty array becomes a new one whose bounds are the subscripts, a one-dimensional
 * array extends (padding with NULLs) to take an element or slice past either end, and a
 * multi-dimensional one only takes elements within its bounds.
 */
export function assignArraySubscripts(
  current: Datum,
  elem: TypeId,
  subscripts: AssignSubscript[],
  value: Datum,
): PgArray {
  const arr: PgArray | null = current !== null && isPgArray(current) ? current : null;
  if (subscripts.some((s) => s.slice)) return assignSlice(arr, elem, subscripts, value);
  const index = subscripts.map((s) => s.lower!);
  if (arr === null || arr.dims.length === 0) {
    return makeArray(
      elem,
      [value],
      index.map(() => 1),
      index,
    );
  }
  if (index.length !== arr.dims.length) {
    throw pgError("array_subscript_error", "wrong number of array subscripts", "2202E");
  }
  if (arr.dims.length === 1) {
    const lb = arr.lbs[0] ?? 1;
    const ub = lb + arr.dims[0]! - 1;
    const i = index[0]!;
    const newLb = Math.min(lb, i);
    const newUb = Math.max(ub, i);
    const items: Datum[] = new Array(newUb - newLb + 1).fill(null);
    arr.items.forEach((item, k) => {
      items[lb - newLb + k] = item;
    });
    items[i - newLb] = value;
    return makeArray(elem, items, [items.length], [newLb]);
  }
  let offset = 0;
  for (let d = 0; d < arr.dims.length; d++) {
    const lb = arr.lbs[d] ?? 1;
    const k = index[d]! - lb;
    if (k < 0 || k >= arr.dims[d]!) throw outOfRange();
    offset = offset * arr.dims[d]! + k;
  }
  const items = arr.items.slice();
  items[offset] = value;
  return makeArray(elem, items, arr.dims.slice(), arr.lbs.slice());
}

function assignSlice(arr: PgArray | null, elem: TypeId, subscripts: AssignSubscript[], value: Datum): PgArray {
  const dims = arr?.dims.length ?? 0;
  if (subscripts.length !== 1 || dims > 1) throw unsupported("assignment to a multi-dimensional array slice");
  const source: Datum[] = value !== null && isPgArray(value) ? value.items : [];
  const [s] = subscripts as [AssignSubscript];
  if (arr === null || dims === 0) {
    if (s.lower === null || s.upper === null) {
      throw pgError("array_subscript_error", "array slice subscript must provide both boundaries", "2202E");
    }
    if (s.upper < s.lower) return makeArray(elem, [], [], []);
    const count = s.upper - s.lower + 1;
    if (source.length < count) throw pgError("array_subscript_error", "source array too small", "2202E");
    return makeArray(elem, source.slice(0, count), [count], [s.lower]);
  }
  const lb = arr.lbs[0] ?? 1;
  const ub = lb + arr.dims[0]! - 1;
  const lo = s.lower ?? lb;
  const hi = s.upper ?? ub;
  if (hi < lo) return arr;
  const count = hi - lo + 1;
  if (source.length < count) throw pgError("array_subscript_error", "source array too small", "2202E");
  // an extension must not leave a gap PostgreSQL could not fill: it pads with NULLs like element assignment
  const newLb = Math.min(lb, lo);
  const newUb = Math.max(ub, hi);
  const items: Datum[] = new Array(newUb - newLb + 1).fill(null);
  arr.items.forEach((item, k) => {
    items[lb - newLb + k] = item;
  });
  for (let k = 0; k < count; k++) items[lo - newLb + k] = source[k] ?? null;
  return makeArray(elem, items, [items.length], [newLb]);
}
