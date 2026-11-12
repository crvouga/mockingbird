import type { EngineCtx } from "../expressions/context.ts";
import type { DatabaseState } from "../storage/database-state.ts";
import type { CursorData } from "./cursors.ts";
import type { ExecResult } from "./relation.ts";

/**
 * The portals PL/pgSQL cursors open. Inside a transaction block a portal is one of the session's SQL
 * cursors (`state.cursors`): SQL `FETCH` / `CLOSE` reach it by name, a PL/pgSQL `FETCH` reaches a
 * cursor SQL `DECLARE`d, and it closes when the transaction ends. Outside a transaction block a
 * portal lives only as long as the top-level statement that opened it, so it is kept here, keyed by
 * that statement's context, and is gone for every later statement.
 *
 * `OPEN` materializes the query's rows, which is what a cursor's snapshot gives it in PostgreSQL:
 * the rows as of OPEN, whatever is written afterwards.
 */
export type Portal = CursorData;

interface StatementPortals {
  ctx: EngineCtx;
  portals: Map<string, Portal>;
}

const statementPortals = new WeakMap<DatabaseState, StatementPortals>();
const unnamedCounters = new WeakMap<DatabaseState, number>();

function local(ctx: EngineCtx): Map<string, Portal> {
  let entry = statementPortals.get(ctx.state);
  if (entry === undefined || entry.ctx !== ctx) {
    entry = { ctx, portals: new Map() };
    statementPortals.set(ctx.state, entry);
  }
  return entry.portals;
}

/** The open portal called `name`, if any. */
export function findPortal(ctx: EngineCtx, name: string): Portal | undefined {
  return local(ctx).get(name) ?? ctx.state.cursors.get(name);
}

/** A fresh `<unnamed portal N>` name. */
export function unnamedPortalName(ctx: EngineCtx): string {
  let n = unnamedCounters.get(ctx.state) ?? 0;
  for (;;) {
    const name = `<unnamed portal ${++n}>`;
    if (findPortal(ctx, name) === undefined) {
      unnamedCounters.set(ctx.state, n);
      return name;
    }
  }
}

/** Open a portal over `result`. */
export function addPortal(ctx: EngineCtx, name: string, result: ExecResult, scrollable: boolean, text: string): Portal {
  const state = ctx.state;
  const portal: Portal = {
    name,
    statement: text,
    columns: result.columns,
    rows: result.rows,
    hold: false,
    binary: false,
    scrollable,
    created: ctx.stmtNow,
    pos: 0,
    inTransaction: state.inTransaction,
  };
  if (state.inTransaction) state.cursors.set(name, portal);
  else local(ctx).set(name, portal);
  return portal;
}

export function removePortal(ctx: EngineCtx, name: string): void {
  if (!local(ctx).delete(name)) ctx.state.cursors.delete(name);
}

/**
 * A PL/pgSQL COMMIT / ROLLBACK outside a transaction block: the portals the statement opened close
 * (cursors of a transaction block close with it in the transaction manager).
 */
export function closeStatementPortals(state: DatabaseState): void {
  statementPortals.get(state)?.portals.clear();
}
