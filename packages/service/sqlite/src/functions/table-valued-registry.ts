import type { ExecutionEnv, ScopeRow } from "../executor/env.ts";
import type { SqlValue } from "../types/value.ts";

export interface TableValuedResult {
  columns: string[];
  rows: ScopeRow[];
}

export type TableValuedFn = (args: SqlValue[], alias: string | null, env: ExecutionEnv) => TableValuedResult;

const registry = new Map<string, TableValuedFn>();

export function registerTableValuedFunction(name: string, fn: TableValuedFn): void {
  registry.set(name.toLowerCase(), fn);
}

export function getTableValuedFunction(name: string): TableValuedFn | undefined {
  return registry.get(name.toLowerCase());
}

export function listRegisteredTableValuedFunctions(): string[] {
  return [...registry.keys()].sort();
}

export function hasRegisteredTableValuedFunction(name: string): boolean {
  return registry.has(name.toLowerCase());
}
