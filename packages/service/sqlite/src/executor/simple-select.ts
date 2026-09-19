import type { Expr, ResultColumn, SelectStmt } from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import {
  conjunctions,
  equalityAgainstConst,
  lookupTableRows,
  tryIndexedOrder,
  tryJoinEqualityKeys,
  whereFullyCovered,
} from "../planner/access.ts";
import { isExpectedFastPathMiss } from "../runtime/catch.ts";
import type { Row } from "../storage/row.ts";
import type { Table } from "../storage/table.ts";
import { applyAffinity, canonicalizeNumber, compareSql, type SqlValue, toInteger } from "../types/value.ts";
import type { ExecutionEnv } from "./env.ts";
import { type ResultSet, valuesToResult } from "./result.ts";

/**
 * Tight path for `SELECT cols FROM table WHERE col = ?` (no join/group/order).
 * Skips ScopeRow / evalExpr and honors maxRows during the scan.
 */
export function tryExecuteSimpleSelect(stmt: SelectStmt, env: ExecutionEnv): ResultSet | null {
  if (stmt.with || stmt.compound || stmt.distinct || stmt.groupBy.length > 0 || stmt.having || stmt.windows.length > 0)
    return null;
  if (stmt.orderBy.length > 1) return null;
  if (stmt.orderBy.length === 1 && stmt.where) return null;
  if (stmt.from?.type !== "table") return null;
  for (const column of stmt.columns) {
    if (column.type === "star") continue;
    if (column.expr.type !== "column") return null;
  }

  const from = stmt.from;
  const nameKey = from.name.toLowerCase();
  if (nameKey === "sqlite_schema" || nameKey === "sqlite_master") return null;
  if (env.ctes.has(nameKey)) return null;
  const qualified = from.schema ? `${from.schema}.${from.name}` : from.name;
  const db = env.state.databaseForSchema(from.schema, qualified);
  if (db.virtualTables.has(nameKey) || db.views.has(nameKey)) return null;

  let table: Table;
  try {
    table = db.getTable(from.name);
  } catch (error) {
    if (!isExpectedFastPathMiss(error)) throw error;
    return null;
  }
  if (table.withoutRowid) return null;
  if (table.columns.some((column) => column.generated && !column.generated.stored)) return null;

  const alias = from.alias ?? from.name;
  const aliasLower = alias.toLowerCase();
  const tableLower = table.name.toLowerCase();
  for (const column of stmt.columns) {
    if (column.type === "star") continue;
    if (column.expr.type !== "column") return null;
    const tableRef = column.expr.table?.toLowerCase();
    if (tableRef && tableRef !== aliasLower && tableRef !== tableLower && tableRef !== nameKey) return null;
    const key = column.expr.name.toLowerCase();
    if (isRowidName(key)) continue;
    if (!table.columns.some((item) => (item.nameLower ?? item.name.toLowerCase()) === key)) return null;
  }

  const filters: { column: string; value: SqlValue }[] = [];
  if (stmt.where) {
    for (const part of conjunctions(stmt.where)) {
      const eq = equalityAgainstConst(part);
      if (!eq) return null;
      let value: SqlValue;
      try {
        value = evalIndependent(eq.valueExpr, env);
      } catch (error) {
        if (error instanceof SqliteError) return null;
        throw error;
      }
      const column = eq.column.toLowerCase();
      const affinity = isRowidName(column)
        ? "INTEGER"
        : table.columns.find((item) => (item.nameLower ?? item.name.toLowerCase()) === column)?.affinity;
      filters.push({ column, value: affinity ? applyAffinity(value, affinity) : value });
    }
  }

  let limit = env.maxRows;
  let offset = 0;
  if (stmt.limit) {
    try {
      const limitValue = toInteger(evalIndependent(stmt.limit.limit, env));
      const offsetValue = stmt.limit.offset ? toInteger(evalIndependent(stmt.limit.offset, env)) : 0;
      if (limitValue === null || offsetValue === null) return null;
      offset = Math.max(0, Number(offsetValue));
      const n = Number(limitValue);
      if (n >= 0) limit = Math.min(limit, n);
    } catch (error) {
      if (error instanceof SqliteError) return null;
      throw error;
    }
  }
  const columns = projectNames(stmt.columns, table);
  if (limit <= 0) return pack(env, columns, []);

  let source: Iterable<Row> = table.scan();
  let alreadyFiltered = false;

  if (stmt.orderBy.length === 1 && stmt.orderBy[0]) {
    const take = limit < Number.MAX_SAFE_INTEGER ? offset + limit : undefined;
    const ordered = tryIndexedOrder(from, { expr: stmt.orderBy[0].expr, dir: stmt.orderBy[0].dir ?? "ASC" }, env, take);
    if (!ordered) return null;
    source = ordered.rows;
    alreadyFiltered = true;
  } else if (stmt.where) {
    const indexed = lookupTableRows(from, stmt.where, env);
    if (indexed) {
      source = indexed.rows;
      alreadyFiltered = whereFullyCovered(stmt.where, indexed.coveredColumns, alias, table.name);
    }
  }

  const projectors = projectionFns(stmt.columns, table);
  const values: SqlValue[][] = [];
  let skipped = 0;

  for (const row of source) {
    if (!alreadyFiltered && filters.length > 0 && !rowMatches(table, row, filters)) continue;
    if (skipped < offset) {
      skipped++;
      continue;
    }
    values.push(projectors.map((fn) => fn(row)));
    if (values.length >= limit) break;
  }

  return pack(env, columns, values);
}

