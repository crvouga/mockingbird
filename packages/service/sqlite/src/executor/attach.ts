import type { AttachStmt, DetachStmt } from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import { evalExpr } from "../expressions/eval.ts";
import { DatabaseState } from "../storage/database-state.ts";
import type { ExecutionEnv } from "./env.ts";
import { emptyResult, type ResultSet } from "./result.ts";

export function executeAttach(stmt: AttachStmt, env: ExecutionEnv): ResultSet {
  const filename = evalExpr(stmt.filename, env.createEvalContext());
  if (typeof filename !== "string") {
    throw new SqliteError("filename argument to ATTACH must be a string", "datatype_mismatch");
  }
  const schema = stmt.schema.toLowerCase();
  if (schema === "main") {
    throw new SqliteError("database main is already in use", "other");
  }
  if (schema === "temp") {
    throw new SqliteError("database temp is already in use", "other");
  }
  if (env.state.attached.has(schema)) {
    throw new SqliteError(`database ${stmt.schema} is already in use`, "other");
  }
  env.state.attached.set(schema, { state: new DatabaseState(), filename });
  return emptyResult(0, env.state.lastInsertRowid);
}

export function executeDetach(stmt: DetachStmt, env: ExecutionEnv): ResultSet {
  const schema = stmt.schema.toLowerCase();
  if (schema === "main") {
    throw new SqliteError("cannot detach database main", "other");
  }
  if (schema === "temp") {
    throw new SqliteError("cannot detach database temp", "other");
  }
  if (!env.state.attached.delete(schema)) {
    throw new SqliteError(`no such database: ${stmt.schema}`, "other");
  }
  return emptyResult(0, env.state.lastInsertRowid);
}
