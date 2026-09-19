/**
 * Register all oracle-exposed `pragma_*` eponymous table-valued functions.
 * Imported for side effects from table-valued / select.
 */
import { isPragmaTvfName, PRAGMA_TVF_NAMES, queryPragma } from "../executor/pragma-engine.ts";
import type { SqlValue } from "../types/value.ts";
import { registerTableValuedFunction, type TableValuedResult } from "./table-valued-registry.ts";

function toTvfResult(
  alias: string | null,
  defaultName: string,
  columns: string[],
  rows: SqlValue[][],
): TableValuedResult {
  const table = alias ?? defaultName;
  return {
    columns,
    rows: rows.map((row) => ({
      cells: columns.map((name, index) => ({
        table,
        name,
        value: row[index] ?? null,
      })),
    })),
  };
}

let registered = false;

/** Idempotent registration of every oracle `pragma_*` TVF. */
export function ensurePragmaTvfsRegistered(): void {
  if (registered) return;
  registered = true;
  for (const baseName of PRAGMA_TVF_NAMES) {
    const tvfName = `pragma_${baseName}`;
    registerTableValuedFunction(tvfName, (args, alias, env) => {
      const result = queryPragma(baseName, args, env);
      return toTvfResult(alias, tvfName, result.columns, result.rows);
    });
  }
}

export { isPragmaTvfName };