export function tryExecuteSimpleJoin(stmt: SelectStmt, env: ExecutionEnv): ResultSet | null {
  if (stmt.with || stmt.compound || stmt.distinct || stmt.groupBy.length > 0 || stmt.having || stmt.windows.length > 0)
    return null;
  if (stmt.orderBy.length > 0 || stmt.limit || stmt.where) return null;
  if (stmt.from?.type !== "join") return null;
  const join = stmt.from;
  if ((join.joinType !== "INNER" && join.joinType !== "CROSS") || join.using || !join.on) return null;
  if (join.left.type !== "table" || join.right.type !== "table") return null;
  const keys = tryJoinEqualityKeys(join.right, join.on, env);
  if (keys?.rightColumns.length !== 1) return null;

  const leftRef = join.left;
  const rightRef = join.right;
  const leftDb = env.state.databaseForSchema(
    leftRef.schema,
    leftRef.schema ? `${leftRef.schema}.${leftRef.name}` : leftRef.name,
  );
  const rightDb = env.state.databaseForSchema(
    rightRef.schema,
    rightRef.schema ? `${rightRef.schema}.${rightRef.name}` : rightRef.name,
  );
  if (env.ctes.has(leftRef.name.toLowerCase()) || env.ctes.has(rightRef.name.toLowerCase())) return null;
  if (leftDb.views.has(leftRef.name.toLowerCase()) || rightDb.views.has(rightRef.name.toLowerCase())) return null;
  if (leftDb.virtualTables.has(leftRef.name.toLowerCase()) || rightDb.virtualTables.has(rightRef.name.toLowerCase()))
    return null;

  let leftTable: Table;
  let rightTable: Table;
  try {
    leftTable = leftDb.getTable(leftRef.name);
    rightTable = rightDb.getTable(rightRef.name);
  } catch (error) {
    if (!isExpectedFastPathMiss(error)) throw error;
    return null;
  }
  if (leftTable.withoutRowid || rightTable.withoutRowid) return null;

  const leftAlias = (leftRef.alias ?? leftRef.name).toLowerCase();
  const rightAlias = (rightRef.alias ?? rightRef.name).toLowerCase();
  const rightCol = keys.rightColumns[0]!.toLowerCase();
  const leftCol = keys.leftKeys[0]!.column.toLowerCase();
  if (!rightTable.ensureEqualityHash(rightCol)) return null;

  const names: string[] = [];
  const projectors: ((left: Row, right: Row) => SqlValue)[] = [];
  for (const column of stmt.columns) {
    if (column.type !== "expr" || column.expr.type !== "column") return null;
    const tableRef = column.expr.table?.toLowerCase() ?? null;
    const key = column.expr.name.toLowerCase();
    const onLeft =
      tableRef === null
        ? leftTable.columns.some((item) => (item.nameLower ?? item.name.toLowerCase()) === key)
        : tableRef === leftAlias || tableRef === leftTable.name.toLowerCase();
    const onRight =
      tableRef === null
        ? rightTable.columns.some((item) => (item.nameLower ?? item.name.toLowerCase()) === key)
        : tableRef === rightAlias || tableRef === rightTable.name.toLowerCase();
    if (onLeft === onRight) return null;
    names.push(column.alias ?? column.expr.name);
    if (onLeft) {
      if (isRowidName(key)) projectors.push((left) => left.rowid);
      else projectors.push((left) => leftTable.cell(left, key));
    } else {
      if (isRowidName(key)) projectors.push((_left, right) => right.rowid);
      else projectors.push((_left, right) => rightTable.cell(right, key));
    }
  }

  const values: SqlValue[][] = [];
  for (const left of leftTable.scan()) {
    const matches = rightTable.lookupEquality(rightCol, leftTable.cell(left, leftCol));
    if (!matches) return null;
    for (const right of matches) values.push(projectors.map((fn) => fn(left, right)));
  }
  return pack(env, names, values);
}

