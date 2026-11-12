import type {
  AlterCompositeTypeStmt,
  CompositeAttributeDef,
  CreateCompositeTypeStmt,
  Statement,
} from "../ast/nodes.ts";
import { pgError } from "../errors/error.ts";
import type { CompositeAttribute, CompositeTypeData } from "../storage/catalog-ext.ts";
import type { DatabaseState } from "../storage/database-state.ts";
import { currentRole } from "../storage/roles.ts";
import { castTo, type CastEnv, type CastOptions } from "../types/cast.ts";
import { resolveTypeName } from "../types/resolve.ts";
import {
  arrayElemType,
  type Datum,
  isArrayType,
  isCompositeType,
  isPgArray,
  isPgRecord,
  makeArray,
  type PgRecord,
  type TypedValue,
  type TypeId,
  tv,
  typeDisplayName,
} from "../types/value.ts";
import { commandResult, type ExecEnv, type ExecResult } from "./relation.ts";
import { runStatement } from "./select.ts";

/**
 * Composite types (https://www.postgresql.org/docs/18/rowtypes.html): `CREATE TYPE name AS (...)`,
 * ALTER TYPE ADD / DROP / ALTER / RENAME ATTRIBUTE, DROP TYPE. A composite's type id is
 * `comp:schema.name`; its values are records carrying the attribute names.
 */

export function compositeTypeId(c: CompositeTypeData): TypeId {
  return `comp:${c.schema}.${c.name}`;
}

/** The composite named by `parts` along the search path. */
export function findComposite(state: DatabaseState, parts: string[]): CompositeTypeData | null {
  const composites = state.catalogExt.composites;
  if (composites.size === 0) return null;
  if (parts.length >= 2) return composites.get(`${parts[parts.length - 2]}.${parts[parts.length - 1]}`) ?? null;
  for (const schema of state.effectiveSearchPath()) {
    const found = composites.get(`${schema}.${parts[0]}`);
    if (found) return found;
  }
  return null;
}

export function compositeByTypeId(state: DatabaseState, t: TypeId): CompositeTypeData | undefined {
  return state.catalogExt.composites.get(t.slice(5));
}

export function compositeByOid(state: DatabaseState, oid: number): CompositeTypeData | undefined {
  for (const c of state.catalogExt.composites.values()) if (c.oid === oid || c.relOid === oid) return c;
  return undefined;
}

export function compositeAttributes(state: DatabaseState, t: TypeId): { names: string[]; types: TypeId[] } | null {
  const c = compositeByTypeId(state, t);
  if (!c) return null;
  return { names: c.attributes.map((a) => a.name), types: c.attributes.map((a) => a.type.id) };
}

/**
 * Cast to or from a composite type: a row (`ROW(...)`, another record) of the same width takes
 * the composite's attribute types; a composite value is a record. Null when neither side is composite.
 */
export function castComposite(
  state: DatabaseState,
  env: CastEnv,
  value: TypedValue,
  target: TypeId,
  opts: CastOptions,
): TypedValue | null {
  if (!isCompositeType(target)) {
    if (isCompositeType(value.t) && target === "record") return tv("record", value.v);
    return null;
  }
  if (value.v === null) return tv(target, null);
  if (value.t === target) return value;
  const c = compositeByTypeId(state, target);
  if (!c) throw pgError("undefined_object", `type "${target.slice(5)}" does not exist`, "42704");
  if (value.t !== "record" && !isCompositeType(value.t)) return null;
  const rec = value.v as PgRecord;
  if (rec.values.length !== c.attributes.length) {
    throw pgError("cannot_coerce", `cannot cast type ${typeDisplayName(value.t)} to ${c.name}`, "42846");
  }
  const values = c.attributes.map((attr, i) => {
    const field = tv(rec.types[i] ?? "unknown", rec.values[i] ?? null);
    return castTo(env, field, attr.type.id, { explicit: opts.explicit, assignment: true, mod: attr.type.mod }).v;
  });
  return tv(target, {
    kind: "pgrecord",
    types: c.attributes.map((a) => a.type.id),
    values,
    names: c.attributes.map((a) => a.name),
  });
}

