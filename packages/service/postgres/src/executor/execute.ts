import type { Statement } from "../ast/nodes.ts";
import { pgError } from "../errors/error.ts";
// side effect: registers the pg_catalog / information_schema builder
import "../schema/catalog-tables.ts";
import "./triggers-exec.ts";
import { EngineCtx } from "../expressions/context.ts";
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
import { executeDelete, executeInsert, executeUpdate } from "./dml.ts";
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

/** Execute one parsed statement against `state`. */
export function executeStatement(env: ExecEnv, stmt: Statement): ExecResult {
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
      return executeAlterTable(env, stmt);
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
      return commandResult("COMMENT", 0);
    case "no_op":
      return commandResult(stmt.what.toUpperCase(), 0);
    case "do":
      return commandResult("DO", 0);
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
