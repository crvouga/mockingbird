import type { Expr } from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import type { IndexStore } from "../indexes/index.ts";
import type { Row, Rowid } from "../storage/row.ts";
import { normalizeColumnName } from "../storage/row.ts";
import type { Table } from "../storage/table.ts";
import type { SqlValue } from "../types/value.ts";
import { isTruthySql } from "../types/value.ts";

export type CheckEvaluator = (expr: Expr, row: Row) => SqlValue;

export function checkNotNull(table: Table, row: Row): void {
  for (const column of table.columns) {
    if (!column.notNull) continue;
    if (table.cell(row, normalizeColumnName(column.name)) === null) {
      throw new SqliteError(
        `NOT NULL constraint failed: ${table.name}.${column.name}`,
        "constraint_notnull",
        "SQLITE_CONSTRAINT_NOTNULL",
      );
    }
  }
}

export function checkPrimaryKey(table: Table, row: Row): void {
  for (const column of table.columns) {
    if (!column.primaryKey) continue;
    if (table.cell(row, normalizeColumnName(column.name)) === null) {
      throw new SqliteError(
        `PRIMARY KEY constraint failed: ${table.name}.${column.name}`,
        "constraint_primary",
        "SQLITE_CONSTRAINT_PRIMARYKEY",
      );
    }
  }
}

export function checkUnique(index: IndexStore, values: readonly SqlValue[], rowid?: Rowid): void {
  index.checkUnique(values, rowid);
}

export function checkExpressions(
  expressions: readonly Expr[],
  row: Row,
  evaluate: CheckEvaluator,
  constraintName = "CHECK",
): void {
  for (const expression of expressions) {
    const result = evaluate(expression, row);
    if (result !== null && isTruthySql(result) === false) {
      throw new SqliteError(
        `CHECK constraint failed: ${constraintName}`,
        "constraint_check",
        "SQLITE_CONSTRAINT_CHECK",
      );
    }
  }
}

export function checkTableConstraints(table: Table, row: Row, evaluate: CheckEvaluator): void {
  checkNotNull(table, row);
  checkPrimaryKey(table, row);
  for (const constraint of table.constraints) {
    if (constraint.type !== "check") continue;
    checkExpressions([constraint.expr], row, evaluate, constraint.name ?? table.name);
  }
}
