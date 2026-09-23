import type {
  AggregateExpr,
  Expr,
  FromItem,
  OrderByItem,
  ResultColumn,
  SelectStmt,
  WindowExpr,
  WindowSpec,
  WithClause,
} from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import type { EvalContext } from "../expressions/context.ts";
import { evalExpr, explicitCollation } from "../expressions/eval.ts";
import { isPragmaTvfName } from "../functions/pragma-tvf.ts";
import { evaluateTableFunction, hasTableValuedFunction, tableValuedColumns } from "../functions/table-valued.ts";
import { serializeIndexKey } from "../indexes/index.ts";
import {
  tryIndexedOrder,
  tryIndexedTableRows,
  tryJoinEqualityKeys,
  tryJoinProbe,
  whereFullyCovered,
} from "../planner/access.ts";
import { buildSqliteMaster, buildSqliteSchema } from "../schema/catalog.ts";
import type { DatabaseState } from "../storage/database-state.ts";
import type { Row } from "../storage/row.ts";
import type { Table } from "../storage/table.ts";
import { compareWithCollation, normalizeForCollation } from "../types/collation.ts";
import {
  type Affinity,
  applyAffinity,
  compareSql,
  isTruthySql,
  type SqlValue,
  sqlValueEquals,
  toInteger,
} from "../types/value.ts";
import type { FtsVocabVirtualTable } from "../vtable/modules.ts";
import type { ExecutionEnv, ScopeRow } from "./env.ts";
import { makeCell } from "./env.ts";
import { type ResultSet, resultValues, valuesToResult } from "./result.ts";
import { tryExecuteSimpleJoin, tryExecuteSimpleSelect } from "./simple-select.ts";

function applyAffinityLocal(value: SqlValue, affinity: Affinity): SqlValue {
  return applyAffinity(value, affinity);
}

interface OutputRow {
  values: SqlValue[];
  scope: ScopeRow;
}

export function executeSelect(stmt: SelectStmt, env: ExecutionEnv, parent?: EvalContext): ResultSet {
  env.selectRunner = executeSelect;
  if (!parent && !stmt.with && !stmt.compound && !env.forceFullSelect) {
    const simple = tryExecuteSimpleSelect(stmt, env) ?? tryExecuteSimpleJoin(stmt, env);
    if (simple) return simple;
  }
  const savedCtes = new Map(env.ctes);
  try {
    if (stmt.with) executeWith(stmt.with, env, parent);
    const base = executeSelectCore(
      {
        ...stmt,
        with: null,
        compound: null,
        orderBy: stmt.compound ? [] : stmt.orderBy,
        limit: stmt.compound ? null : stmt.limit,
      },
      env,
      parent,
    );
    if (!stmt.compound) return base;
    const right = executeSelect(stmt.compound.select, env, parent);
    if (base.columns.length !== right.columns.length) {
      throw new SqliteError(
        "SELECTs to the left and right of compound operator do not have the same number of result columns",
        "other",
      );
    }
    const leftRows = resultValues(base);
    const rightRows = resultValues(right);
    let rows: SqlValue[][];
    switch (stmt.compound.op) {
      case "UNION ALL":
        rows = [...leftRows, ...rightRows];
        break;
      case "UNION":
        rows = uniqueRows([...leftRows, ...rightRows]);
        break;
      case "INTERSECT":
        rows = uniqueRows(leftRows).filter((row) => rightRows.some((other) => rowsEqual(row, other)));
        break;
      case "EXCEPT":
        rows = uniqueRows(leftRows).filter((row) => !rightRows.some((other) => rowsEqual(row, other)));
        break;
    }
    if (stmt.orderBy.length > 0) rows.sort((a, b) => compareCompoundRows(a, b, stmt.orderBy, base.columns));
    if (stmt.limit) {
      const ctx = env.createEvalContext(null, parent);
      const limitValue = toInteger(evalExpr(stmt.limit.limit, ctx));
      const offsetValue = stmt.limit.offset ? toInteger(evalExpr(stmt.limit.offset, ctx)) : 0;
      if (limitValue === null || offsetValue === null) throw new SqliteError("datatype mismatch", "datatype_mismatch");
      const offset = Math.max(0, Number(offsetValue));
      const limit = Number(limitValue);
      rows = rows.slice(offset, limit < 0 ? undefined : offset + limit);
    }
    return valuesToResult(base.columns, rows, 0, env.state.lastInsertRowid, {
      named: env.includeNamedRows,
      keepValues: true,
    });
  } finally {
    env.ctes.clear();
    for (const [name, result] of savedCtes) env.ctes.set(name, result);
  }
}

export function executeWith(withClause: WithClause, env: ExecutionEnv, parent?: EvalContext): void {
  for (const cte of withClause.ctes) {
    const key = cte.name.toLowerCase();
    if (withClause.recursive && referencesTable(cte.select, cte.name) && cte.select.compound) {
      const anchor = executeSelect({ ...cte.select, compound: null }, env, parent);
      const columns = cte.columns ?? anchor.columns;
      const recursive = cte.select.compound.select;
      const limit = recursive.limit
        ? toInteger(evalExpr(recursive.limit.limit, env.createEvalContext(null, parent)))
        : null;
      if (recursive.limit && limit === null) throw new SqliteError("datatype mismatch", "datatype_mismatch");
      const maxRows = limit === null || Number(limit) < 0 ? Number.POSITIVE_INFINITY : Number(limit);
      const queue = resultValues(anchor);
      const discovered = [...queue];
      const accumulated: SqlValue[][] = [];
      if (recursive.orderBy.length > 0) {
        queue.sort((left, right) => compareCteQueueRows(left, right, columns, recursive.orderBy, env, parent));
      }
      while (queue.length > 0 && accumulated.length < maxRows) {
        const current = queue.shift()!;
        accumulated.push(current);
        env.ctes.set(key, valuesToResult(columns, [current]));
        const nextResult = executeSelect({ ...recursive, orderBy: [], limit: null }, env, parent);
        const candidates = resultValues(nextResult);
        const additions: SqlValue[][] = [];
        for (const candidate of candidates) {
          if (
            cte.select.compound.op !== "UNION ALL" &&
            [...discovered, ...additions].some((existing) => rowsEqual(existing, candidate))
          )
            continue;
          additions.push(candidate);
        }
        discovered.push(...additions);
        queue.push(...additions);
        if (recursive.orderBy.length > 0) {
          queue.sort((left, right) => compareCteQueueRows(left, right, columns, recursive.orderBy, env, parent));
        }
      }
      env.ctes.set(key, valuesToResult(columns, accumulated));
    } else {
      const result = executeSelect(cte.select, env, parent);
      const columns = cte.columns ?? result.columns;
      env.ctes.set(key, valuesToResult(columns, resultValues(result)));
    }
  }
}

function compareCteQueueRows(
  left: SqlValue[],
  right: SqlValue[],
  columns: string[],
  order: OrderByItem[],
  env: ExecutionEnv,
  parent?: EvalContext,
): number {
  const scope = (values: SqlValue[]): ScopeRow => ({
    cells: columns.map((name, index) => ({ table: null, name, value: values[index] ?? null })),
  });
  const leftScope = scope(left);
  const rightScope = scope(right);
  for (const item of order) {
    if (item.expr.type === "literal" && typeof item.expr.value === "number" && Number.isInteger(item.expr.value)) {
      const index = item.expr.value - 1;
      const result = compareNullable(left[index] ?? null, right[index] ?? null, item);
      if (result !== 0) return result;
      continue;
    }
    const a = evalExpr(item.expr, env.createEvalContext(leftScope, parent));
    const b = evalExpr(item.expr, env.createEvalContext(rightScope, parent));
    const result = compareNullable(a, b, item, leftScope);
    if (result !== 0) return result;
  }
  return 0;
}

