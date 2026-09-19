import type { IndexedColumn } from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import type { EvalContext } from "../expressions/context.ts";
import { evalExpr } from "../expressions/eval.ts";
import type { Cell, ExecutionEnv } from "../executor/env.ts";
import { defaultFunctionRegistry } from "../functions/registry.ts";
import type { IndexInfo } from "../storage/database-state.ts";
import { normalizeColumnName, type Row } from "../storage/row.ts";
import type { Table } from "../storage/table.ts";
import { normalizeForCollation } from "../types/collation.ts";
import { applyAffinity, type SqlValue } from "../types/value.ts";
import { isTruthySql } from "../types/value.ts";

/** Heap cells for evaluating index expressions / partial `WHERE` via `ExecutionEnv`. */
export function heapRowCells(table: Table, row: Row, env?: ExecutionEnv): Cell[] {
  const alias = table.name;
  const baseCells: Cell[] = table.columns
    .filter((column) => !column.generated || column.generated.stored)
    .map((column) => ({
      table: alias,
      name: column.name,
      value: table.cell(row, normalizeColumnName(column.name)),
      affinity: column.affinity,
      collate: column.collate,
    }));
  const cells = [...baseCells];
  if (env) {
    for (const column of table.columns) {
      if (!column.generated || column.generated.stored) continue;
      const ctx = env.createEvalContext({ cells: baseCells, sourceTable: table.name });
      const value = applyAffinity(evalExpr(column.generated.expr, ctx), column.affinity);
      cells.push({
        table: alias,
        name: column.name,
        value,
        affinity: column.affinity,
        collate: column.collate,
      });
    }
  } else {
    for (const column of table.columns) {
      if (!column.generated || column.generated.stored) continue;
      cells.push({
        table: alias,
        name: column.name,
        value: null,
        affinity: column.affinity,
        collate: column.collate,
      });
    }
  }
  cells.sort((a, b) => {
    const ai = table.columns.findIndex((column) => column.name.toLowerCase() === a.name.toLowerCase());
    const bi = table.columns.findIndex((column) => column.name.toLowerCase() === b.name.toLowerCase());
    return ai - bi;
  });
  return cells;
}

/** Indexed-column values for one heap row (expression indexes included when `ctx` is set). */
export function indexKeyValues(
  columns: readonly IndexedColumn[],
  row: Row,
  ctx?: EvalContext | null,
  table?: Table,
): SqlValue[] {
  return columns.map((column) => {
    let raw: SqlValue;
    if (column.expr && ctx) {
      raw = evalExpr(column.expr, ctx);
    } else if (ctx) {
      // Bare column refs (including VIRTUAL generated columns) come from scope, not heap storage.
      raw = ctx.resolveColumn(null, column.name);
    } else if (table) {
      raw = table.cell(row, normalizeColumnName(column.name));
    } else {
      raw = null;
    }
    return normalizeForCollation(raw, column.collate ?? "BINARY");
  });
}

/** Rebuild `index.store` from `table` using the same keys as DML maintenance. */
export function rebuildIndexFromTable(index: IndexInfo, table: Table, ctxForRow: (row: Row) => EvalContext): void {
  index.store.clear();
  for (const row of table.scan()) {
    const ctx = ctxForRow(row);
    if (index.where && isTruthySql(evalExpr(index.where, ctx)) !== true) continue;
    index.store.insert(indexKeyValues(index.columns, row, ctx, table), row.rowid, index.unique);
  }
}

/** Snapshot / no-`ExecutionEnv` evaluator for index expressions / partial predicates. */
export function tableRowEvalContext(table: Table, row: Row): EvalContext {
  return {
    functions: defaultFunctionRegistry,
    resolveColumn: (qualifier, name) => {
      if (qualifier && qualifier.toLowerCase() !== table.name.toLowerCase()) {
        throw new SqliteError(`no such column: ${qualifier}.${name}`, "no_such_column");
      }
      const key = name.toLowerCase();
      if (key === "rowid" || key === "_rowid_" || key === "oid") return row.rowid;
      if (!table.hasColumn(key) && key !== "rowid") {
        throw new SqliteError(`no such column: ${name}`, "no_such_column");
      }
      return table.cell(row, key);
    },
    getParameter: () => {
      throw new SqliteError("parameters are not allowed in index predicates", "misuse");
    },
  };
}