/** `(value).field` on a composite value: the attribute, typed even when the value is NULL. */
export function compositeField(state: DatabaseState, base: TypedValue, field: string): TypedValue | null {
  if (!isCompositeType(base.t)) return null;
  const c = compositeByTypeId(state, base.t);
  if (!c) return null;
  const index = c.attributes.findIndex((a) => a.name === field);
  if (index === -1) {
    throw pgError("undefined_column", `column "${field}" not found in data type ${c.name}`, "42703");
  }
  const type = c.attributes[index]!.type.id;
  if (base.v === null) return tv(type, null);
  return tv(type, (base.v as PgRecord).values[index] ?? null);
}

function typeExists(state: DatabaseState, schema: string, name: string): boolean {
  const s = state.schemas.get(schema);
  return (
    state.catalogExt.composites.has(`${schema}.${name}`) ||
    s?.enums.has(name) === true ||
    s?.domains.has(name) === true ||
    s?.tables.has(name) === true ||
    s?.views.has(name) === true ||
    s?.sequences.has(name) === true
  );
}

function buildAttributes(
  state: DatabaseState,
  defs: readonly CompositeAttributeDef[],
  self: string,
): CompositeAttribute[] {
  const seen = new Set<string>();
  return defs.map((def) => {
    if (seen.has(def.name)) {
      throw pgError("duplicate_column", `column "${def.name}" specified more than once`, "42701");
    }
    seen.add(def.name);
    const resolved = resolveTypeName(state, def.typeName);
    if (resolved.column.id === self || arrayElemType(resolved.column.id) === self) {
      throw pgError(
        "invalid_table_definition",
        `composite type ${self.slice(self.indexOf(".") + 1)} cannot be made a member of itself`,
        "42P16",
      );
    }
    return { name: def.name, type: resolved.column, collate: def.collate?.join(".") ?? null };
  });
}

function setComposite(state: DatabaseState, key: string, data: CompositeTypeData | null): void {
  const composites = new Map(state.catalogExt.composites);
  if (data) composites.set(key, data);
  else composites.delete(key);
  state.catalogExt = { ...state.catalogExt, composites };
}

export function executeCreateCompositeType(env: ExecEnv, stmt: CreateCompositeTypeStmt): ExecResult {
  const state = env.ctx.state;
  const schema = stmt.name.length > 1 ? state.getSchema(stmt.name[stmt.name.length - 2]!).name : state.currentSchema();
  const name = stmt.name[stmt.name.length - 1]!;
  if (typeExists(state, schema, name)) {
    throw pgError("duplicate_object", `type "${name}" already exists`, "42710");
  }
  const attributes = buildAttributes(state, stmt.attributes, `comp:${schema}.${name}`);
  const relOid = state.nextOid();
  const oid = state.nextOid();
  const arrayOid = state.nextOid();
  setComposite(state, `${schema}.${name}`, {
    oid,
    relOid,
    arrayOid,
    schema,
    name,
    attributes,
    owner: currentRole(state).oid,
  });
  return commandResult("CREATE TYPE", 0);
}

/** Every stored value of composite type `t` (also inside arrays) rewritten by `change`. */
function rewriteStoredValues(state: DatabaseState, t: TypeId, change: (rec: PgRecord) => PgRecord): void {
  const rewrite = (type: TypeId, value: Datum): Datum => {
    if (value === null) return null;
    if (type === t && isPgRecord(value)) return change(value);
    if (isArrayType(type) && arrayElemType(type) === t && isPgArray(value)) {
      return makeArray(
        t,
        value.items.map((item) => (item === null ? null : change(item as PgRecord))),
        value.dims,
        value.lbs,
      );
    }
    return value;
  };
  for (const schema of state.schemas.values()) {
    for (const found of schema.tables.values()) {
      const indexes = found.columns.flatMap((c, i) =>
        c.type.id === t || (isArrayType(c.type.id) && arrayElemType(c.type.id) === t) ? [i] : [],
      );
      if (indexes.length === 0) continue;
      const table = state.ensureWritableTable(found);
      const rows = table.mutableRows();
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r]!.slice();
        for (const i of indexes) row[i] = rewrite(table.columns[i]!.type.id, row[i] ?? null);
        table.replaceRow(r, row);
      }
    }
  }
}

