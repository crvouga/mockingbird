import { coerceToNumber, compareSql, type SqlValue, utf8Decode } from "../types/value.ts";

export interface AggregateAccumulator {
  step(args: SqlValue[]): void;
  finalize(): SqlValue;
}

export type AggregateFactory = () => AggregateAccumulator;

class CountAccumulator implements AggregateAccumulator {
  private count = 0;
  step(args: SqlValue[]): void {
    if (args.length === 0 || args[0] !== null) this.count++;
  }
  finalize(): SqlValue {
    return this.count;
  }
}

class NumericAccumulator implements AggregateAccumulator {
  private count = 0;
  private sum = 0;
  constructor(private readonly mode: "sum" | "avg" | "total") {}
  step(args: SqlValue[]): void {
    const value = args[0];
    if (value === null || value === undefined) return;
    this.sum += coerceToNumber(value) ?? 0;
    this.count++;
  }
  finalize(): SqlValue {
    if (this.mode === "total") return this.sum;
    if (this.count === 0) return null;
    return this.mode === "avg" ? this.sum / this.count : this.sum;
  }
}

class MinMaxAccumulator implements AggregateAccumulator {
  private value: SqlValue = null;
  constructor(private readonly direction: "min" | "max") {}
  step(args: SqlValue[]): void {
    const candidate = args[0];
    if (candidate === null || candidate === undefined) return;
    if (this.value === null) {
      this.value = candidate;
      return;
    }
    const comparison = compareSql(candidate, this.value)!;
    if ((this.direction === "min" && comparison < 0) || (this.direction === "max" && comparison > 0)) {
      this.value = candidate;
    }
  }
  finalize(): SqlValue {
    return this.value;
  }
}

class GroupConcatAccumulator implements AggregateAccumulator {
  private readonly values: string[] = [];
  private separator = ",";
  step(args: SqlValue[]): void {
    if (args[0] === null || args[0] === undefined) return;
    if (args[1] !== undefined && args[1] !== null) this.separator = String(args[1]);
    this.values.push(args[0] instanceof Uint8Array ? utf8Decode(args[0]) : String(args[0]));
  }
  finalize(): SqlValue {
    return this.values.length === 0 ? null : this.values.join(this.separator);
  }
}

export const aggregateFunctions: Readonly<Record<string, AggregateFactory>> = {
  count: () => new CountAccumulator(),
  sum: () => new NumericAccumulator("sum"),
  avg: () => new NumericAccumulator("avg"),
  total: () => new NumericAccumulator("total"),
  min: () => new MinMaxAccumulator("min"),
  max: () => new MinMaxAccumulator("max"),
  group_concat: () => new GroupConcatAccumulator(),
  string_agg: () => new GroupConcatAccumulator(),
};

export function createAggregate(name: string): AggregateAccumulator | undefined {
  return aggregateFunctions[name.toLowerCase()]?.();
}
