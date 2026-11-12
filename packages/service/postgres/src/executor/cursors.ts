import type { CloseCursorStmt, DeclareCursorStmt, FetchStmt, SelectStmt } from "../ast/nodes.ts";
import { isAggregateName } from "../functions/aggregates.ts";
import { isSrfName } from "../functions/srf.ts";
import { pgError } from "../errors/error.ts";
import type { DatabaseState } from "../storage/database-state.ts";
import type { Datum } from "../types/value.ts";
import { commandResult, type ExecEnv, type ExecResult, relationResult } from "./relation.ts";
import { executeSelectStmt } from "./select.ts";

/**
 * SQL cursors: `DECLARE`, `FETCH`, `MOVE`, `CLOSE` (https://www.postgresql.org/docs/18/sql-declare.html).
 *
 * A cursor's rows are computed when it is declared: the query sees the data as of DECLARE, which is
 * what a cursor's snapshot gives it in PostgreSQL. The position follows PostgreSQL's portal: 0 is
 * before the first row, `rows.length + 1` after the last. A cursor without `WITH HOLD` closes at the
 * end of its transaction; any cursor declared in a transaction that rolls back closes too.
 */
export interface CursorData {
  readonly name: string;
  readonly statement: string;
  readonly columns: ExecResult["columns"];
  readonly rows: Datum[][];
  readonly hold: boolean;
  readonly binary: boolean;
  /** NO SCROLL refuses backward movement */
  readonly scrollable: boolean;
  /** creation time, timestamptz micros */
  readonly created: bigint;
  pos: number;
  /** declared in the open transaction (rolled back with it) */
  inTransaction: boolean;
}

/** Whether a node of the query tree calls an aggregate, a window function or a set-returning function. */
function callsNonScanFunction(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(callsNonScanFunction);
  const o = node as Record<string, unknown>;
  if (o.type === "subquery_expr" || o.type === "array_query") return false;
  if (o.type === "func") {
    const name = (o.name as string[])[(o.name as string[]).length - 1]!;
    if (o.over || isAggregateName(name) || isSrfName(name)) return true;
  }
  return Object.values(o).some(callsNonScanFunction);
}

/**
 * Whether PostgreSQL's plan for `query` can run backward (ExecSupportsBackwardScan), which decides
 * whether a cursor declared without SCROLL / NO SCROLL is scrollable: a scan of one table, function
 * or VALUES list, with any WHERE, ORDER BY and LIMIT, is; a query without FROM (a Result node), a
 * join, aggregation, DISTINCT, a window or a set-returning function in the select list is not.
 */
function supportsBackwardScan(query: SelectStmt): boolean {
  if (query.lockingClause || query.with) return false;
  const body = query.body;
  if (body.type === "values") return true;
  if (body.type !== "select_core") return false;
  if (body.from.length !== 1 || body.distinct || body.groupBy || body.having || body.windows.length > 0) return false;
  if (callsNonScanFunction(body.targets) || callsNonScanFunction(query.orderBy)) return false;
  const item = body.from[0]!;
  if (item.type === "from_subquery") return supportsBackwardScan(item.query);
  return item.type === "from_table" || item.type === "from_func";
}

export function executeDeclareCursor(env: ExecEnv, stmt: DeclareCursorStmt): ExecResult {
  const state = env.ctx.state;
  if (!state.inTransaction && !stmt.hold) {
    throw pgError("transaction_state", "DECLARE CURSOR can only be used in transaction blocks", "25P01");
  }
  if (state.cursors.has(stmt.name)) {
    throw pgError("duplicate_object", `cursor "${stmt.name}" already exists`, "42P03");
  }
  if (stmt.query.lockingClause && stmt.scroll === true) {
    throw pgError(
      "feature_not_supported",
      `DECLARE SCROLL CURSOR ... FOR ${stmt.query.lockingClause.toUpperCase()} is not supported`,
      "0A000",
    );
  }
  const result = relationResult(executeSelectStmt(env, stmt.query), "SELECT");
  state.cursors.set(stmt.name, {
    name: stmt.name,
    statement: stmt.text,
    columns: result.columns,
    rows: result.rows,
    hold: stmt.hold,
    binary: stmt.binary,
    scrollable: stmt.scroll ?? supportsBackwardScan(stmt.query),
    created: env.ctx.stmtNow,
    pos: 0,
    inTransaction: state.inTransaction,
  });
  state.changes = 0;
  return commandResult("DECLARE CURSOR", 0);
}