function executeSelectCore(stmt: SelectStmt, env: ExecutionEnv, parent?: EvalContext): ResultSet {
  let scopes: ScopeRow[];
  let skipWhere = false;
  let skipOrder = false;
  if (stmt.from && stmt.where) {
    const indexed = tryIndexedTableRows(stmt.from, stmt.where, env);
    if (indexed) {
      scopes = scopesFromTableRows(indexed.table, indexed.rows, indexed.alias, env, parent);
      skipWhere = whereFullyCovered(stmt.where, indexed.coveredColumns, indexed.alias, indexed.table.name);
    } else {
      scopes = scanFrom(stmt.from, env, parent);
    }
  } else if (stmt.from && stmt.orderBy.length === 1 && stmt.orderBy[0]) {
    const canUseIndexedOrderScan =
      stmt.groupBy.length === 0 &&
      stmt.having === null &&
      !stmt.distinct &&
      !stmt.columns.some((column) => column.type === "expr" && containsAggregate(column.expr));
    let take: number | undefined;
    if (canUseIndexedOrderScan && stmt.limit) {
      const ctx = env.createEvalContext(null, parent);
      const limitValue = toInteger(evalExpr(stmt.limit.limit, ctx));
      const offsetValue = stmt.limit.offset ? toInteger(evalExpr(stmt.limit.offset, ctx)) : 0;
      if (limitValue !== null && offsetValue !== null) {
        const offset = Math.max(0, Number(offsetValue));
        const limit = Number(limitValue);
        take = limit < 0 ? undefined : offset + limit;
      }
    }
    if (canUseIndexedOrderScan) {
      const ordered = tryIndexedOrder(
        stmt.from,
        { expr: stmt.orderBy[0].expr, dir: stmt.orderBy[0].dir ?? "ASC" },
        env,
        take,
      );
      if (ordered) {
        scopes = scopesFromTableRows(ordered.table, ordered.rows, ordered.alias, env, parent);
        skipOrder = true;
      } else scopes = scanFrom(stmt.from, env, parent);
    } else scopes = scanFrom(stmt.from, env, parent);
  } else {
    scopes = stmt.from ? scanFrom(stmt.from, env, parent) : [{ cells: [] }];
  }
  const canStopEarly =
    stmt.orderBy.length === 0 &&
    !stmt.distinct &&
    stmt.groupBy.length === 0 &&
    stmt.having === null &&
    Number.isFinite(env.maxRows);
  const aggregate =
    stmt.groupBy.length > 0 ||
    stmt.columns.some((column) => column.type === "expr" && containsAggregate(column.expr)) ||
    (stmt.having !== null && containsAggregate(stmt.having));
  if (stmt.where && !skipWhere) {
    if (canStopEarly && !aggregate) {
      const filtered: ScopeRow[] = [];
      for (const scope of scopes) {
        if (isTruthySql(evalExpr(stmt.where, env.createEvalContext(scope, parent))) !== true) continue;
        filtered.push(scope);
        if (filtered.length >= env.maxRows) break;
      }
      scopes = filtered;
    } else {
      scopes = scopes.filter(
        (scope) => isTruthySql(evalExpr(stmt.where!, env.createEvalContext(scope, parent))) === true,
      );
    }
  }
  const groupBy = stmt.groupBy.map((expr) => {
    if (expr.type === "literal" && typeof expr.value === "number" && Number.isInteger(expr.value)) {
      const column = stmt.columns[expr.value - 1];
      if (column?.type !== "expr") throw new SqliteError(`${expr.value}th GROUP BY term out of range`, "other");
      return column.expr;
    }
    if (expr.type === "column" && expr.table === null) {
      const column = stmt.columns.find(
        (candidate) => candidate.type === "expr" && candidate.alias?.toLowerCase() === expr.name.toLowerCase(),
      );
      if (column?.type === "expr") return column.expr;
    }
    return expr;
  });
  const groups = aggregate ? groupRows(scopes, groupBy, env, parent) : scopes.map((scope) => [scope]);
  const windowScopes = aggregate ? groups.map((group) => group[0] ?? { cells: [] }) : scopes;
  const sample = scopes[0] ?? (stmt.from ? { cells: shapeOf(stmt.from, env) } : undefined);
  if (scopes.length === 0 && sample) validateProjectedColumns(stmt, sample, env, parent);
  const columns = resultColumnNames(stmt.columns, sample);
  let output: OutputRow[] = [];

  for (const group of groups) {
    const scope = group[0] ?? { cells: [] };
    const ctx = env.createEvalContext(scope, parent);
    const values: SqlValue[] = [];
    for (const column of stmt.columns) {
      if (column.type === "star") {
        for (const cell of scope.cells) {
          if (
            (column.table !== null || !cell.hiddenByUsing) &&
            (column.table === null || cell.table?.toLowerCase() === column.table.toLowerCase())
          )
            values.push(cell.value);
        }
      } else {
        values.push(evalGrouped(column.expr, ctx, group, env, parent, stmt.windows, windowScopes));
      }
    }
    if (stmt.having) {
      const aliases = new Map<string, SqlValue>();
      stmt.columns.forEach((column, index) => {
        if (column.type === "expr" && column.alias) aliases.set(column.alias.toLowerCase(), values[index] ?? null);
      });
      const havingCtx: EvalContext = {
        ...ctx,
        resolveColumn: (table, name) => {
          if (table === null && aliases.has(name.toLowerCase())) return aliases.get(name.toLowerCase()) ?? null;
          return ctx.resolveColumn(table, name);
        },
      };
      if (isTruthySql(evalGrouped(stmt.having, havingCtx, group, env, parent, stmt.windows, windowScopes)) !== true)
        continue;
    }
    output.push({ values, scope });
    if (canStopEarly && !aggregate && !stmt.limit && output.length >= env.maxRows) break;
  }

  // SQLite emits grouped rows sorted by GROUP BY keys (ASC) even without ORDER BY.
  if (stmt.groupBy.length > 0 && stmt.orderBy.length === 0 && !skipOrder) {
    const groupOrder = groupBy.map((expr) => ({ expr, dir: "ASC" as const, nulls: null }));
    output.sort((left, right) => compareOutput(left, right, groupOrder, columns, env, parent, stmt.columns));
  }

  if (stmt.distinct) {
    const seen = new Set<string>();
    output = output.filter((row) => {
      const key = valueKey(row.values);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (stmt.orderBy.length > 0 && !skipOrder) {
    const groupOrder =
      stmt.groupBy.length > 0
        ? groupBy.map((expr) => ({ expr, dir: "ASC" as const, nulls: null as OrderByItem["nulls"] }))
        : [];
    output.sort((left, right) => {
      const primary = compareOutput(left, right, stmt.orderBy, columns, env, parent, stmt.columns);
      if (primary !== 0 || groupOrder.length === 0) return primary;
      return compareOutput(left, right, groupOrder, columns, env, parent, stmt.columns);
    });
  }
  if (stmt.limit) {
    const ctx = env.createEvalContext(null, parent);
    const limitValue = toInteger(evalExpr(stmt.limit.limit, ctx));
    const offsetValue = stmt.limit.offset ? toInteger(evalExpr(stmt.limit.offset, ctx)) : 0;
    if (limitValue === null || offsetValue === null) throw new SqliteError("datatype mismatch", "datatype_mismatch");
    const offset = Math.max(0, Number(offsetValue));
    const limit = Number(limitValue);
    output = output.slice(offset, limit < 0 ? undefined : offset + limit);
  }
  if (Number.isFinite(env.maxRows) && output.length > env.maxRows) output = output.slice(0, env.maxRows);
  return valuesToResult(
    columns,
    output.map((row) => row.values),
    0,
    env.state.lastInsertRowid,
    {
      named: env.includeNamedRows,
      keepValues: true,
    },
  );
}

export function scanFrom(item: FromItem, env: ExecutionEnv, parent?: EvalContext): ScopeRow[] {
  if (item.type === "join") {
    const left = scanFrom(item.left, env, parent);

    // Correlated table-valued functions (e.g. json_each(t.data)) are evaluated per left row.
    if (item.right.type === "table_func") {
      const result: ScopeRow[] = [];
      const rightShape = shapeOf(item.right, env);
      const nullRight = rightShape.map((cell) => ({ ...cell, value: null as SqlValue }));
      for (const lhs of left) {
        const tvf = evaluateTableFunction(item.right.name, item.right.args, item.right.alias, env, lhs, parent);
        if (tvf.rows.length === 0) {
          if (item.joinType === "LEFT" || item.joinType === "FULL") {
            result.push({ cells: [...lhs.cells, ...nullRight] });
          }
          continue;
        }
        for (const rhs of tvf.rows) {
          const joined = { cells: [...lhs.cells, ...rhs.cells] };
          if (item.on) {
            if (isTruthySql(evalExpr(item.on, env.createEvalContext(joined, parent))) !== true) continue;
          }
          result.push(joined);
        }
      }
      return result;
    }

    const probe =
      !item.using && item.joinType !== "RIGHT" && item.joinType !== "FULL"
        ? tryJoinProbe(item.right, item.on, env)
        : null;
    if (probe) {
      const rightShape = shapeOf(item.right, env);
      const nullRight = rightShape.map((cell) => ({ ...cell, value: null as SqlValue }));
      const result: ScopeRow[] = [];
      for (const lhs of left) {
        const raw = probe.lookup((tableName, name) => {
          const key = name.toLowerCase();
          const match = lhs.cells.find(
            (cell) =>
              (cell.nameLower ?? cell.name.toLowerCase()) === key &&
              (tableName === null || (cell.tableLower ?? cell.table?.toLowerCase()) === tableName.toLowerCase()),
          );
          return match?.value ?? null;
        });
        const rhsScopes = scopesFromTableRows(probe.table, raw, probe.alias, env, parent);
        let matched = false;
        for (const rhs of rhsScopes) {
          const joined = { cells: [...lhs.cells, ...rhs.cells] };
          if (
            item.on &&
            !probe.covering &&
            isTruthySql(evalExpr(item.on, env.createEvalContext(joined, parent))) !== true
          )
            continue;
          matched = true;
          result.push(joined);
        }
        if (!matched && (item.joinType === "LEFT" || item.joinType === "FULL")) {
          result.push({ cells: [...lhs.cells, ...nullRight] });
        }
      }
      return result;
    }

    // Hash-join fallback for unindexed equality INNER/LEFT joins (NULL keys never match).
    const hashKeys =
      !item.using && item.joinType !== "RIGHT" && item.joinType !== "FULL"
        ? tryJoinEqualityKeys(item.right, item.on, env)
        : null;
    if (hashKeys) {
      const rawRight = rawJoinTable(item.right, env);
      if (rawRight) {
        return hashJoinRaw(left, rawRight, hashKeys, item);
      }
      const right = scanFrom(item.right, env, parent);
      const rightShape = (right[0]?.cells ?? shapeOf(item.right, env)).map((cell) => cell);
      const nullRight = rightShape.map((cell) => ({ ...cell, value: null as SqlValue }));
      const buckets = new Map<string, ScopeRow[]>();
      for (const rhs of right) {
        const values = hashKeys.rightColumns.map((name) => {
          const key = name.toLowerCase();
          const cell = rhs.cells.find((c) => (c.nameLower ?? c.name.toLowerCase()) === key);
          return normalizeForCollation(cell?.value ?? null, "BINARY");
        });
        const mapKey = serializeIndexKey(values);
        if (mapKey === null) continue; // NULL join key → never matches via =
        const bucket = buckets.get(mapKey);
        if (bucket) bucket.push(rhs);
        else buckets.set(mapKey, [rhs]);
      }
      const result: ScopeRow[] = [];
      for (const lhs of left) {
        const values = hashKeys.leftKeys.map((key) => {
          const cell = lhs.cells.find(
            (c) =>
              (c.nameLower ?? c.name.toLowerCase()) === key.column.toLowerCase() &&
              (key.table === null || (c.tableLower ?? c.table?.toLowerCase()) === key.table.toLowerCase()),
          );
          return normalizeForCollation(cell?.value ?? null, "BINARY");
        });
        const mapKey = serializeIndexKey(values);
        let matched = false;
        if (mapKey !== null) {
          const matches = buckets.get(mapKey);
          if (matches) {
            for (const rhs of matches) {
              const joined = { cells: [...lhs.cells, ...rhs.cells] };
              matched = true;
              result.push(joined);
            }
          }
        }
        if (!matched && (item.joinType === "LEFT" || item.joinType === "FULL")) {
          result.push({ cells: [...lhs.cells, ...nullRight] });
        }
      }
      return result;
    }

    const right = scanFrom(item.right, env, parent);
    const using = resolveUsingColumns(item, left, right, env);
    const leftShape = left[0]?.cells ?? shapeOf(item.left, env);
    const rightShape = (right[0]?.cells ?? shapeOf(item.right, env)).map((cell) =>
      using?.some((name) => name.toLowerCase() === cell.name.toLowerCase()) ? { ...cell, hiddenByUsing: true } : cell,
    );
    const nullLeft = leftShape.map((cell) => ({ ...cell, value: null as SqlValue }));
    const nullRight = rightShape.map((cell) => ({ ...cell, value: null as SqlValue }));
    const result: ScopeRow[] = [];
    const matchedRight = new Set<number>();

    const joinOk = (lhs: ScopeRow, rhs: ScopeRow, joined: ScopeRow): boolean => {
      if (using) {
        return using.every((name) => {
          const l = lhs.cells.find((cell) => cell.name.toLowerCase() === name.toLowerCase())?.value ?? null;
          const r = rhs.cells.find((cell) => cell.name.toLowerCase() === name.toLowerCase())?.value ?? null;
          return l !== null && r !== null && sqlValueEquals(l, r);
        });
      }
      if (item.on) return isTruthySql(evalExpr(item.on, env.createEvalContext(joined, parent))) === true;
      return true;
    };

    for (const lhs of left) {
      let matched = false;
      right.forEach((rhs, rightIndex) => {
        const rightCells = using
          ? rhs.cells.map((cell) =>
              using.some((name) => name.toLowerCase() === cell.name.toLowerCase())
                ? { ...cell, hiddenByUsing: true }
                : cell,
            )
          : rhs.cells;
        const joined = { cells: [...lhs.cells, ...rightCells] };
        if (!joinOk(lhs, rhs, joined)) return;
        matched = true;
        matchedRight.add(rightIndex);
        result.push(joined);
      });
      if (!matched && (item.joinType === "LEFT" || item.joinType === "FULL")) {
        result.push({ cells: [...lhs.cells, ...nullRight] });
      }
    }

    if (item.joinType === "RIGHT" || item.joinType === "FULL") {
      right.forEach((rhs, rightIndex) => {
        if (matchedRight.has(rightIndex)) return;
        if (using) {
          // USING/NATURAL: unmatched right rows expose right values for shared columns.
          const leftCells = nullLeft.map((cell) => {
            const shared = using.some((name) => name.toLowerCase() === cell.name.toLowerCase());
            if (!shared) return cell;
            const fromRight = rhs.cells.find((c) => c.name.toLowerCase() === cell.name.toLowerCase());
            return { ...cell, value: fromRight?.value ?? null, hiddenByUsing: false };
          });
          const rightOnly = rhs.cells.filter(
            (cell) => !using.some((name) => name.toLowerCase() === cell.name.toLowerCase()),
          );
          result.push({ cells: [...leftCells, ...rightOnly] });
        } else {
          result.push({ cells: [...nullLeft, ...rhs.cells] });
        }
      });
    }

    return result;
  }
  if (item.type === "subquery") {
    const result = executeSelect(item.select, env, parent);
    return resultValues(result).map((values) => ({
      cells: result.columns.map((name, index) => ({ table: item.alias, name, value: values[index] ?? null })),
    }));
  }
  if (item.type === "table_func") {
    return evaluateTableFunction(item.name, item.args, item.alias, env).rows;
  }

  // Eponymous pragma_* virtual tables may be referenced without parentheses.
  if (item.type === "table" && isPragmaTvfName(item.name) && hasTableValuedFunction(item.name.toLowerCase())) {
    return evaluateTableFunction(item.name, [], item.alias, env, null, parent).rows;
  }

  const alias = item.alias ?? item.name;
  const qualified = item.schema ? `${item.schema}.${item.name}` : item.name;
  const db = env.state.databaseForSchema(item.schema, qualified);
  const cte = env.ctes.get(item.name.toLowerCase());
  if (cte) {
    return resultValues(cte).map((values) => ({
      cells: cte.columns.map((name, index) => ({ table: alias, name, value: values[index] ?? null })),
    }));
  }
  const view = db.views.get(item.name.toLowerCase());
  if (view) {
    const result = executeSelect(view.select, env, parent);
    const names = view.columns ?? result.columns;
    return resultValues(result).map((values) => ({
      cells: names.map((name, index) => ({ table: alias, name, value: values[index] ?? null })),
    }));
  }
  const virtual = db.virtualTables.get(item.name.toLowerCase());
  if (virtual) {
    if (virtual.kind === "fts5" || virtual.kind === "fts3" || virtual.kind === "fts4") {
      return virtual.scan().map((row) => ({
        rowid: row.rowid,
        rowidName: "rowid",
        sourceTable: virtual.name,
        cells: virtual.columns.map((column) => ({
          table: alias,
          name: column,
          value: row.values.get(column.toLowerCase()) ?? null,
        })),
      }));
    }
    if (virtual.kind === "rtree") {
      return virtual.scan().map((row) => ({
        rowid: row.rowid,
        rowidName: "rowid",
        sourceTable: virtual.name,
        cells: virtual.columns.map((column) => ({
          table: alias,
          name: column,
          value: row.values.get(column.toLowerCase()) ?? null,
        })),
      }));
    }
    if (virtual.kind === "dbstat") {
      return scanDbStat(db, alias, virtual.schemaArg);
    }
    if (virtual.kind === "fts5vocab") {
      return scanFtsVocab(db, alias, virtual);
    }
    // bytecode / tables_used: empty by default
    return [];
  }
  let table: Table;
  if (item.name.toLowerCase() === "sqlite_schema") table = buildSqliteSchema(db);
  else if (item.name.toLowerCase() === "sqlite_master") table = buildSqliteMaster(db);
  else table = db.getTable(item.name);
  return scopesFromTableRows(table, table.scan(), alias, env, parent);
}

function rawJoinTable(item: FromItem, env: ExecutionEnv): { table: Table; alias: string } | null {
  if (item.type !== "table") return null;
  const nameKey = item.name.toLowerCase();
  if (nameKey === "sqlite_schema" || nameKey === "sqlite_master") return null;
  if (env.ctes.has(nameKey)) return null;
  const db = env.state.databaseForSchema(item.schema, item.schema ? `${item.schema}.${item.name}` : item.name);
  if (db.virtualTables.has(nameKey) || db.views.has(nameKey)) return null;
  try {
    return { table: db.getTable(item.name), alias: item.alias ?? item.name };
  } catch {
    return null;
  }
}

function hashJoinRaw(
  left: ScopeRow[],
  right: { table: Table; alias: string },
  hashKeys: { rightColumns: string[]; leftKeys: { table: string | null; column: string }[] },
  item: Extract<FromItem, { type: "join" }>,
): ScopeRow[] {
  const rightKeys = hashKeys.rightColumns.map((name) => name.toLowerCase());
  const buckets = new Map<string, Row[]>();
  const source = right.table.withoutRowid ? right.table.clusteredRows.values() : right.table.rows.values();
  for (const row of source) {
    const values = rightKeys.map((key) => normalizeForCollation(right.table.cell(row, key), "BINARY"));
    const mapKey = serializeIndexKey(values);
    if (mapKey === null) continue;
    const bucket = buckets.get(mapKey);
    if (bucket) bucket.push(row);
    else buckets.set(mapKey, [row]);
  }
  const nullRight = right.table.columns.map((column) =>
    makeCell(right.alias, column.name, null, { affinity: column.affinity, collate: column.collate }),
  );
  const result: ScopeRow[] = [];
  for (const lhs of left) {
    const values = hashKeys.leftKeys.map((key) => {
      const want = key.column.toLowerCase();
      const tableKey = key.table?.toLowerCase();
      const cell = lhs.cells.find(
        (c) =>
          (c.nameLower ?? c.name.toLowerCase()) === want &&
          (tableKey === undefined || (c.tableLower ?? c.table?.toLowerCase()) === tableKey),
      );
      return normalizeForCollation(cell?.value ?? null, "BINARY");
    });
    const mapKey = serializeIndexKey(values);
    let matched = false;
    if (mapKey !== null) {
      const matches = buckets.get(mapKey);
      if (matches) {
        for (const row of matches) {
          const rhsCells = right.table.columns.map((column) =>
            makeCell(right.alias, column.name, right.table.cell(row, column.nameLower ?? column.name.toLowerCase()), {
              affinity: column.affinity,
              collate: column.collate,
            }),
          );
          result.push({ cells: [...lhs.cells, ...rhsCells] });
          matched = true;
        }
      }
    }
    if (!matched && (item.joinType === "LEFT" || item.joinType === "FULL")) {
      result.push({ cells: [...lhs.cells, ...nullRight] });
    }
  }
  return result;
}

function scopesFromTableRows(
  table: Table,
  rows: Iterable<Row>,
  alias: string,
  env: ExecutionEnv,
  parent?: EvalContext,
): ScopeRow[] {
  const integerPkAlias = table.integerPkColumn()?.name;
  const result: ScopeRow[] = [];
  for (const row of rows) {
    const baseCells = table.columns
      .filter((c) => !c.generated || c.generated.stored)
      .map((column) =>
        makeCell(alias, column.name, table.cell(row, column.nameLower ?? column.name.toLowerCase()), {
          affinity: column.affinity,
          collate: column.collate,
        }),
      );
    const cells = table.columns.map((column) => {
      if (column.generated && !column.generated.stored) {
        const ctx = env.createEvalContext({ cells: baseCells, sourceTable: table.name }, parent);
        return makeCell(alias, column.name, applyAffinityLocal(evalExpr(column.generated.expr, ctx), column.affinity), {
          affinity: column.affinity,
          collate: column.collate,
        });
      }
      return makeCell(alias, column.name, table.cell(row, column.nameLower ?? column.name.toLowerCase()), {
        affinity: column.affinity,
        collate: column.collate,
      });
    });
    result.push({
      ...(table.withoutRowid ? {} : { rowid: row.rowid }),
      rowidName: integerPkAlias ?? (table.withoutRowid ? undefined : "rowid"),
      sourceTable: table.name,
      cells,
    });
  }
  return result;
}

function shapeOf(item: FromItem, env: ExecutionEnv): ScopeRow["cells"] {
  if (item.type === "join") {
    const left = shapeOf(item.left, env);
    const right = shapeOf(item.right, env);
    const using = resolveUsingFromShapes(item.using, left, right);
    return [
      ...left,
      ...right.map((cell) =>
        using?.some((name) => name.toLowerCase() === cell.name.toLowerCase()) ? { ...cell, hiddenByUsing: true } : cell,
      ),
    ];
  }
  if (item.type === "subquery")
    return resultColumnNames(item.select.columns).map((name) => ({ table: item.alias, name, value: null }));
  if (item.type === "table_func") {
    // Do not evaluate args here — they may be correlated (e.g. pragma_table_info(tl.name)).
    const known = tableValuedColumns(item.name);
    const columns = known ?? evaluateTableFunction(item.name, item.args, item.alias, env).columns;
    return columns.map((name) => ({
      table: item.alias ?? item.name,
      name,
      value: null,
    }));
  }
  if (item.type === "table" && isPragmaTvfName(item.name) && hasTableValuedFunction(item.name.toLowerCase())) {
    const columns = tableValuedColumns(item.name) ?? evaluateTableFunction(item.name, [], item.alias, env).columns;
    return columns.map((name) => ({
      table: item.alias ?? item.name,
      name,
      value: null,
    }));
  }
  const alias = item.alias ?? item.name;
  const qualified = item.schema ? `${item.schema}.${item.name}` : item.name;
  const db = env.state.databaseForSchema(item.schema, qualified);
  const cte = env.ctes.get(item.name.toLowerCase());
  if (cte) return cte.columns.map((name) => ({ table: alias, name, value: null }));
  const view = db.views.get(item.name.toLowerCase());
  if (view)
    return (view.columns ?? resultColumnNames(view.select.columns)).map((name) => ({
      table: alias,
      name,
      value: null,
    }));
  const virtual = db.virtualTables.get(item.name.toLowerCase());
  if (virtual) return virtual.columns.map((name) => ({ table: alias, name, value: null }));
  const table =
    item.name.toLowerCase() === "sqlite_schema"
      ? buildSqliteSchema(db)
      : item.name.toLowerCase() === "sqlite_master"
        ? buildSqliteMaster(db)
        : db.getTable(item.name);
  return table.columns.map((column) => ({ table: alias, name: column.name, value: null, affinity: column.affinity }));
}

/** NATURAL JOIN uses an empty USING list as a sentinel; resolve shared column names at runtime. */
function resolveUsingColumns(
  item: Extract<FromItem, { type: "join" }>,
  left: ScopeRow[],
  right: ScopeRow[],
  env: ExecutionEnv,
): string[] | null {
  const leftCells = left[0]?.cells ?? shapeOf(item.left, env);
  const rightCells = right[0]?.cells ?? shapeOf(item.right, env);
  return resolveUsingFromShapes(item.using, leftCells, rightCells);
}

function resolveUsingFromShapes(
  using: string[] | null,
  leftCells: ScopeRow["cells"],
  rightCells: ScopeRow["cells"],
): string[] | null {
  if (using === null) return null;
  if (using.length > 0) return using;
  const rightNames = new Set(rightCells.map((cell) => cell.name.toLowerCase()));
  const common: string[] = [];
  const seen = new Set<string>();
  for (const cell of leftCells) {
    const key = cell.name.toLowerCase();
    if (rightNames.has(key) && !seen.has(key)) {
      seen.add(key);
      common.push(cell.name);
    }
  }
  return common;
}

function groupRows(rows: ScopeRow[], expressions: Expr[], env: ExecutionEnv, parent?: EvalContext): ScopeRow[][] {
  if (expressions.length === 0) return [rows];
  const groups: ScopeRow[][] = [];
  const indexByKey = new Map<string, number>();
  for (const row of rows) {
    const keyValues = expressions.map((expr) => {
      const value = evalExpr(expr, env.createEvalContext(row, parent));
      return expr.type === "collate" ? normalizeForCollation(value, expr.collation) : value;
    });
    const key = valueKey(keyValues);
    const index = indexByKey.get(key);
    if (index === undefined) {
      indexByKey.set(key, groups.length);
      groups.push([row]);
    } else groups[index]!.push(row);
  }
  return groups;
}

function evalGrouped(
  expr: Expr,
  ctx: EvalContext,
  group: ScopeRow[],
  env: ExecutionEnv,
  parent: EvalContext | undefined,
  namedWindows: SelectStmt["windows"],
  windowRows: ScopeRow[],
): SqlValue {
  return evalExpr(
    replaceSpecial(expr, (special) => {
      if (special.type === "aggregate") return aggregateValue(special, group, env, parent);
      return windowValue(special, group[0] ?? { cells: [] }, windowRows, env, parent, namedWindows);
    }),
    ctx,
  );
}

function aggregateValue(expr: AggregateExpr, rows: ScopeRow[], env: ExecutionEnv, parent?: EvalContext): SqlValue {
  const accumulator = env.functions.createAggregate(expr.name);
  if (!accumulator) throw new SqliteError(`no such aggregate function: ${expr.name}`, "other");
  const seen: SqlValue[][] = [];
  const orderedRows =
    expr.orderBy.length > 0 ? [...rows].sort((a, b) => compareScopes(a, b, expr.orderBy, env, parent)) : rows;
  for (const row of orderedRows) {
    const ctx = env.createEvalContext(row, parent);
    if (expr.filter && isTruthySql(evalExpr(expr.filter, ctx)) !== true) continue;
    const args = expr.args === "*" ? [] : expr.args.map((arg) => evalExpr(arg, ctx));
    if (expr.distinct && seen.some((values) => rowsEqual(values, args))) continue;
    seen.push(args);
    accumulator.step(args);
  }
  return accumulator.finalize();
}

function windowValue(
  expr: WindowExpr,
  current: ScopeRow,
  rows: ScopeRow[],
  env: ExecutionEnv,
  parent: EvalContext | undefined,
  namedWindows: SelectStmt["windows"],
): SqlValue {
  const spec = resolveWindow(expr.window, namedWindows);
  const currentCtx = env.createEvalContext(current, parent);
  const partitionKey = spec.partitionBy.map((item) => evalExpr(item, currentCtx));
  const partition = rows.filter((row) =>
    rowsEqual(
      partitionKey,
      spec.partitionBy.map((item) => evalExpr(item, env.createEvalContext(row, parent))),
    ),
  );
  partition.sort((a, b) => compareScopes(a, b, spec.orderBy, env, parent));
  const index = Math.max(0, partition.indexOf(current));
  const orderKeys = partition.map((row) =>
    spec.orderBy.map((item) => evalExpr(item.expr, env.createEvalContext(row, parent))),
  );
  let defaultFrameEnd = index;
  if (spec.orderBy.length > 0) {
    while (defaultFrameEnd + 1 < partition.length) {
      const next = partition[defaultFrameEnd + 1];
      if (!next || compareScopes(current, next, spec.orderBy, env, parent) !== 0) break;
      defaultFrameEnd++;
    }
  }
  if (expr.func.type === "aggregate") {
    const [start, end] = frameBounds(spec, index, partition.length, currentCtx, defaultFrameEnd, orderKeys);
    const framed = frameRows(partition, start, end, index, orderKeys, spec.frame?.exclude ?? null);
    return aggregateValue(expr.func, framed, env, parent);
  }
  const name = expr.func.name.toLowerCase();
  const args = expr.func.args === "*" ? [] : expr.func.args;
  const values = partition.map((row) => args.map((arg) => evalExpr(arg, env.createEvalContext(row, parent))));
  if (name === "row_number") return index + 1;
  if (name === "rank") {
    let first = index;
    while (first > 0 && rowsEqual(orderKeys[first]!, orderKeys[first - 1]!)) first--;
    return first + 1;
  }
  if (name === "dense_rank") {
    let rank = 1;
    for (let i = 1; i <= index; i++) if (!rowsEqual(orderKeys[i]!, orderKeys[i - 1]!)) rank++;
    return rank;
  }
  const evaluated = args.map((arg) => evalExpr(arg, currentCtx));
  if (name === "lag" || name === "lead") {
    const offset = Number(toInteger(evaluated[1] ?? 1) ?? 1);
    const target = name === "lag" ? index - offset : index + offset;
    return values[target]?.[0] ?? evaluated[2] ?? null;
  }
  const [start, end] = frameBounds(spec, index, partition.length, currentCtx, defaultFrameEnd, orderKeys);
  const framed = frameRows(partition, start, end, index, orderKeys, spec.frame?.exclude ?? null);
  const framedValues = framed.map((row) => args.map((arg) => evalExpr(arg, env.createEvalContext(row, parent))));
  if (name === "first_value") return framedValues[0]?.[0] ?? null;
  if (name === "last_value") return framedValues[framedValues.length - 1]?.[0] ?? null;
  if (name === "nth_value") {
    const target = Number(toInteger(evaluated[1] ?? null) ?? 0) - 1;
    return target >= 0 && target < framedValues.length ? (framedValues[target]?.[0] ?? null) : null;
  }
  if (name === "ntile") {
    const buckets = Math.max(1, Number(toInteger(evaluated[0] ?? 1) ?? 1));
    const n = partition.length;
    const small = Math.floor(n / buckets);
    const large = small + 1;
    const largeCount = n % buckets;
    // First `largeCount` buckets have `large` rows
    let remaining = index;
    for (let b = 1; b <= buckets; b++) {
      const size = b <= largeCount ? large : small;
      if (remaining < size) return b;
      remaining -= size;
    }
    return buckets;
  }
  if (name === "cume_dist") {
    if (partition.length === 0) return null;
    let lastPeer = index;
    while (lastPeer + 1 < partition.length && rowsEqual(orderKeys[lastPeer + 1]!, orderKeys[index]!)) {
      lastPeer++;
    }
    return (lastPeer + 1) / partition.length;
  }
  if (name === "percent_rank") {
    if (partition.length <= 1) return 0;
    let first = index;
    while (first > 0 && rowsEqual(orderKeys[first]!, orderKeys[first - 1]!)) first--;
    return first / (partition.length - 1);
  }
  throw new SqliteError(`no such window function: ${expr.func.name}`, "other");
}

function resolveWindow(spec: WindowSpec, namedWindows: SelectStmt["windows"], seen = new Set<string>()): WindowSpec {
  if (!spec.ref) return spec;
  const key = spec.ref.toLowerCase();
  if (seen.has(key)) throw new SqliteError(`circular window definition: ${spec.ref}`, "other");
  const named = namedWindows.find((item) => item.name.toLowerCase() === key);
  if (!named) throw new SqliteError(`no such window: ${spec.ref}`, "other");
  seen.add(key);
  const base = resolveWindow(named.spec, namedWindows, seen);
  return {
    partitionBy: spec.partitionBy.length ? spec.partitionBy : base.partitionBy,
    orderBy: spec.orderBy.length ? spec.orderBy : base.orderBy,
    frame: spec.frame ?? base.frame,
    ref: null,
  };
}

function frameBounds(
  spec: WindowSpec,
  index: number,
  length: number,
  ctx: EvalContext,
  defaultFrameEnd: number,
  orderKeys: SqlValue[][],
): [number, number] {
  if (!spec.frame) return [0, spec.orderBy.length > 0 ? defaultFrameEnd : Math.max(0, length - 1)];
  const isRangeLike = spec.frame.type === "RANGE" || spec.frame.type === "GROUPS";
  let peerFirst = index;
  let peerLast = index;
  if (isRangeLike && spec.orderBy.length > 0) {
    while (peerFirst > 0 && rowsEqual(orderKeys[peerFirst]!, orderKeys[peerFirst - 1]!)) peerFirst--;
    while (peerLast + 1 < length && rowsEqual(orderKeys[peerLast]!, orderKeys[peerLast + 1]!)) peerLast++;
  }
  const bound = (
    item: WindowSpec["frame"] extends infer _ ? NonNullable<WindowSpec["frame"]>["start"] : never,
    isStart: boolean,
  ): number => {
    switch (item.kind) {
      case "unbounded_preceding":
        return 0;
      case "unbounded_following":
        return Math.max(0, length - 1);
      case "current_row":
        if (isRangeLike) return isStart ? peerFirst : peerLast;
        return index;
      case "preceding":
      case "following": {
        const offset = Number(evalExpr(item.expr, ctx));
        if (spec.frame?.type === "GROUPS") {
          const groups: Array<{ first: number; last: number }> = [];
          for (let i = 0; i < length; ) {
            let last = i;
            while (last + 1 < length && rowsEqual(orderKeys[last]!, orderKeys[last + 1]!)) last++;
            groups.push({ first: i, last });
            i = last + 1;
          }
          const currentGroup = groups.findIndex((group) => index >= group.first && index <= group.last);
          const delta = item.kind === "preceding" ? -offset : offset;
          const target = groups[Math.max(0, Math.min(groups.length - 1, currentGroup + delta))]!;
          return isStart ? target.first : target.last;
        }
        if (spec.frame?.type === "RANGE" && spec.orderBy.length === 1) {
          const rawCurrent = orderKeys[index]?.[0];
          const current =
            typeof rawCurrent === "number"
              ? rawCurrent
              : typeof rawCurrent === "bigint"
                ? Number(rawCurrent)
                : rawCurrent && typeof rawCurrent === "object" && "value" in rawCurrent
                  ? Number(rawCurrent.value)
                  : Number.NaN;
          if (!Number.isFinite(current) || !Number.isFinite(offset)) return isStart ? peerFirst : peerLast;
          const descending = spec.orderBy[0]?.dir === "DESC";
          const signed = item.kind === "preceding" ? -offset : offset;
          const target = current + (descending ? -signed : signed);
          const numericKey = (position: number): number => {
            const value = orderKeys[position]?.[0];
            if (typeof value === "number") return value;
            if (typeof value === "bigint") return Number(value);
            if (value && typeof value === "object" && "value" in value) return Number(value.value);
            return Number.NaN;
          };
          if (isStart) {
            for (let i = 0; i < length; i++) {
              const value = numericKey(i);
              if ((descending && value <= target) || (!descending && value >= target)) return i;
            }
            return length;
          }
          for (let i = length - 1; i >= 0; i--) {
            const value = numericKey(i);
            if ((descending && value >= target) || (!descending && value <= target)) return i;
          }
          return -1;
        }
        const rowOffset = Number(toInteger(evalExpr(item.expr, ctx)) ?? 0);
        return item.kind === "preceding"
          ? Math.max(0, index - rowOffset)
          : Math.min(Math.max(0, length - 1), index + rowOffset);
      }
    }
  };
  return [bound(spec.frame.start, true), bound(spec.frame.end, false)];
}

function frameRows(
  partition: ScopeRow[],
  start: number,
  end: number,
  index: number,
  orderKeys: SqlValue[][],
  exclude: "no_others" | "current_row" | "group" | "ties" | null,
): ScopeRow[] {
  let peerFirst = index;
  let peerLast = index;
  while (peerFirst > 0 && rowsEqual(orderKeys[peerFirst]!, orderKeys[peerFirst - 1]!)) peerFirst--;
  while (peerLast + 1 < partition.length && rowsEqual(orderKeys[peerLast]!, orderKeys[peerLast + 1]!)) peerLast++;
  const rows: ScopeRow[] = [];
  for (let i = Math.max(0, start); i <= end && i < partition.length; i++) {
    if (exclude === "current_row" && i === index) continue;
    if (exclude === "group" && i >= peerFirst && i <= peerLast) continue;
    if (exclude === "ties" && i >= peerFirst && i <= peerLast && i !== index) continue;
    rows.push(partition[i]!);
  }
  return rows;
}

function compareScopes(
  a: ScopeRow,
  b: ScopeRow,
  order: OrderByItem[],
  env: ExecutionEnv,
  parent?: EvalContext,
): number {
  for (const item of order) {
    const left = evalExpr(item.expr, env.createEvalContext(a, parent));
    const right = evalExpr(item.expr, env.createEvalContext(b, parent));
    const result = compareNullable(left, right, item, a);
    if (result !== 0) return result;
  }
  return 0;
}

function compareOutput(
  a: OutputRow,
  b: OutputRow,
  order: OrderByItem[],
  columns: string[],
  env: ExecutionEnv,
  parent?: EvalContext,
  resultColumns?: ResultColumn[],
): number {
  for (const item of order) {
    const value = (row: OutputRow): SqlValue => {
      if (item.expr.type === "literal" && typeof item.expr.value === "number" && Number.isInteger(item.expr.value)) {
        return row.values[item.expr.value - 1] ?? null;
      }
      if (item.expr.type === "column" && item.expr.table === null) {
        const requestedName = item.expr.name.toLowerCase();
        const index = columns.findIndex((name) => name.toLowerCase() === requestedName);
        if (index >= 0) return row.values[index] ?? null;
      }
      return evalExpr(item.expr, env.createEvalContext(row.scope, parent));
    };
    const result = compareNullable(value(a), value(b), item, a.scope, columns, resultColumns);
    if (result !== 0) return result;
  }
  return 0;
}

function collationForOrderItem(
  item: OrderByItem,
  resultColumns: ResultColumn[],
  columnNames: string[],
  scope?: ScopeRow,
): string | null {
  if (item.expr.type === "collate") return item.expr.collation;
  if (item.expr.type === "literal" && typeof item.expr.value === "number" && Number.isInteger(item.expr.value)) {
    const column = resultColumns[item.expr.value - 1];
    if (column?.type === "expr") return explicitCollation(column.expr);
  }
  if (item.expr.type === "column" && item.expr.table === null) {
    const key = item.expr.name.toLowerCase();
    const byAlias = resultColumns.find((column) => column.type === "expr" && column.alias?.toLowerCase() === key);
    if (byAlias?.type === "expr") return explicitCollation(byAlias.expr);
    const index = columnNames.findIndex((name) => name.toLowerCase() === key);
    if (index >= 0) {
      const column = resultColumns[index];
      if (column?.type === "expr") return explicitCollation(column.expr);
    }
  }
  if (scope && item.expr.type === "column") {
    const key = item.expr.name.toLowerCase();
    const match = scope.cells.find(
      (cell) =>
        cell.name.toLowerCase() === key &&
        item.expr.type === "column" &&
        (item.expr.table === null || cell.table?.toLowerCase() === item.expr.table.toLowerCase()),
    );
    if (match?.collate) return match.collate;
  }
  return null;
}

function compareNullable(
  left: SqlValue,
  right: SqlValue,
  item: OrderByItem,
  scope?: ScopeRow,
  columnNames?: string[],
  resultColumns?: ResultColumn[],
): number {
  if (left === null || right === null) {
    if (left === right) return 0;
    const nullFirst = item.nulls ? item.nulls === "FIRST" : item.dir === "ASC";
    return (left === null ? -1 : 1) * (nullFirst ? 1 : -1);
  }
  const collation =
    resultColumns && columnNames
      ? collationForOrderItem(item, resultColumns, columnNames, scope)
      : scope && item.expr.type === "column"
        ? (() => {
            const key = item.expr.name.toLowerCase();
            const match = scope.cells.find(
              (cell) =>
                cell.name.toLowerCase() === key &&
                item.expr.type === "column" &&
                (item.expr.table === null || cell.table?.toLowerCase() === item.expr.table.toLowerCase()),
            );
            return match?.collate ?? null;
          })()
        : item.expr.type === "collate"
          ? item.expr.collation
          : null;
  const comparison = collation ? compareWithCollation(left, right, collation) : compareSql(left, right);
  return (comparison ?? 0) * (item.dir === "DESC" ? -1 : 1);
}

function resultColumnNames(columns: ResultColumn[], sample?: ScopeRow): string[] {
  const names: string[] = [];
  for (const column of columns) {
    if (column.type === "star") {
      for (const cell of sample?.cells ?? []) {
        if (
          (column.table !== null || !cell.hiddenByUsing) &&
          (column.table === null || cell.table?.toLowerCase() === column.table.toLowerCase())
        )
          names.push(cell.name);
      }
    } else if (
      !column.alias &&
      column.expr.type === "column" &&
      ["rowid", "_rowid_", "oid"].includes(column.expr.name.toLowerCase()) &&
      sample?.rowidName
    ) {
      names.push(sample.rowidName);
    } else names.push(column.alias ?? expressionName(column.expr));
  }
  return names;
}

function compareCompoundRows(left: SqlValue[], right: SqlValue[], order: OrderByItem[], columns: string[]): number {
  for (const item of order) {
    let index = -1;
    if (item.expr.type === "literal" && typeof item.expr.value === "number" && Number.isInteger(item.expr.value)) {
      index = item.expr.value - 1;
    } else if (item.expr.type === "column" && item.expr.table === null) {
      const requested = item.expr.name.toLowerCase();
      index = columns.findIndex((name) => name.toLowerCase() === requested);
    }
    if (index < 0) throw new SqliteError("ORDER BY term does not match any column in the result set", "other");
    const result = compareNullable(left[index] ?? null, right[index] ?? null, item);
    if (result !== 0) return result;
  }
  return 0;
}

function validateProjectedColumns(stmt: SelectStmt, sample: ScopeRow, env: ExecutionEnv, parent?: EvalContext): void {
  const ctx = env.createEvalContext({ ...sample, rowid: 1, rowidName: sample.rowidName }, parent);
  const visit = (expr: Expr): void => {
    if (expr.type === "column") {
      if (expr.name !== "*") ctx.resolveColumn(expr.table, expr.name);
      return;
    }
    const recurse = (item: Expr) => visit(item);
    switch (expr.type) {
      case "unary":
        recurse(expr.expr);
        break;
      case "is_bool":
        recurse(expr.expr);
        break;
      case "binary":
        recurse(expr.left);
        recurse(expr.right);
        break;
      case "between":
        recurse(expr.expr);
        recurse(expr.lower);
        recurse(expr.upper);
        break;
      case "in":
        recurse(expr.expr);
        if (Array.isArray(expr.values)) expr.values.forEach(recurse);
        break;
      case "like":
        recurse(expr.expr);
        recurse(expr.pattern);
        if (expr.escape) recurse(expr.escape);
        break;
      case "function":
      case "aggregate":
        if (expr.args !== "*") expr.args.forEach(recurse);
        if (expr.filter) recurse(expr.filter);
        break;
      case "window":
        if (expr.func.args !== "*") expr.func.args.forEach(recurse);
        break;
      case "case":
        if (expr.base) recurse(expr.base);
        expr.whens.forEach((branch) => {
          recurse(branch.when);
          recurse(branch.then);
        });
        if (expr.else) recurse(expr.else);
        break;
      case "cast":
      case "collate":
        recurse(expr.expr);
        break;
      case "row":
        expr.values.forEach(recurse);
        break;
    }
  };
  for (const column of stmt.columns) if (column.type === "expr") visit(column.expr);
}

function expressionName(expr: Expr): string {
  if (expr.type === "column") return expr.name;
  if (expr.type === "literal") {
    if (expr.value === null) return "NULL";
    if (expr.value instanceof Uint8Array)
      return `X'${Array.from(expr.value)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase()}'`;
    return typeof expr.value === "string" ? `'${expr.value.replaceAll("'", "''")}'` : String(expr.value);
  }
  if (expr.type === "null") return "NULL";
  if (expr.type === "function" || expr.type === "aggregate") {
    if (expr.args === "*") return `${expr.name.toLowerCase()}(*)`;
    const args = expr.args.map((arg) => expressionName(arg)).join(", ");
    return `${expr.name.toLowerCase()}(${args})`;
  }
  if (expr.type === "binary") {
    return `${expressionName(expr.left)} ${expr.op} ${expressionName(expr.right)}`;
  }
  if (expr.type === "is_bool") {
    const sense = expr.sense ? "TRUE" : "FALSE";
    return `${expressionName(expr.expr)} IS${expr.not ? " NOT" : ""} ${sense}`;
  }
  return expr.type;
}

function replaceSpecial(expr: Expr, evaluate: (expr: AggregateExpr | WindowExpr) => SqlValue): Expr {
  if (expr.type === "aggregate" || expr.type === "window") return { type: "literal", value: evaluate(expr) };
  const recurse = (item: Expr) => replaceSpecial(item, evaluate);
  switch (expr.type) {
    case "unary":
      return { ...expr, expr: recurse(expr.expr) };
    case "is_bool":
      return { ...expr, expr: recurse(expr.expr) };
    case "binary":
      return { ...expr, left: recurse(expr.left), right: recurse(expr.right) };
    case "between":
      return { ...expr, expr: recurse(expr.expr), lower: recurse(expr.lower), upper: recurse(expr.upper) };
    case "in":
      return {
        ...expr,
        expr: recurse(expr.expr),
        values: Array.isArray(expr.values) ? expr.values.map(recurse) : expr.values,
      };
    case "like":
      return {
        ...expr,
        expr: recurse(expr.expr),
        pattern: recurse(expr.pattern),
        escape: expr.escape && recurse(expr.escape),
      };
    case "function":
      return {
        ...expr,
        args: expr.args === "*" ? "*" : expr.args.map(recurse),
        filter: expr.filter && recurse(expr.filter),
      };
    case "case":
      return {
        ...expr,
        base: expr.base && recurse(expr.base),
        whens: expr.whens.map(({ when, then: thenExpr }) => {
          // biome-ignore lint/suspicious/noThenProperty: CASE WHEN/THEN AST field, not a thenable
          return { when: recurse(when), then: recurse(thenExpr) };
        }),
        else: expr.else && recurse(expr.else),
      };
    case "cast":
      return { ...expr, expr: recurse(expr.expr) };
    case "row":
      return { ...expr, values: expr.values.map(recurse) };
    case "collate":
      return { ...expr, expr: recurse(expr.expr) };
    default:
      return expr;
  }
}

function containsAggregate(expr: Expr): boolean {
  let found = false;
  replaceSpecial(expr, (special) => {
    if (special.type === "aggregate") found = true;
    return null;
  });
  return found;
}

function referencesTable(select: SelectStmt, name: string): boolean {
  const target = name.toLowerCase();
  const visit = (item: FromItem | null): boolean => {
    if (!item) return false;
    if (item.type === "table") return item.name.toLowerCase() === target;
    if (item.type === "join") return visit(item.left) || visit(item.right);
    return item.type === "subquery" ? referencesTable(item.select, name) : false;
  };
  return visit(select.from) || (select.compound ? referencesTable(select.compound.select, name) : false);
}

function rowsEqual(left: SqlValue[], right: SqlValue[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => {
      const other = right[index] ?? null;
      return (value === null && other === null) || (value !== null && other !== null && sqlValueEquals(value, other));
    })
  );
}

function uniqueRows(rows: SqlValue[][]): SqlValue[][] {
  const seen = new Set<string>();
  const result: SqlValue[][] = [];
  for (const row of rows) {
    const key = valueKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

function valueKey(values: SqlValue[]): string {
  return values.map(valueKeyPart).join("\0");
}

function valueKeyPart(value: SqlValue): string {
  if (value === null) return "N";
  if (typeof value === "bigint") return `I:${value.toString()}`;
  if (typeof value === "number") {
    if (Number.isInteger(value)) return `I:${value.toString()}`;
    if (Number.isNaN(value)) return "F:nan";
    return `F:${Object.is(value, -0) ? "0" : value.toString()}`;
  }
  if (typeof value === "string") return `T:${value}`;
  if (value instanceof Uint8Array) {
    let hex = "B:";
    for (const byte of value) hex += byte.toString(16).padStart(2, "0");
    return hex;
  }
  if ("value" in value && typeof value.value === "number") {
    const n = value.value;
    if (Number.isInteger(n)) return `I:${n.toString()}`;
    return `F:${n.toString()}`;
  }
  if ("value" in value && typeof value.value === "string") return `T:${value.value}`;
  return `T:${String(value)}`;
}

function scanDbStat(db: DatabaseState, alias: string, _schemaArg: string | null): ScopeRow[] {
  const rows: ScopeRow[] = [];
  let pageno = 1;
  const push = (name: string, pagetype: string, ncell: number) => {
    rows.push({
      cells: [
        { table: alias, name: "name", value: name },
        { table: alias, name: "path", value: "/" },
        { table: alias, name: "pageno", value: pageno++ },
        { table: alias, name: "pagetype", value: pagetype },
        { table: alias, name: "ncell", value: ncell },
        { table: alias, name: "payload", value: ncell * 8 },
        { table: alias, name: "unused", value: 0 },
        { table: alias, name: "mx_payload", value: 0 },
        { table: alias, name: "pgoffset", value: (pageno - 1) * 4096 },
        { table: alias, name: "pgsize", value: 4096 },
      ],
    });
  };
  push("sqlite_schema", "leaf", db.tables.size + db.views.size + db.virtualTables.size);
  for (const table of db.tables.values()) {
    push(table.name, "leaf", [...table.scan()].length);
  }
  for (const table of db.virtualTables.values()) {
    if (table.kind === "fts5" || table.kind === "fts3" || table.kind === "fts4" || table.kind === "rtree") {
      push(table.name, "leaf", table.kind === "rtree" ? table.rows.size : table.rows.size);
    } else {
      push(table.name, "leaf", 0);
    }
  }
  return rows;
}

function scanFtsVocab(db: DatabaseState, alias: string, vocab: FtsVocabVirtualTable): ScopeRow[] {
  const fts = db.virtualTables.get(vocab.ftsTable.toLowerCase());
  if (!fts || (fts.kind !== "fts5" && fts.kind !== "fts3" && fts.kind !== "fts4")) return [];
  return fts.vocabRows("row").map((record) => ({
    cells: vocab.columns.map((column) => ({
      table: alias,
      name: column,
      value: record[column] ?? (column === "col" ? "*" : column === "offset" ? 0 : null),
    })),
  }));
}
