import { compareSql, type SqlValue } from "../types/value.ts";

export type PartitionRow = SqlValue[];

function rowsEqual(left: PartitionRow, right: PartitionRow): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => {
    const other = right[index];
    return (value === null && other === null) || (other !== undefined && compareSql(value, other) === 0);
  });
}

export function rowNumber(_partition: PartitionRow[], index: number): number {
  return index + 1;
}

export function rank(partition: PartitionRow[], index: number, orderKeys: PartitionRow[] = partition): number {
  if (index <= 0) return 1;
  let firstPeer = index;
  while (firstPeer > 0 && rowsEqual(orderKeys[firstPeer]!, orderKeys[firstPeer - 1]!)) firstPeer--;
  return firstPeer + 1;
}

export function denseRank(partition: PartitionRow[], index: number, orderKeys: PartitionRow[] = partition): number {
  if (index <= 0) return 1;
  let result = 1;
  for (let i = 1; i <= index; i++) {
    if (!rowsEqual(orderKeys[i]!, orderKeys[i - 1]!)) result++;
  }
  return result;
}

export function lag(
  partition: PartitionRow[],
  index: number,
  valueIndex = 0,
  offset = 1,
  defaultValue: SqlValue = null,
): SqlValue {
  const target = index - Math.max(0, Math.trunc(offset));
  return target < 0 ? defaultValue : (partition[target]?.[valueIndex] ?? null);
}

export function lead(
  partition: PartitionRow[],
  index: number,
  valueIndex = 0,
  offset = 1,
  defaultValue: SqlValue = null,
): SqlValue {
  const target = index + Math.max(0, Math.trunc(offset));
  return target >= partition.length ? defaultValue : (partition[target]?.[valueIndex] ?? null);
}

export function firstValue(partition: PartitionRow[], valueIndex = 0, frameStart = 0): SqlValue {
  return partition[frameStart]?.[valueIndex] ?? null;
}

export function lastValue(partition: PartitionRow[], valueIndex = 0, frameEnd = partition.length - 1): SqlValue {
  return partition[frameEnd]?.[valueIndex] ?? null;
}

export function nthValue(partition: PartitionRow[], n: number, valueIndex = 0, frameStart = 0): SqlValue {
  const offset = Math.trunc(n);
  if (offset <= 0) return null;
  return partition[frameStart + offset - 1]?.[valueIndex] ?? null;
}

export const windowFunctions = {
  row_number: rowNumber,
  rank,
  dense_rank: denseRank,
  lag,
  lead,
  first_value: firstValue,
  last_value: lastValue,
  nth_value: nthValue,
  ntile: () => 0,
  cume_dist: () => 0,
  percent_rank: () => 0,
} as const;
