import type { CommentStmt } from "../ast/nodes.ts";
import { pgError } from "../errors/error.ts";
import { findIndex, otherRelationKind } from "../schema/index-catalog.ts";
import type { DatabaseState, FunctionData, TableData } from "../storage/database-state.ts";
import { resolveTypeName } from "../types/resolve.ts";
import { commandResult, type ExecEnv, type ExecResult } from "./relation.ts";

/**
 * COMMENT ON. Comments are kept on the object itself (so they follow renames and go with DROP) and
 * read back through pg_description, obj_description and col_description: tables, views,
 * materialized views, columns, indexes, sequences, functions and procedures, constraints, triggers,
 * types and domains. Comments on the remaining kinds (schemas, extensions, roles, databases, ...)
 * are accepted and not stored.
 *
 * Catalog objects are shared with transaction snapshots: each is replaced, never mutated.
 */
export function executeComment(env: ExecEnv, stmt: CommentStmt): ExecResult {
  const state = env.ctx.state;
  // an empty string removes the comment, exactly as NULL does
  const comment = stmt.comment ? stmt.comment : undefined;
  switch (stmt.objectKind) {
    case "index":
      commentOnIndex(state, stmt, comment);
      break;
    case "table":
    case "foreign":
      commentOnTable(state, stmt.objectName, comment);
      break;
    case "view":
    case "materialized view":
      commentOnView(state, stmt.objectName, stmt.objectKind === "view", comment);
      break;
    case "sequence":
      commentOnSequence(state, stmt.objectName, comment);
      break;
    case "column":
      commentOnColumn(state, stmt.objectName, comment);
      break;
    case "constraint":
      commentOnConstraint(state, stmt, comment);
      break;
    case "trigger":
      commentOnTrigger(state, stmt, comment);
      break;
    case "function":
    case "procedure":
    case "routine":
      commentOnFunction(state, stmt, comment);
      break;
    case "type":
    case "domain":
      commentOnType(state, stmt, comment);
      break;
    default:
      break;
  }
  return commandResult("COMMENT", 0);
}

const missingRelation = (parts: readonly string[]) =>
  pgError("undefined_table", `relation "${parts.join(".")}" does not exist`, "42P01");

function commentOnIndex(state: DatabaseState, stmt: CommentStmt, comment: string | undefined): void {
  const found = findIndex(state, stmt.objectName);
  if (!found) {
    if (stmt.objectName.length >= 2) state.getSchema(stmt.objectName.at(-2)!);
    if (otherRelationKind(state, stmt.objectName)) {
      throw pgError("wrong_object_type", `"${stmt.objectName.at(-1)}" is not an index`, "42809");
    }
    throw missingRelation(stmt.objectName);
  }
  const { comment: _previous, ...index } = found.index;
  found.schema.indexes.set(index.name, comment ? { ...index, comment } : index);
}

function wrongKind(state: DatabaseState, parts: string[], kind: string): never {
  const name = parts.at(-1)!;
  if (state.findTable(parts) || state.findView(parts) || state.findSequence(parts) || findIndex(state, parts)) {
    throw pgError("wrong_object_type", `"${name}" is not ${kind}`, "42809");
  }
  if (parts.length >= 2) state.getSchema(parts.at(-2)!);
  throw missingRelation(parts);
}

function writableTable(state: DatabaseState, parts: string[]): TableData {
  const table = state.findTable(parts);
  if (!table) wrongKind(state, parts, "a table");
  return state.ensureWritableTable(table);
}

function commentOnTable(state: DatabaseState, parts: string[], comment: string | undefined): void {
  writableTable(state, parts).comment = comment;
}

function commentOnView(state: DatabaseState, parts: string[], plain: boolean, comment: string | undefined): void {
  const view = state.findView(parts);
  if (!view || view.materialized === plain) wrongKind(state, parts, plain ? "a view" : "a materialized view");
  const { comment: _previous, ...rest } = view;
  state.schemas.get(view.schema)?.views.set(view.name, comment ? { ...rest, comment } : rest);
}

function commentOnSequence(state: DatabaseState, parts: string[], comment: string | undefined): void {
  const seq = state.findSequence(parts);
  if (!seq) wrongKind(state, parts, "a sequence");
  const { comment: _previous, ...rest } = seq;
  state.schemas.get(seq.schema)?.sequences.set(seq.name, comment ? { ...rest, comment } : rest);
}