function rowMatches(table: Table, row: Row, filters: { column: string; value: SqlValue }[]): boolean {
  for (const filter of filters) {
    if (isRowidName(filter.column)) {
      if (compareSql(row.rowid, filter.value) !== 0) return false;
      continue;
    }
    if (compareSql(table.cell(row, filter.column), filter.value) !== 0) return false;
  }
  return true;
}

function projectNames(columns: ResultColumn[], table: Table): string[] {
  const names: string[] = [];
  for (const column of columns) {
    if (column.type === "star") {
      for (const item of table.columns) names.push(item.name);
      continue;
    }
    if (column.alias) {
      names.push(column.alias);
      continue;
    }
    const key = column.expr.type === "column" ? column.expr.name.toLowerCase() : "";
    if (isRowidName(key)) names.push(table.integerPkColumn()?.name ?? "rowid");
    else names.push(column.expr.type === "column" ? column.expr.name : "?column?");
  }
  return names;
}

function projectionFns(columns: ResultColumn[], table: Table): ((row: Row) => SqlValue)[] {
  const fns: ((row: Row) => SqlValue)[] = [];
  for (const column of columns) {
    if (column.type === "star") {
      for (const item of table.columns) {
        const key = item.nameLower ?? item.name.toLowerCase();
        fns.push((row) => table.cell(row, key));
      }
      continue;
    }
    const expr = column.expr;
    if (expr.type !== "column") continue;
    const key = expr.name.toLowerCase();
    if (isRowidName(key)) fns.push((row) => row.rowid);
    else fns.push((row) => table.cell(row, key));
  }
  return fns;
}

function evalIndependent(expr: Expr, env: ExecutionEnv): SqlValue {
  if (expr.type === "literal") return expr.value;
  if (expr.type === "null") return null;
  if (expr.type === "parameter") return env.getBoundParameter(expr.name);
  if (expr.type === "unary" && expr.op === "-" && expr.expr.type === "literal" && typeof expr.expr.value === "number") {
    return canonicalizeNumber(-expr.expr.value);
  }
  throw new Error("not independent");
}

function isRowidName(name: string): boolean {
  return name === "rowid" || name === "_rowid_" || name === "oid";
}

function pack(env: ExecutionEnv, columns: string[], values: SqlValue[][]): ResultSet {
  return valuesToResult(columns, values, 0, env.state.lastInsertRowid, {
    named: env.includeNamedRows,
    keepValues: true,
  });
}
