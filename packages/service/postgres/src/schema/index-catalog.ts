import { materializedTable } from "../storage/indexable-relation.ts";
import { pgError } from "../errors/error.ts";
import type { ConstraintMeta, DatabaseState, IndexMeta, SchemaData, TableData } from "../storage/database-state.ts";

/**
 * Index identity. Every index, including the one PostgreSQL creates behind a
 * PRIMARY KEY or UNIQUE constraint, is an `IndexMeta` in its table's schema with
 * its own oid. `syncIndexCatalog` runs after each statement that can change a
 * table and re-derives the parts of that catalog that follow from the tables:
 * which schema and table an index belongs to, and the indexes that back key
 * constraints. Index objects are shared with transaction snapshots, so every
 * change replaces the entry instead of mutating it.
 */

export type KeyConstraint = Extract<ConstraintMeta, { kind: "primary_key" | "unique" }>;

export const isKeyConstraint = (constraint: ConstraintMeta): constraint is KeyConstraint =>
  constraint.kind === "primary_key" || constraint.kind === "unique";

/** pg_am rows: access method name → [oid, amtype]. */
export const ACCESS_METHODS: ReadonlyMap<string, readonly [oid: number, type: "t" | "i"]> = new Map([
  ["heap", [2, "t"]],
  ["btree", [403, "i"]],
  ["hash", [405, "i"]],
  ["gist", [783, "i"]],
  ["gin", [2742, "i"]],
  ["spgist", [4000, "i"]],
  ["brin", [3580, "i"]],
]);

export const indexMethod = (index: IndexMeta): string => index.method ?? "btree";

/** Number of key columns plus INCLUDE columns (`pg_index.indnatts`). */
export const indexAttributeCount = (index: IndexMeta): number => index.columns.length + (index.include?.length ?? 0);

function keyColumns(constraint: KeyConstraint): IndexMeta["columns"] {
  return constraint.columns.map((column) => ({ column, expr: null, dir: "asc", nulls: "last" }));
}

function sameKeyColumns(index: IndexMeta, constraint: KeyConstraint): boolean {
  return (
    index.columns.length === constraint.columns.length &&
    index.columns.every((column, position) => column.column === constraint.columns[position])
  );
}

/** A relation of any kind already uses `name` in `schema` (indexes share the pg_class namespace). */
function nameTaken(schema: SchemaData, name: string, self?: IndexMeta): boolean {
  if (schema.tables.has(name) || schema.views.has(name) || schema.sequences.has(name)) return true;
  const other = schema.indexes.get(name);
  return other !== undefined && other !== self;
}

export function syncIndexCatalog(state: DatabaseState): void {
  const tables = new Map<number, { schema: SchemaData; table: TableData }>();
  for (const schema of state.schemas.values()) {
    for (const table of schema.tables.values()) tables.set(table.oid, { schema, table });
    for (const view of schema.views.values())
      if (view.materialized) tables.set(view.oid, { schema, table: materializedTable(view) });
  }

  // Constraint-backed indexes that already exist, by oid.
  const backing = new Map<number, { table: TableData; constraint: KeyConstraint }>();
  for (const { table } of tables.values()) {
    for (const constraint of table.constraints) {
      if (isKeyConstraint(constraint) && constraint.indexOid !== undefined) {
        backing.set(constraint.indexOid, { table, constraint });
      }
    }
  }

  const linked = new Set<number>();
  for (const schema of state.schemas.values()) {
    for (const [key, index] of [...schema.indexes]) {
      const home =
        index.tableOid !== undefined
          ? tables.get(index.tableOid)
          : schema.tables.has(index.table)
            ? { schema, table: schema.tables.get(index.table)! }
            : undefined;
      const owner = index.isConstraint && index.oid !== undefined ? backing.get(index.oid) : undefined;
      // The table is gone, or the constraint this index backed was dropped.
      if (!home || (index.isConstraint && (!owner || owner.table !== home.table))) {
        schema.indexes.delete(key);
        continue;
      }
      const name = owner ? owner.constraint.name : index.name;
      const stale =
        index.oid === undefined ||
        index.tableOid !== home.table.oid ||
        index.schema !== home.schema.name ||
        index.table !== home.table.name ||
        index.name !== name ||
        key !== name ||
        (owner !== undefined && !sameKeyColumns(index, owner.constraint));
      if (!stale) {
        if (owner) linked.add(index.oid!);
        continue;
      }
      schema.indexes.delete(key);
      // A relation of that name is already in the way: PostgreSQL would have refused the statement.
      if (nameTaken(home.schema, name)) continue;
      const next: IndexMeta = {
        ...index,
        oid: index.oid ?? state.nextOid(),
        name,
        schema: home.schema.name,
        table: home.table.name,
        tableOid: home.table.oid,
        columns: owner ? keyColumns(owner.constraint) : index.columns,
      };
      if (owner) {
        next.nullsNotDistinct = owner.constraint.kind === "unique" && owner.constraint.nullsNotDistinct;
        linked.add(next.oid!);
      }
      home.schema.indexes.set(name, next);
    }
  }

  // Key constraints without an index yet: a new table, ADD CONSTRAINT, or an older snapshot.
  for (const { schema, table } of [...tables.values()]) {
    if (!table.constraints.some((c) => isKeyConstraint(c) && (c.indexOid === undefined || !linked.has(c.indexOid)))) {
      continue;
    }
    const writable = state.ensureWritableTable(table);
    for (const constraint of writable.constraints) {
      if (!isKeyConstraint(constraint)) continue;
      if (constraint.indexOid !== undefined && linked.has(constraint.indexOid)) continue;
      if (nameTaken(schema, constraint.name)) {
        delete constraint.indexOid;
        continue;
      }
      const oid = state.nextOid();
      constraint.indexOid = oid;
      schema.indexes.set(constraint.name, {
        oid,
        name: constraint.name,
        schema: schema.name,
        table: writable.name,
        tableOid: writable.oid,
        unique: true,
        columns: keyColumns(constraint),
        where: null,
        nullsNotDistinct: constraint.kind === "unique" && constraint.nullsNotDistinct,
        isConstraint: true,
        valid: true,
      });
    }
  }
}