function commentOnColumn(state: DatabaseState, parts: string[], comment: string | undefined): void {
  if (parts.length < 2) throw pgError("syntax", "column name must be qualified", "42601");
  const relation = parts.slice(0, -1);
  const columnName = parts.at(-1)!;
  const found = state.findTable(relation);
  if (found) {
    const index = found.columnIndex(columnName);
    if (index === -1) {
      throw pgError("undefined_column", `column "${columnName}" of relation "${found.name}" does not exist`, "42703");
    }
    const table = state.ensureWritableTable(found);
    const { comment: _previous, ...column } = table.columns[index]!;
    table.columns[index] = comment ? { ...column, comment } : column;
    return;
  }
  // a view's columns take comments too; the engine keeps none for them
  if (state.findView(relation)) return;
  if (relation.length >= 2) state.getSchema(relation.at(-2)!);
  throw missingRelation(relation);
}

function commentOnConstraint(state: DatabaseState, stmt: CommentStmt, comment: string | undefined): void {
  const name = stmt.objectName.at(-1)!;
  if (!stmt.onTable) throw pgError("syntax", "COMMENT ON CONSTRAINT requires ON table", "42601");
  const found = state.findTable(stmt.onTable);
  if (!found) throw missingRelation(stmt.onTable);
  const index = found.constraints.findIndex((c) => c.name === name);
  if (index === -1) {
    throw pgError("undefined_object", `constraint "${name}" for table "${found.name}" does not exist`, "42704");
  }
  const table = state.ensureWritableTable(found);
  const { comment: _previous, ...constraint } = table.constraints[index]!;
  table.constraints[index] = (comment ? { ...constraint, comment } : constraint) as (typeof table.constraints)[number];
}

function commentOnTrigger(state: DatabaseState, stmt: CommentStmt, comment: string | undefined): void {
  const name = stmt.objectName.at(-1)!;
  if (!stmt.onTable) throw pgError("syntax", "COMMENT ON TRIGGER requires ON table", "42601");
  const found = state.findTable(stmt.onTable);
  if (!found) throw missingRelation(stmt.onTable);
  const index = found.triggers.findIndex((t) => t.name === name);
  if (index === -1) {
    throw pgError("undefined_object", `trigger "${name}" for table "${found.name}" does not exist`, "42704");
  }
  const table = state.ensureWritableTable(found);
  const { comment: _previous, ...trigger } = table.triggers[index]!;
  table.triggers[index] = comment ? { ...trigger, comment } : trigger;
}

function commentOnFunction(state: DatabaseState, stmt: CommentStmt, comment: string | undefined): void {
  const parts = stmt.objectName;
  const candidates = state.findFunctions(parts).filter((f) => f.schema !== "pg_catalog");
  let target: FunctionData | undefined;
  if (stmt.args) {
    const wanted = stmt.args.map((t) => resolveTypeName(state, t).column.id);
    target = candidates.find((f) => f.argTypes.length === wanted.length && f.argTypes.every((t, i) => t === wanted[i]));
    if (!target) {
      throw pgError(
        "undefined_function",
        `function ${parts.join(".")}(${stmt.args.map((t) => t.parts.join(".")).join(", ")}) does not exist`,
        "42883",
      );
    }
  } else {
    if (candidates.length === 0) {
      throw pgError("undefined_function", `could not find a function named "${parts.join(".")}"`, "42883");
    }
    if (candidates.length > 1) {
      throw pgError("ambiguous_function", `function name "${parts.join(".")}" is not unique`, "42725");
    }
    target = candidates[0]!;
  }
  const schema = state.schemas.get(target.schema);
  const overloads = schema?.functions.get(target.name);
  if (!schema || !overloads) return;
  const { comment: _previous, ...rest } = target;
  schema.functions.set(
    target.name,
    overloads.map((f) => (f === target ? (comment ? { ...rest, comment } : rest) : f)),
  );
}

function commentOnType(state: DatabaseState, stmt: CommentStmt, comment: string | undefined): void {
  const parts = stmt.objectName;
  const domain = state.findDomain(parts);
  if (domain) {
    const { comment: _previous, ...rest } = domain;
    state.schemas.get(domain.schema)?.domains.set(domain.name, comment ? { ...rest, comment } : rest);
    return;
  }
  const en = stmt.objectKind === "type" ? state.findEnum(parts) : null;
  if (en) {
    const { comment: _previous, ...rest } = en;
    state.schemas.get(en.schema)?.enums.set(en.name, comment ? { ...rest, comment } : rest);
    return;
  }
  // a built-in type, or a type the engine does not model as an object: nothing to keep
  resolveTypeName(state, { parts, mods: [], arrayDims: 0 });
}
