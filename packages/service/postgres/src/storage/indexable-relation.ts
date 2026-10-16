import { TableData, type ViewData } from "./database-state.ts";

/** Materialized views share index validation/catalog rules with stored tables. */
export function materializedTable(view: ViewData): TableData {
  const table = new TableData(
    view.schema,
    view.name,
    (view.matColumns ?? []).map((c) => ({
      name: c.name,
      type: { id: c.type, mod: null },
      notNull: false,
      defaultExpr: null,
      identity: null,
      generated: null,
      collate: null,
      domain: null,
    })),
    view.oid,
    view.temp,
  );
  table.rows = view.matRows ?? [];
  return table;
}
