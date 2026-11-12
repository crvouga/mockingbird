import type { Statement, WithClause } from "../ast/nodes.ts";
import { pgError } from "../errors/error.ts";
import type { DatabaseState } from "../storage/database-state.ts";
import type { TransactionManager } from "./manager.ts";

/** Statements that read no data, so they do not fix the transaction's snapshot. */
const SNAPSHOT_FREE: ReadonlySet<Statement["type"]> = new Set([
  "transaction",
  "set",
  "show",
  "reset",
  "set_constraints",
  "prepare",
  "deallocate",
  "no_op",
]);

/** Utility statements PostgreSQL refuses in a read-only transaction, by the name its error uses. */
function utilityCommand(stmt: Statement): string | null {
  switch (stmt.type) {
    case "create_table":
      return "CREATE TABLE";
    case "create_table_as":
      return stmt.materialized ? "CREATE MATERIALIZED VIEW" : "CREATE TABLE AS";
    case "create_index":
      return "CREATE INDEX";
    case "create_view":
      return stmt.materialized ? "CREATE MATERIALIZED VIEW" : "CREATE VIEW";
    case "create_sequence":
      return "CREATE SEQUENCE";
    case "alter_sequence":
      return "ALTER SEQUENCE";
    case "create_schema":
      return "CREATE SCHEMA";
    case "create_extension":
      return "CREATE EXTENSION";
    case "create_enum":
      return "CREATE TYPE";
    case "alter_enum":
      return "ALTER TYPE";
    case "create_domain":
      return "CREATE DOMAIN";
    case "create_function":
      return "CREATE FUNCTION";
    case "create_trigger":
      return "CREATE TRIGGER";
    case "alter_table":
      return "ALTER TABLE";
    case "alter_view":
      return "ALTER VIEW";
    case "alter_index":
      return "ALTER INDEX";
    case "alter_schema":
      return "ALTER SCHEMA";
    case "drop":
      return `DROP ${stmt.kind.replaceAll("_", " ").toUpperCase()}`;
    case "truncate":
      return "TRUNCATE TABLE";
    case "refresh_materialized_view":
      return "REFRESH MATERIALIZED VIEW";
    case "comment":
      return "COMMENT";
    case "copy":
      return stmt.direction === "from" ? "COPY FROM" : null;
    default:
      return null;
  }
}

/** Whether `name` resolves to a temporary relation, whose rows a read-only transaction may change. */
function isTempRelation(state: DatabaseState, name: string[]): boolean {
  const table = state.findTable(name);
  if (table) return table.temp === true;
  return false;
}

function cteWritesPermanent(state: DatabaseState, withClause: WithClause | null): boolean {
  return (withClause?.ctes ?? []).some((cte) => dmlWritesPermanent(state, cte.query));
}

function dmlWritesPermanent(state: DatabaseState, stmt: Statement): boolean {
  switch (stmt.type) {
    case "insert":
    case "update":
    case "delete":
    case "merge":
      return !isTempRelation(state, stmt.table) || cteWritesPermanent(state, stmt.with);
    case "select":
      return cteWritesPermanent(state, stmt.with);
    default:
      return false;
  }
}

/** Relations named in the FROM clauses of a SELECT, for FOR UPDATE / FOR SHARE. */
function fromTables(node: unknown, out: string[][]): string[][] {
  if (Array.isArray(node)) {
    for (const item of node) fromTables(item, out);
  } else if (typeof node === "object" && node !== null) {
    const item = node as { type?: unknown; name?: unknown };
    if (item.type === "from_table" && Array.isArray(item.name)) out.push(item.name as string[]);
    for (const value of Object.values(node)) fromTables(value, out);
  }
  return out;
}

const readOnlyError = (command: string) =>
  pgError("transaction_state", `cannot execute ${command} in a read-only transaction`, "25006");

/** PreventCommandIfReadOnly for a sequence function (`nextval()`, `setval()`) on a permanent sequence. */
export function assertSequenceWritable(state: DatabaseState, fn: string, temp: boolean): void {
  if (!temp && state.getSetting("transaction_read_only") === "on") throw readOnlyError(`${fn}()`);
}

/**
 * Run before each statement: record that the transaction has taken its snapshot, and refuse what
 * a read-only transaction may not do (`25006`): data changes to permanent relations, row locks, and
 * every DDL statement, temporary objects included.
 */
export function beforeStatement(state: DatabaseState, tx: TransactionManager, stmt: Statement): void {
  if (SNAPSHOT_FREE.has(stmt.type)) return;
  if (tx.inTransaction) tx.snapshotTaken = true;
  if (state.getSetting("transaction_read_only") !== "on") return;
  const utility = utilityCommand(stmt);
  if (utility) throw readOnlyError(utility);
  if (dmlWritesPermanent(state, stmt)) throw readOnlyError(stmt.type.toUpperCase());
  if (stmt.type === "select" && stmt.lockingClause) {
    const tables = fromTables(stmt.body, []);
    if (tables.some((name) => !isTempRelation(state, name))) {
      throw readOnlyError(`SELECT FOR ${stmt.lockingClause.toUpperCase()}`);
    }
  }
}
