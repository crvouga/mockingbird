import { flushConstraintTriggers, setConstraints } from "./triggers.ts";
import type { AlterTableStmt, Statement } from "../ast/nodes.ts";
import { pgError } from "../errors/error.ts";
// side effect: registers the pg_catalog / information_schema builder
import "../schema/catalog-tables.ts";
import "./triggers-exec.ts";
import { EngineCtx } from "../expressions/context.ts";
import { syncIndexCatalog } from "../schema/index-catalog.ts";
import type { DatabaseState } from "../storage/database-state.ts";
import type { TypedValue } from "../types/value.ts";
import {
  executeAlterEnum,
  executeAlterIndex,
  executeAlterSchema,
  executeAlterSequence,
  executeAlterTable,
  executeAlterView,
  executeCreateDomain,
  executeCreateEnum,
  executeCreateFunction,
  executeCreateIndex,
  executeCreateSchema,
  executeCreateSequence,
  executeCreateTable,
  executeCreateTableAs,
  executeCreateTrigger,
  executeCreateView,
  executeDrop,
  executeRefreshMatView,
  executeTruncate,
} from "./ddl.ts";
import { executeDelete, executeInsert, executeUpdate, withStatementRollback } from "./dml.ts";
import { executeCreateExtension } from "./extensions.ts";
import { executeComment } from "./comment.ts";
import { executeAnalyze, executeReindex } from "./maintenance.ts";
import { executeDo } from "./plpgsql.ts";
import { commandResult, type ExecEnv, type ExecResult, relationResult } from "./relation.ts";
import { executeSelectStmt, setStatementRunner } from "./select.ts";
import {
  executeCopy,
  executeDeallocate,
  executeExecute,
  executeExplain,
  executePrepare,
  executeReset,
  executeSet,
  executeShow,
  executeTransaction,
} from "./session.ts";

/** Statements that can add, move, rename or drop a table, and so the indexes that follow it. */
const RESHAPES_TABLES: ReadonlySet<Statement["type"]> = new Set([
  "create_table",
  "create_table_as",
  "alter_table",
  "alter_schema",
  "drop",
]);

/**
 * ALTER TABLE actions that only change metadata and check everything before they change
 * anything. One of them alone cannot leave a half-applied statement, so it runs without the
 * statement snapshot, which copies the table's rows.
 */
const SELF_CONTAINED_ALTER_ACTIONS: ReadonlySet<AlterTableStmt["actions"][number]["kind"]> = new Set([
  "set_default",
  "drop_default",
  "set_not_null",
  "drop_not_null",
  "set_storage",
  "set_logged",
  "owner_to",
  "reloptions",
]);

function alterTableIsSelfContained(stmt: AlterTableStmt): boolean {
  const [action] = stmt.actions;
  return stmt.actions.length === 1 && action !== undefined && SELF_CONTAINED_ALTER_ACTIONS.has(action.kind);
}

/** Execute one parsed statement against `state`. */
export function executeStatement(env: ExecEnv, stmt: Statement): ExecResult {
  if (!RESHAPES_TABLES.has(stmt.type)) {
    if (
      (stmt.type === "insert" || stmt.type === "update" || stmt.type === "delete") &&
      (env.ctx.state.pendingTriggers.length > 0 ||
        env.ctx.state.findTable(stmt.table)?.triggers.some((t) => t.constraint))
    ) {
      return withStatementRollback(env, () => {
        const result = dispatchStatement(env, stmt);
        flushConstraintTriggers(env.ctx.state);
        return result;
      });
    }
    return dispatchStatement(env, stmt);
  }
  try {
    return dispatchStatement(env, stmt);
  } finally {
    // also after a failure: an ALTER TABLE that fails midway has applied its earlier actions
    syncIndexCatalog(env.ctx.state);
  }
}

function dispatchStatement(env: ExecEnv, stmt: Statement): ExecResult {
  switch (stmt.type) {
    case "select":
      return relationResult(executeSelectStmt(env, stmt), "SELECT");
    case "insert":
      return executeInsert(env, stmt);
    case "update":
      return executeUpdate(env, stmt);
    case "delete":
      return executeDelete(env, stmt);
    case "create_table":
      return executeCreateTable(env, stmt);
    case "create_table_as":
      return executeCreateTableAs(env, stmt);
    case "create_index":
      return executeCreateIndex(env, stmt);
    case "create_view":
      return executeCreateView(env, stmt);
    case "create_sequence":
      return executeCreateSequence(env, stmt);
    case "alter_sequence":
      return executeAlterSequence(env, stmt);
    case "create_schema":
      return executeCreateSchema(env, stmt);
    case "create_extension":
      return executeCreateExtension(env, stmt);
    case "create_enum":
      return executeCreateEnum(env, stmt);
    case "alter_enum":
      return executeAlterEnum(env, stmt);
    case "create_domain":
      return executeCreateDomain(env, stmt);
    case "create_function":
      return executeCreateFunction(env, stmt);
    case "create_trigger":
      return executeCreateTrigger(env, stmt);
    case "alter_table":
      // every action of one ALTER TABLE applies, or none does
      return alterTableIsSelfContained(stmt)
        ? executeAlterTable(env, stmt)
        : withStatementRollback(env, () => executeAlterTable(env, stmt));
    case "alter_view":
      return executeAlterView(env, stmt);
    case "alter_index":
      return executeAlterIndex(env, stmt);
    case "alter_schema":
      return executeAlterSchema(env, stmt);
    case "drop":
      return executeDrop(env, stmt);
    case "truncate":
      return executeTruncate(env, stmt);
    case "refresh_materialized_view":
      return executeRefreshMatView(env, stmt);
    case "transaction":
      return executeTransaction(env, stmt);
    case "set_constraints":
      setConstraints(env.ctx.state, stmt);
      return commandResult("SET CONSTRAINTS", 0);
    case "set":
      return executeSet(env, stmt);
    case "show":
      return executeShow(env, stmt);
    case "reset":
      return executeReset(env, stmt);
    case "prepare":
      return executePrepare(env, stmt);
    case "execute":
      return executeExecute(env, stmt);
    case "deallocate":
      return executeDeallocate(env, stmt);
    case "explain":
      return executeExplain(env, stmt);
    case "copy":
      return executeCopy(env, stmt);
    case "comment":
      return executeComment(env, stmt);
    case "analyze":
      return executeAnalyze(env, stmt);
    case "reindex":
      return executeReindex(env, stmt);
    case "no_op":
      return commandResult(stmt.what.toUpperCase(), 0);
    case "do":
      return executeDo(env, stmt.language, stmt.body);
    default: {
      const t: never = stmt;
      throw pgError("internal", `unhandled statement type ${(t as { type: string }).type}`);
    }
  }
}

setStatementRunner(executeStatement);

/** Fresh execution environment for one top-level statement. */
export function makeEnv(state: DatabaseState, params: TypedValue[] | null = null): ExecEnv {
  return { ctx: new EngineCtx(state), params, ctes: new Map(), outer: null };
}

export type { ExecEnv, ExecResult };