/**
 * The index behind a key constraint is a relation named after the constraint. A name the
 * statement spelled out must be free (42P07); a generated one moves on to the next free
 * name, the way PostgreSQL picks `t_pkey1` when `t_pkey` is already a relation.
 */
export function claimConstraintIndexName(
  schema: SchemaData,
  constraint: KeyConstraint,
  explicit: boolean,
  reserved: Set<string> = new Set(),
): void {
  const used = (name: string): boolean => schema.hasRelation(name) || reserved.has(name);
  if (used(constraint.name)) {
    if (explicit) throw pgError("duplicate_table", `relation "${constraint.name}" already exists`, "42P07");
    const base = constraint.name;
    for (let suffix = 1; used(constraint.name); suffix++) constraint.name = `${base}${suffix}`;
  }
  reserved.add(constraint.name);
}

export interface FoundIndex {
  schema: SchemaData;
  index: IndexMeta;
}

/** Resolve a possibly schema-qualified index name along the search path. */
export function findIndex(state: DatabaseState, parts: readonly string[]): FoundIndex | null {
  const name = parts[parts.length - 1]!;
  const schemas = parts.length >= 2 ? [parts[parts.length - 2]!] : state.effectiveSearchPath();
  for (const schemaName of schemas) {
    const schema = state.schemas.get(schemaName);
    const index = schema?.indexes.get(name);
    if (schema && index) return { schema, index };
  }
  return null;
}

export function findIndexByOid(state: DatabaseState, oid: number): FoundIndex | null {
  for (const schema of state.schemas.values()) {
    for (const index of schema.indexes.values()) {
      if (index.oid === oid) return { schema, index };
    }
  }
  return null;
}

/** The key constraint an index backs, when it backs one. */
export function constraintOfIndex(
  state: DatabaseState,
  index: IndexMeta,
): { table: TableData; constraint: KeyConstraint } | null {
  if (!index.isConstraint) return null;
  const table = state.schemas.get(index.schema)?.tables.get(index.table);
  const constraint = table?.constraints.find((c) => isKeyConstraint(c) && c.indexOid === index.oid);
  return table && constraint && isKeyConstraint(constraint) ? { table, constraint } : null;
}

/** What kind of non-index relation `parts` names, for "is not an index" errors. */
export function otherRelationKind(
  state: DatabaseState,
  parts: readonly string[],
): "table" | "view" | "sequence" | null {
  const name = parts[parts.length - 1]!;
  const schemas = parts.length >= 2 ? [parts[parts.length - 2]!] : state.effectiveSearchPath();
  for (const schemaName of schemas) {
    const schema = state.schemas.get(schemaName);
    if (!schema) continue;
    if (schema.tables.has(name)) return "table";
    if (schema.views.has(name)) return "view";
    if (schema.sequences.has(name)) return "sequence";
  }
  return null;
}