function requireCursor(state: DatabaseState, name: string): CursorData {
  const cursor = state.cursors.get(name);
  if (!cursor) throw pgError("invalid_cursor", `cursor "${name}" does not exist`, "34000");
  return cursor;
}

function noBackward(): never {
  throw pgError("object_not_in_prerequisite_state", "cursor can only scan forward", "55000");
}

/** Move `cursor` as `FETCH direction` does and return the rows it passes over (or lands on). */
function fetchRows(cursor: CursorData, direction: FetchStmt["direction"]): Datum[][] {
  const n = cursor.rows.length;
  const rowAt = (pos: number): Datum[][] => (pos >= 1 && pos <= n ? [cursor.rows[pos - 1]!] : []);
  // FORWARD 0 / BACKWARD 0 re-read the current row
  if ((direction.kind === "forward" || direction.kind === "backward") && direction.count === 0)
    return rowAt(cursor.pos);
  switch (direction.kind) {
    case "forward": {
      const count = direction.count === "all" ? Number.POSITIVE_INFINITY : direction.count;
      const out: Datum[][] = [];
      while (out.length < count && cursor.pos < n) {
        cursor.pos++;
        out.push(cursor.rows[cursor.pos - 1]!);
      }
      if (out.length < count) cursor.pos = n + 1;
      return out;
    }
    case "backward": {
      if (!cursor.scrollable) noBackward();
      const count = direction.count === "all" ? Number.POSITIVE_INFINITY : direction.count;
      const out: Datum[][] = [];
      while (out.length < count && cursor.pos > 1) {
        cursor.pos--;
        out.push(cursor.rows[cursor.pos - 1]!);
      }
      if (out.length < count) cursor.pos = 0;
      return out;
    }
    case "absolute": {
      const target = direction.count >= 0 ? direction.count : n + 1 + direction.count;
      if (!cursor.scrollable && target < cursor.pos) noBackward();
      cursor.pos = Math.max(0, Math.min(target, n + 1));
      return rowAt(cursor.pos);
    }
    case "relative": {
      if (!cursor.scrollable && direction.count < 0) noBackward();
      cursor.pos = Math.max(0, Math.min(cursor.pos + direction.count, n + 1));
      return rowAt(cursor.pos);
    }
  }
}

export function executeFetch(env: ExecEnv, stmt: FetchStmt): ExecResult {
  const cursor = requireCursor(env.ctx.state, stmt.cursor);
  const rows = fetchRows(cursor, stmt.direction);
  if (stmt.move) return commandResult("MOVE", rows.length);
  return { columns: cursor.columns, rows, command: "FETCH", rowCount: rows.length };
}

export function executeCloseCursor(env: ExecEnv, stmt: CloseCursorStmt): ExecResult {
  const state = env.ctx.state;
  if (stmt.name === null) state.cursors.clear();
  else {
    requireCursor(state, stmt.name);
    state.cursors.delete(stmt.name);
  }
  return commandResult("CLOSE CURSOR", 0);
}

/** End of a transaction: close what PostgreSQL closes, keep committed WITH HOLD cursors. */
export function endTransactionCursors(state: DatabaseState, committed: boolean): void {
  if (state.cursors.size === 0) return;
  for (const [name, cursor] of state.cursors) {
    if (!cursor.inTransaction) continue;
    if (committed && cursor.hold) cursor.inTransaction = false;
    else state.cursors.delete(name);
  }
}

/** A session's cursors for a new workspace: copies, so replaying its FETCHes leaves the session's untouched. */
export function copyCursors(cursors: ReadonlyMap<string, CursorData>): Map<string, CursorData> {
  return new Map([...cursors].map(([name, cursor]) => [name, { ...cursor }]));
}
