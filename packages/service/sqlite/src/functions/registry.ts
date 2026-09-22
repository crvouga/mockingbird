import type { SqlValue } from "../types/value.ts";
import { type AggregateAccumulator, type AggregateFactory, aggregateFunctions } from "./aggregate.ts";
import { dateTimeFunctions } from "./datetime.ts";
import { ftsAuxFunctions, rtreeAuxFunctions } from "./extensions.ts";
import { jsonAggregateFunctions, jsonScalarFunctions } from "./json.ts";
import { mathFunctions } from "./math.ts";
import { getScalarFunctions } from "./scalar.ts";

export interface FunctionContext {
  changes?: () => number;
  totalChanges?: () => number;
  lastInsertRowid?: () => number | bigint;
  /** Injectable clock — defaults to a fixed instant on Database. */
  now?: () => Date;
  /** Injectable SQLite `random()` source — defaults to a seeded PRNG on Database. */
  random?: () => bigint;
  /** Raw unsigned 64-bit PRNG draws for `randomblob`. */
  randomU64?: () => bigint;
  /** Active FTS MATCH cursor when evaluating projections with MATCH in WHERE. */
  ftsMatch?: import("../vtable/fts5.ts").FtsMatchCursor | null;
  /** SQLite `PRAGMA case_sensitive_like` for LIKE / like(). */
  caseSensitiveLike?: boolean;
  /** Current rowid for FTS aux defaults when MATCH is absent. */
  ftsRowid?: import("../storage/row.ts").Rowid;
  /** Source FTS table name for the current scan row. */
  ftsSourceTable?: string;
  /** Resolve FTS table by name for aux functions. */
  getFtsTable?: (name: string) => import("../vtable/fts5.ts").Fts5VirtualTable | null;
}

export type ScalarFunction = (args: SqlValue[], context: FunctionContext) => SqlValue;

export class FunctionRegistry {
  private readonly scalars = new Map<string, ScalarFunction>();
  private readonly aggregates = new Map<string, AggregateFactory>();

  constructor() {
    for (const [name, fn] of Object.entries(getScalarFunctions())) this.scalars.set(name, fn);
    for (const [name, fn] of Object.entries(dateTimeFunctions)) this.scalars.set(name, fn);
    for (const [name, fn] of Object.entries(jsonScalarFunctions)) this.scalars.set(name, fn);
    for (const [name, fn] of Object.entries(mathFunctions)) this.scalars.set(name, fn);
    for (const [name, fn] of Object.entries(ftsAuxFunctions)) this.scalars.set(name, fn);
    for (const [name, fn] of Object.entries(rtreeAuxFunctions)) this.scalars.set(name, fn);
    for (const [name, factory] of Object.entries(aggregateFunctions)) this.aggregates.set(name, factory);
    for (const [name, factory] of Object.entries(jsonAggregateFunctions)) this.aggregates.set(name, factory);
  }

  registerScalar(name: string, fn: ScalarFunction): void {
    this.scalars.set(name.toLowerCase(), fn);
  }

  registerAggregate(name: string, factory: AggregateFactory): void {
    this.aggregates.set(name.toLowerCase(), factory);
  }

  lookupScalar(name: string): ScalarFunction | undefined {
    return this.scalars.get(name.toLowerCase());
  }

  lookupAggregate(name: string): AggregateFactory | undefined {
    return this.aggregates.get(name.toLowerCase());
  }

  createAggregate(name: string): AggregateAccumulator | undefined {
    return this.lookupAggregate(name)?.();
  }

  isAggregateName(name: string): boolean {
    return this.aggregates.has(name.toLowerCase());
  }
}

export const defaultFunctionRegistry = new FunctionRegistry();

export function lookupScalar(name: string): ScalarFunction | undefined {
  return defaultFunctionRegistry.lookupScalar(name);
}

export function lookupAggregate(name: string): AggregateFactory | undefined {
  return defaultFunctionRegistry.lookupAggregate(name);
}

export function isAggregateName(name: string): boolean {
  return defaultFunctionRegistry.isAggregateName(name);
}