export function executeAlterCompositeType(env: ExecEnv, stmt: AlterCompositeTypeStmt): ExecResult {
  const state = env.ctx.state;
  for (const action of stmt.actions) {
    const c = findComposite(state, stmt.name);
    if (!c) throw pgError("undefined_object", `type "${stmt.name.join(".")}" does not exist`, "42704");
    const t = compositeTypeId(c);
    const key = `${c.schema}.${c.name}`;
    switch (action.kind) {
      case "add_attribute": {
        if (c.attributes.some((a) => a.name === action.attribute.name)) {
          throw pgError(
            "duplicate_column",
            `column "${action.attribute.name}" of relation "${c.name}" already exists`,
            "42701",
          );
        }
        const [attr] = buildAttributes(state, [action.attribute], t);
        setComposite(state, key, { ...c, attributes: [...c.attributes, attr!] });
        rewriteStoredValues(state, t, (rec) => ({
          ...rec,
          types: [...rec.types, attr!.type.id],
          values: [...rec.values, null],
          names: [...(rec.names ?? c.attributes.map((a) => a.name)), attr!.name],
        }));
        break;
      }
      case "drop_attribute": {
        const index = c.attributes.findIndex((a) => a.name === action.name);
        if (index === -1) {
          if (action.ifExists) break;
          throw pgError("undefined_column", `column "${action.name}" of relation "${c.name}" does not exist`, "42703");
        }
        const keep = <T>(list: readonly T[]) => list.filter((_, i) => i !== index);
        setComposite(state, key, { ...c, attributes: keep(c.attributes) });
        rewriteStoredValues(state, t, (rec) => ({
          ...rec,
          types: keep(rec.types),
          values: keep(rec.values),
          names: keep(rec.names ?? c.attributes.map((a) => a.name)),
        }));
        break;
      }
      case "alter_attribute_type": {
        const index = c.attributes.findIndex((a) => a.name === action.name);
        if (index === -1) {
          throw pgError("undefined_column", `column "${action.name}" of relation "${c.name}" does not exist`, "42703");
        }
        const user = compositeDependents(state, t).find((d) => "table" in d);
        if (user && "table" in user) {
          throw pgError(
            "feature_not_supported",
            `cannot alter type "${c.name}" because column "${user.table[1]}.${user.column}" uses it`,
            "0A000",
          );
        }
        const type = resolveTypeName(state, action.typeName).column;
        const attributes = c.attributes.map((a, i) => (i === index ? { ...a, type } : a));
        setComposite(state, key, { ...c, attributes });
        rewriteStoredValues(state, t, (rec) => ({
          ...rec,
          types: rec.types.map((old, i) => (i === index ? type.id : old)),
          values: rec.values.map((v, i) =>
            i === index
              ? castTo(env.ctx, tv(rec.types[i] ?? "text", v), type.id, { assignment: true, mod: type.mod }).v
              : v,
          ),
        }));
        break;
      }
      case "rename_attribute": {
        const index = c.attributes.findIndex((a) => a.name === action.from);
        if (index === -1) {
          throw pgError("undefined_column", `column "${action.from}" does not exist`, "42703");
        }
        if (c.attributes.some((a) => a.name === action.to)) {
          throw pgError("duplicate_column", `column "${action.to}" of relation "${c.name}" already exists`, "42701");
        }
        const attributes = c.attributes.map((a, i) => (i === index ? { ...a, name: action.to } : a));
        setComposite(state, key, { ...c, attributes });
        rewriteStoredValues(state, t, (rec) => ({ ...rec, names: attributes.map((a) => a.name) }));
        break;
      }
    }
  }
  return commandResult("ALTER TYPE", 0);
}

