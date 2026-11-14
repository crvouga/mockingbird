import { SqliteError } from "../errors/index.ts";
import {
  applyAffinity,
  asSqlReal,
  coerceToNumber,
  compareSql,
  type SqlValue,
  storageClassOf,
  utf8Decode,
} from "../types/value.ts";

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

/** SQLite percentile extension: numeric inputs only, constant normalized fraction. */
class PercentileAccumulator implements AggregateAccumulator {
  private readonly values: number[] = [];
  private fraction: number | undefined;
  constructor(private readonly name: "median" | "percentile" | "percentile_cont" | "percentile_disc") {}
  step(args: SqlValue[]): void {
    const count = this.name === "median" ? 1 : 2;
    if (args.length !== count) throw new SqliteError(`wrong number of arguments to function ${this.name}()`, "misuse");
    const scale = this.name === "percentile" ? 100 : 1;
    const raw = this.name === "median" ? 0.5 : applyAffinity(args[1]!, "NUMERIC");
    const kind = storageClassOf(raw);
    const fraction = coerceToNumber(raw);
    if ((kind !== "integer" && kind !== "real") || fraction === null || fraction < 0 || fraction > scale) {
      throw new SqliteError(`the fraction argument to ${this.name}() is not between 0.0 and ${scale}.0`);
    }
    const normalized = fraction / scale;
    if (this.fraction !== undefined && Math.abs(this.fraction - normalized) > 0.001) {
      throw new SqliteError(`the fraction argument to ${this.name}() is not the same for all input rows`);
    }
    this.fraction ??= normalized;
    const value = args[0]!;
    if (value === null) return;
    const inputKind = storageClassOf(value);
    if (inputKind !== "integer" && inputKind !== "real")
      throw new SqliteError(`input to ${this.name}() is not numeric`);
    const number = coerceToNumber(value)!;
    if (!Number.isFinite(number)) throw new SqliteError(`Inf input to ${this.name}()`);
    this.values.push(number);
  }
  finalize(): SqlValue {
    if (!this.values.length) return null;
    this.values.sort((a, b) => a - b);
    const index = (this.fraction ?? 0.5) * (this.values.length - 1);
    const lower = Math.floor(index);
    const first = this.values[lower]!;
    if (this.name === "percentile_disc" || lower === this.values.length - 1) return asSqlReal(first);
    return asSqlReal(first + (this.values[lower + 1]! - first) * (index - lower));
  }
}

export const aggregateFunctions: Readonly<Record<string, AggregateFactory>> = {
  median: () => new PercentileAccumulator("median"),
  percentile: () => new PercentileAccumulator("percentile"),
  percentile_cont: () => new PercentileAccumulator("percentile_cont"),
  percentile_disc: () => new PercentileAccumulator("percentile_disc"),
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
