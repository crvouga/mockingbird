import type { TableData } from "../storage/database-state.ts";
import type { Datum } from "../types/value.ts";
import { RowScope } from "./relation.ts";
export function triggerScope(table: TableData, newRow: Datum[] | null, oldRow: Datum[] | null): RowScope {
  const cols: Array<{ name: string; type: import("../types/value.ts").TypeId; table: string | null }> = [];
  const row: Datum[] = [];
  const rangeVars = new Set<string>();
  if (newRow) {
    rangeVars.add("new");
    for (let i = 0; i < table.columns.length; i++) {
      cols.push({ name: table.columns[i]!.name, type: table.columns[i]!.type.id, table: "new" });
      row.push(newRow[i] ?? null);
    }
  }
  if (oldRow) {
    rangeVars.add("old");
    for (let i = 0; i < table.columns.length; i++) {
      cols.push({ name: table.columns[i]!.name, type: table.columns[i]!.type.id, table: "old" });
      row.push(oldRow[i] ?? null);
    }
  }
  return new RowScope(cols, row, null, rangeVars);
}
