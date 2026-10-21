import type { Expr } from "../ast/nodes.ts";
import { pgError } from "../errors/error.ts";
import type { DatabaseState, EnumData } from "../storage/database-state.ts";
import type { Datum, TypeId } from "../types/value.ts";
import { commandResult, type ExecEnv, type ExecResult } from "./relation.ts";

/**
 * ALTER TYPE ... RENAME TO for an enum.
 *
 * PostgreSQL stores a type by oid, so a rename never touches the objects that use it. Here an enum
 * is identified by `enum:<schema>.<name>` inside column types, function signatures, stored arrays and
 * the parsed defaults / checks / views, so the rename rewrites each of those. Function bodies stay as
 * written: PostgreSQL re-resolves their type names at call time too.
 *
 * Objects shared with a transaction snapshot are replaced, never edited in place.
 */
export function executeRenameEnum(env: ExecEnv, enumData: EnumData, newName: string): ExecResult {
  const state = env.ctx.state;
  const schema = state.getSchema(enumData.schema);
  if (typeNameTaken(state, enumData.schema, newName)) {
    throw pgError("duplicate_object", `type "${newName}" already exists`, "42710");
  }

  const oldId = `enum:${enumData.schema}.${enumData.name}`;
  const newId = `enum:${enumData.schema}.${newName}`;
  const retype = (id: TypeId): TypeId => (id === oldId ? newId : id === `${oldId}[]` ? `${newId}[]` : id);
  // a written type name is the enum when it resolves to it now, before the rename
  const isTarget = (parts: string[]): boolean => state.findEnum(parts)?.oid === enumData.oid;
  const rewrite = typeNameRewriter(isTarget, newName);

  for (const sch of state.schemas.values()) {
    for (const table of [...sch.tables.values()]) {
      const changed = (e: Expr | null): boolean => e !== null && rewrite(e) !== e;
      const touched =
        table.columns.some((c) => retype(c.type.id) !== c.type.id || changed(c.defaultExpr) || changed(c.generated)) ||
        table.constraints.some((c) => c.kind === "check" && changed(c.expr));
      if (!touched) continue;
      const writable = state.ensureWritableTable(table);
      const rows = writable.mutableRows();
      writable.columns.forEach((col, index) => {
        const id = retype(col.type.id);
        if (id !== col.type.id) {
          for (const row of rows) row[index] = retypeArray(row[index] ?? null, retype);
          col.type = { ...col.type, id };
        }
        if (col.defaultExpr) col.defaultExpr = rewrite(col.defaultExpr);
        if (col.generated) col.generated = rewrite(col.generated);
      });
      writable.constraints = writable.constraints.map((c) => (c.kind === "check" ? { ...c, expr: rewrite(c.expr) } : c));
    }

    for (const view of [...sch.views.values()]) {
      const query = rewrite(view.query);
      const columnsChanged = view.matColumns?.some((c) => retype(c.type) !== c.type) === true;
      if (query === view.query && !columnsChanged) continue;
      const writable = state.ensureWritableView(view);
      writable.query = query;
      if (writable.matColumns) {
        const columns = writable.matColumns;
        columns.forEach((col, index) => {
          if (retype(col.type) === col.type) return;
          for (const row of writable.matRows ?? []) row[index] = retypeArray(row[index] ?? null, retype);
          columns[index] = { ...col, type: retype(col.type) };
        });
      }
    }

    for (const [name, domain] of [...sch.domains]) {
      const baseType = { ...domain.baseType, id: retype(domain.baseType.id) };
      const defaultExpr = domain.defaultExpr ? rewrite(domain.defaultExpr) : domain.defaultExpr;
      const checks = domain.checks.map((c) => ({ ...c, expr: rewrite(c.expr) }));
      const same =
        baseType.id === domain.baseType.id &&
        defaultExpr === domain.defaultExpr &&
        checks.every((c, i) => c.expr === domain.checks[i]?.expr);
      if (!same) sch.domains.set(name, { ...domain, baseType, defaultExpr, checks, shareCount: 0 });
    }

    for (const overloads of sch.functions.values()) {
      overloads.forEach((fn, index) => {
        const argTypes = fn.argTypes.map(retype);
        const returns = fn.returns === null ? null : retype(fn.returns);
        const returnsTable = fn.returnsTable?.map((c) => ({ ...c, type: retype(c.type) })) ?? null;
        const argDefaults = fn.argDefaults.map((d) => (d ? rewrite(d) : d));
        const same =
          argTypes.every((t, i) => t === fn.argTypes[i]) &&
          returns === fn.returns &&
          returnsTable?.every((c, i) => c.type === fn.returnsTable?.[i]?.type) !== false &&
          argDefaults.every((d, i) => d === fn.argDefaults[i]);
        if (!same) overloads[index] = { ...fn, argTypes, returns, returnsTable, argDefaults };
      });
    }

    for (const [name, index] of [...sch.indexes]) {
      const columns = index.columns.map((c) => (c.expr ? { ...c, expr: rewrite(c.expr) } : c));
      const where = index.where ? rewrite(index.where) : index.where;
      const same = where === index.where && columns.every((c, i) => c === index.columns[i]);
      if (!same) sch.indexes.set(name, { ...index, columns, where });
    }
  }

  const renamed = state.ensureWritableEnum(enumData);
  schema.enums.delete(renamed.name);
  renamed.name = newName;
  schema.enums.set(newName, renamed);
  return commandResult("ALTER TYPE", 0);
}

/** The name is a type in the schema: an enum or domain, or the row type of a table or view. */
function typeNameTaken(state: DatabaseState, schemaName: string, name: string): boolean {
  const schema = state.getSchema(schemaName);
  return schema.enums.has(name) || schema.domains.has(name) || schema.tables.has(name) || schema.views.has(name);
}

/** A stored enum array carries its element type; a scalar enum datum does not. */
function retypeArray(datum: Datum, retype: (id: TypeId) => TypeId): Datum {
  if (datum === null || typeof datum !== "object" || !("kind" in datum) || datum.kind !== "pgarray") return datum;
  const elem = retype(datum.elem);
  return elem === datum.elem ? datum : { ...datum, elem };
}

/**
 * Deep-copy `node` with the type names `isTarget` accepts renamed to `newName`; a subtree with nothing
 * to rename is returned as is, so `rewrite(x) === x` tells whether anything changed.
 */
function typeNameRewriter(
  isTarget: (parts: string[]) => boolean,
  newName: string,
): <T extends object>(node: T) => T {
  const walk = (node: unknown): unknown => {
    if (node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) {
      let out: unknown[] | null = null;
      node.forEach((item, i) => {
        const next = walk(item);
        if (next !== item) (out ??= node.slice())[i] = next;
      });
      return out ?? node;
    }
    const record = node as Record<string, unknown>;
    if (isTypeName(record) && isTarget(record.parts)) {
      return { ...record, parts: [...record.parts.slice(0, -1), newName] };
    }
    let out: Record<string, unknown> | null = null;
    for (const [key, value] of Object.entries(record)) {
      const next = walk(value);
      if (next !== value) (out ??= { ...record })[key] = next;
    }
    return out ?? node;
  };
  return <T extends object>(node: T): T => walk(node) as T;
}

/** The parser's `TypeName` node: `{ parts, mods, arrayDims }`. */
function isTypeName(node: Record<string, unknown>): node is { parts: string[]; mods: number[]; arrayDims: number } {
  return (
    Array.isArray(node.parts) &&
    node.parts.every((p) => typeof p === "string") &&
    Array.isArray(node.mods) &&
    typeof node.arrayDims === "number"
  );
}