/** ALTER TYPE name RENAME TO new: the type id changes, so columns and attributes of the type follow. */
export function renameComposite(env: ExecEnv, c: CompositeTypeData, to: string): void {
  const state = env.ctx.state;
  if (typeExists(state, c.schema, to)) throw pgError("duplicate_object", `type "${to}" already exists`, "42710");
  const from = compositeTypeId(c);
  const next = { ...c, name: to };
  const toId = compositeTypeId(next);
  setComposite(state, `${c.schema}.${c.name}`, null);
  setComposite(state, `${c.schema}.${to}`, next);
  retypeColumns(state, from, toId);
}

function retypeColumns(state: DatabaseState, from: TypeId, to: TypeId): void {
  const swap = (t: TypeId) => (t === from ? to : t === `${from}[]` ? `${to}[]` : t);
  for (const schema of state.schemas.values()) {
    for (const found of schema.tables.values()) {
      if (!found.columns.some((c) => swap(c.type.id) !== c.type.id)) continue;
      const table = state.ensureWritableTable(found);
      table.columns = table.columns.map((c) =>
        swap(c.type.id) === c.type.id ? c : { ...c, type: { ...c.type, id: swap(c.type.id) } },
      );
    }
  }
  const composites = new Map(state.catalogExt.composites);
  for (const [key, c] of composites) {
    if (c.attributes.some((a) => swap(a.type.id) !== a.type.id)) {
      composites.set(key, {
        ...c,
        attributes: c.attributes.map((a) => ({ ...a, type: { ...a.type, id: swap(a.type.id) } })),
      });
    }
  }
  state.catalogExt = { ...state.catalogExt, composites };
}

/** What uses composite type `t`: table columns and other composites' attributes. */
function compositeDependents(
  state: DatabaseState,
  t: TypeId,
): Array<{ table: string[]; column: string } | { composite: string }> {
  const uses = (id: TypeId) => id === t || (isArrayType(id) && arrayElemType(id) === t);
  const out: Array<{ table: string[]; column: string } | { composite: string }> = [];
  for (const schema of state.schemas.values()) {
    for (const table of schema.tables.values()) {
      for (const column of table.columns)
        if (uses(column.type.id)) out.push({ table: [table.schema, table.name], column: column.name });
    }
  }
  for (const c of state.catalogExt.composites.values()) {
    if (c.attributes.some((a) => uses(a.type.id))) out.push({ composite: `${c.schema}.${c.name}` });
  }
  return out;
}

/** DROP TYPE of a composite; CASCADE drops the columns and attributes of the type. True when `parts` named one. */
export function dropComposite(env: ExecEnv, parts: string[], cascade: boolean): boolean {
  const state = env.ctx.state;
  const c = findComposite(state, parts);
  if (!c) return false;
  const t = compositeTypeId(c);
  const dependents = compositeDependents(state, t);
  if (dependents.length > 0 && !cascade) {
    throw pgError("dependent_objects", `cannot drop type ${c.name} because other objects depend on it`, "2BP01");
  }
  setComposite(state, `${c.schema}.${c.name}`, null);
  for (const dep of dependents) {
    if ("table" in dep) {
      const stmt: Statement = {
        type: "alter_table",
        table: dep.table,
        ifExists: true,
        only: false,
        actions: [{ kind: "drop_column", name: dep.column, ifExists: true, cascade: true }],
      };
      runStatement(env, stmt);
    } else {
      const other = state.catalogExt.composites.get(dep.composite);
      if (other) {
        const keep = other.attributes.filter((a) => a.type.id !== t && arrayElemType(a.type.id) !== t);
        setComposite(state, dep.composite, { ...other, attributes: keep });
      }
    }
  }
  return true;
}
