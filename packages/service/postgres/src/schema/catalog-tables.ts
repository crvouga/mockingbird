import type { Relation, RelColumn } from "../executor/relation.ts";
import type { EngineCtx } from "../expressions/context.ts";
import { databaseCatalogContext } from "../runtime/database-context.ts";
import { allSettings, gucBaseSetting, gucDef, gucDefaultDisplay } from "../storage/guc-catalog.ts";
import { deparseDefault } from "../sql/deparse-default.ts";
import { deparseIndex, deparseIndexExpressions, deparseIndexPredicate } from "../sql/deparse-index.ts";
import { quoteIdentifier } from "../sql/keywords.ts";
import { viewDefinition } from "../sql/viewdef.ts";
import type { DatabaseState, IndexMeta, SequenceData, TableData } from "../storage/database-state.ts";
import { UNIX_EPOCH_MICROS_FROM_PG } from "../types/datetime.ts";
import {
  type Datum,
  isArrayType,
  isCompositeType,
  isEnumType,
  makeArray,
  TYPE_OIDS,
  type TypeId,
  typeDisplayName,
  typeOid,
} from "../types/value.ts";
import { BUILTIN_NAMESPACES, builtinNamespaceOid } from "../types/regnamespace.ts";
import { setCatalogBuilder, setRegResolver } from "./catalog.ts";
import {
  actionCode,
  actionRule,
  checkClause,
  triggerAction,
  triggerCondition,
  triggerEvents,
  triggerType,
} from "./catalog-defs.ts";
import { attnum, constraintEntries, descriptions, triggerEntries } from "./catalog-entries.ts";
import {
  builtinProcs,
  regprocIn,
  regprocName,
  regprocOid,
  regtypeIn,
  regtypeName,
  regtypeOid,
  returnTypeOid,
  typeIdOid,
} from "./reg-types.ts";
import { ACCESS_METHODS, indexAttributeCount, indexMethod, isKeyConstraint } from "./index-catalog.ts";
import { extensionCatalogRelation } from "./catalog-extensions.ts";
import { catalogRelation692, extendPgClass } from "./catalog-692.ts";
import { attrdefOid, columnDefaults, systemCatalogRelation } from "./catalog-system.ts";
import { type Persistence, relPersistence } from "./persistence.ts";
import { columnStorage } from "./storage.ts";

/**
 * On-demand materialization of pg_catalog / information_schema relations from
 * DatabaseState. Only user objects are listed plus enough builtin rows
 * (pg_type, pg_proc names) for common introspection queries; contents beyond
 * that are documented divergences.
 */

type ColSpec = readonly [name: string, type: TypeId];

function rel(specs: readonly ColSpec[], rows: Datum[][], table: string): Relation {
  const columns: RelColumn[] = specs.map(([name, type]) => ({ name, type, table }));
  return { columns, rows };
}

const OWNER = "postgres";

function* allTables(state: DatabaseState): Generator<TableData> {
  for (const schema of state.schemas.values()) {
    for (const t of schema.tables.values()) yield t;
  }
}

function* allSequences(state: DatabaseState): Generator<SequenceData> {
  for (const schema of state.schemas.values()) {
    for (const s of schema.sequences.values()) yield s;
  }
}

// stable pseudo-oids for builtin namespaces
const NS_PG_CATALOG = 11;

function namespaceOid(state: DatabaseState, name: string): number {
  return builtinNamespaceOid(name) ?? state.schemas.get(name)?.oid ?? 0;
}

function attTypmod(mod: { a?: number; b?: number } | null, type: TypeId): number {
  if (!mod || mod.a === undefined) return -1;
  if (type === "numeric") return ((mod.a << 16) | (mod.b ?? 0)) + 4;
  if (type === "varchar" || type === "bpchar") return mod.a + 4;
  return mod.a;
}

function enumOid(ctx: EngineCtx, t: TypeId): number {
  if (isCompositeType(t) || (isArrayType(t) && isCompositeType(t.slice(0, -2)))) return typeIdOid(ctx.state, t);
  if (!isEnumType(t)) return typeOid(t);
  const e = ctx.state.findEnumByKey(t.slice(5));
  return e ? e.oid : 0;
}

// --- pg_catalog builders ---------------------------------------------------

function pgNamespace(state: DatabaseState): Relation {
  const rows: Datum[][] = BUILTIN_NAMESPACES.map(([name, oid]) => [oid, name, 10, null]);
  for (const s of state.schemas.values()) rows.push([s.oid, s.name, 10, null]);
  return rel(
    [
      ["oid", "oid"],
      ["nspname", "name"],
      ["nspowner", "oid"],
      ["nspacl", "text[]"],
    ],
    rows,
    "pg_namespace",
  );
}

/** position of `relam` in a pg_class row */
const RELAM = 5;

function pgClass(ctx: EngineCtx): Relation {
  const state = ctx.state;
  const rows: Datum[][] = [];
  const push = (
    oid: number,
    name: string,
    schema: string,
    kind: string,
    natts: number,
    tuples: number,
    hasindex: boolean,
    populated: boolean,
    persistence: Persistence,
  ) => {
    rows.push([
      oid,
      name,
      namespaceOid(state, schema),
      0,
      10,
      kind === "i" ? 403 : kind === "S" || kind === "v" ? 0 : 2,
      oid,
      0,
      0,
      tuples,
      0,
      0,
      hasindex,
      false,
      persistence,
      kind,
      natts,
      0,
      false,
      false,
      false,
      false,
      false,
      populated,
      kind === "r" ? "d" : "n",
      false,
      0,
      null,
      null,
      null,
    ]);
  };
  for (const schemaData of state.schemas.values()) {
    for (const t of schemaData.tables.values()) {
      const hasIndex =
        t.constraints.some((c) => c.kind === "primary_key" || c.kind === "unique") ||
        [...schemaData.indexes.values()].some((i) => i.table === t.name);
      push(t.oid, t.name, t.schema, "r", t.columns.length, t.rowCount(), hasIndex, true, relPersistence(t));
    }
    for (const v of schemaData.views.values()) {
      push(
        v.oid,
        v.name,
        v.schema,
        v.materialized ? "m" : "v",
        v.columns?.length ?? 0,
        v.matRows?.length ?? 0,
        v.materialized && [...schemaData.indexes.values()].some((i) => i.tableOid === v.oid),
        !v.materialized || v.matRows !== null,
        relPersistence(v),
      );
    }
    for (const s of schemaData.sequences.values()) {
      push(s.oid, s.name, s.schema, "S", 3, 1, false, true, relPersistence(s));
    }
    for (const i of schemaData.indexes.values()) {
      push(
        i.oid ?? 0,
        i.name,
        i.schema,
        "i",
        indexAttributeCount(i),
        0,
        false,
        true,
        // an index is as durable as the table it indexes
        relPersistence(state.schemas.get(i.schema)?.tables.get(i.table) ?? { temp: false }),
      );
      // relam: the index's own access method (push assumes btree)
      rows[rows.length - 1]![RELAM] = ACCESS_METHODS.get(indexMethod(i))?.[0] ?? 403;
    }
  }
  extendPgClass(ctx, rows);
  for (const c of ctx.state.catalogExt.composites.values()) {
    push(c.relOid, c.name, c.schema, "c", c.attributes.length, 0, false, true, "p");
    rows[rows.length - 1]![RELAM] = 0;
    rows[rows.length - 1]![3] = c.oid;
  }
  return rel(
    [
      ["oid", "oid"],
      ["relname", "name"],
      ["relnamespace", "oid"],
      ["reltype", "oid"],
      ["relowner", "oid"],
      ["relam", "oid"],
      ["relfilenode", "oid"],
      ["reltablespace", "oid"],
      ["relpages", "int4"],
      ["reltuples", "float4"],
      ["relallvisible", "int4"],
      ["reltoastrelid", "oid"],
      ["relhasindex", "bool"],
      ["relisshared", "bool"],
      ["relpersistence", "bpchar"],
      ["relkind", "bpchar"],
      ["relnatts", "int2"],
      ["relchecks", "int2"],
      ["relhasrules", "bool"],
      ["relhastriggers", "bool"],
      ["relhassubclass", "bool"],
      ["relrowsecurity", "bool"],
      ["relforcerowsecurity", "bool"],
      ["relispopulated", "bool"],
      ["relreplident", "bpchar"],
      ["relispartition", "bool"],
      ["relrewrite", "oid"],
      ["relacl", "text[]"],
      ["reloptions", "text[]"],
      ["relpartbound", "text"],
    ],
    rows,
    "pg_class",
  );
}

function pgAttribute(ctx: EngineCtx): Relation {
  const rows: Datum[][] = [];
  // atthasdef: a default expression or a stored generated column (an identity column has neither)
  const withDefault = new Set(columnDefaults(ctx).map((d) => attrdefOid(d.tableOid, d.attnum)));
  for (const t of allTables(ctx.state)) {
    t.columns.forEach((c, i) => {
      rows.push([
        t.oid,
        c.name,
        enumOid(ctx, c.type.id),
        i + 1,
        attTypmod(c.type.mod, c.type.id),
        -1,
        c.notNull,
        withDefault.has(attrdefOid(t.oid, i + 1)),
        false,
        c.identity ? (c.identity.always ? "a" : "d") : "",
        c.generated ? (c.virtual ? "v" : "s") : "",
        isArrayType(c.type.id) ? 1 : 0,
        columnStorage(c),
      ]);
    });
  }
  // a composite type's attributes belong to its pg_class entry (relkind 'c')
  for (const c of ctx.state.catalogExt.composites.values()) {
    c.attributes.forEach((a, i) => {
      rows.push([
        c.relOid,
        a.name,
        enumOid(ctx, a.type.id),
        i + 1,
        attTypmod(a.type.mod, a.type.id),
        -1,
        false,
        false,
        false,
        "",
        "",
        isArrayType(a.type.id) ? 1 : 0,
        "x",
      ]);
    });
  }
  return rel(
    [
      ["attrelid", "oid"],
      ["attname", "name"],
      ["atttypid", "oid"],
      ["attnum", "int2"],
      ["atttypmod", "int4"],
      ["attlen", "int2"],
      ["attnotnull", "bool"],
      ["atthasdef", "bool"],
      ["attisdropped", "bool"],
      ["attidentity", "bpchar"],
      ["attgenerated", "bpchar"],
      ["attndims", "int2"],
      ["attstorage", "bpchar"],
    ],
    rows,
    "pg_attribute",
  );
}

function pgType(ctx: EngineCtx): Relation {
  const rows: Datum[][] = [];
  for (const [name, oid] of Object.entries(TYPE_OIDS)) {
    const isArr = name.startsWith("_");
    rows.push([
      oid,
      name,
      NS_PG_CATALOG,
      "b",
      isArr ? "A" : "U",
      isArr ? (TYPE_OIDS[name.slice(1)] ?? 0) : 0,
      isArr ? 0 : (TYPE_OIDS[`_${name}`] ?? 0),
      0,
      0,
      -1,
    ]);
  }
  for (const schema of ctx.state.schemas.values()) {
    for (const e of schema.enums.values()) {
      rows.push([e.oid, e.name, namespaceOid(ctx.state, e.schema), "e", "E", 0, 0, 0, 0, 4]);
    }
    for (const d of schema.domains.values()) {
      rows.push([d.oid, d.name, namespaceOid(ctx.state, d.schema), "d", "S", 0, 0, typeOid(d.baseType.id), 0, -1]);
    }
  }
  for (const c of ctx.state.catalogExt.composites.values()) {
    const ns = namespaceOid(ctx.state, c.schema);
    rows.push([c.oid, c.name, ns, "c", "C", 0, c.arrayOid, 0, c.relOid, -1]);
    rows.push([c.arrayOid, `_${c.name}`, ns, "b", "A", c.oid, 0, 0, 0, -1]);
  }
  return rel(
    [
      ["oid", "oid"],
      ["typname", "name"],
      ["typnamespace", "oid"],
      ["typtype", "bpchar"],
      ["typcategory", "bpchar"],
      ["typelem", "oid"],
      ["typarray", "oid"],
      ["typbasetype", "oid"],
      ["typrelid", "oid"],
      ["typlen", "int2"],
    ],
    rows,
    "pg_type",
  );
}

const LANGUAGE_OIDS: Record<string, number> = { internal: 12, c: 13, sql: 14, plpgsql: 13534 };

function pgProc(ctx: EngineCtx): Relation {
  const rows: Datum[][] = [];
  for (const p of builtinProcs()) {
    // the engine does not model builtin signatures: no return type, argument count -1
    rows.push([p.oid, p.name, NS_PG_CATALOG, p.kind, p.retset, -1, 10, 12, 0, false, false, "v", null]);
  }
  for (const schema of ctx.state.schemas.values()) {
    for (const fns of schema.functions.values()) {
      for (const f of fns) {
        rows.push([
          f.oid,
          f.name,
          namespaceOid(ctx.state, f.schema),
          f.kind ?? "f",
          f.returnsSet,
          // a procedure's OUT parameters are in its call signature but not in pronargs
          f.argModes ? f.argModes.filter((m) => m !== "out").length : f.argTypes.length,
          10,
          LANGUAGE_OIDS[f.language] ?? 12,
          returnTypeOid(ctx.state, f),
          false,
          f.strict,
          f.volatility === "immutable" ? "i" : f.volatility === "stable" ? "s" : "v",
          f.rawBody,
        ]);
      }
    }
  }
  return rel(
    [
      ["oid", "oid"],
      ["proname", "name"],
      ["pronamespace", "oid"],
      ["prokind", "bpchar"],
      ["proretset", "bool"],
      ["pronargs", "int2"],
      ["proowner", "oid"],
      ["prolang", "oid"],
      ["prorettype", "oid"],
      ["prosecdef", "bool"],
      ["proisstrict", "bool"],
      ["provolatile", "bpchar"],
      ["prosrc", "text"],
    ],
    rows,
    "pg_proc",
  );
}

function pgEnum(ctx: EngineCtx): Relation {
  const rows: Datum[][] = [];
  let oid = 20000;
  for (const schema of ctx.state.schemas.values()) {
    for (const e of schema.enums.values()) {
      e.labels.forEach((label, i) => {
        rows.push([oid++, e.oid, i + 1, label]);
      });
    }
  }
  return rel(
    [
      ["oid", "oid"],
      ["enumtypid", "oid"],
      ["enumsortorder", "float4"],
      ["enumlabel", "name"],
    ],
    rows,
    "pg_enum",
  );
}

/** Columns a CHECK expression reads, in order of first appearance (pg_constraint.conkey). */
function referencedColumns(table: TableData, expr: unknown, out: number[] = []): number[] {
  if (Array.isArray(expr)) {
    for (const item of expr) referencedColumns(table, item, out);
  } else if (typeof expr === "object" && expr !== null) {
    const node = expr as { type?: unknown; parts?: unknown };
    if (node.type === "colref" && Array.isArray(node.parts)) {
      const n = attnum(table, String(node.parts.at(-1)));
      if (n > 0 && !out.includes(n)) out.push(n);
    }
    for (const value of Object.values(expr)) referencedColumns(table, value, out);
  }
  return out;
}

const int2Array = (items: number[]): Datum => makeArray("int2", items);

function pgConstraint(ctx: EngineCtx): Relation {
  const state = ctx.state;
  const rows: Datum[][] = [];
  for (const entry of constraintEntries(state)) {
    const t = entry.table;
    const c = entry.contype === "n" ? null : entry.constraint;
    const fk = c?.kind === "foreign_key" ? c : null;
    const refTable = fk ? state.schemas.get(fk.refSchema)?.tables.get(fk.refTable) : undefined;
    const conkey =
      entry.contype === "n"
        ? [attnum(t, entry.column)]
        : c!.kind === "check"
          ? referencedColumns(t, c!.expr)
          : c!.columns.map((name) => attnum(t, name));
    rows.push([
      entry.oid,
      entry.name,
      namespaceOid(state, t.schema),
      entry.contype,
      fk?.deferrable === true,
      fk?.deferrable === true && fk.initiallyDeferred === true,
      true,
      t.oid,
      0,
      refTable?.oid ?? 0,
      c && isKeyConstraint(c) ? (c.indexOid ?? 0) : 0,
      fk ? actionCode(fk.onUpdate) : " ",
      fk ? actionCode(fk.onDelete) : " ",
      fk ? (fk.match === "full" ? "f" : "s") : " ",
      true,
      0,
      false,
      int2Array(conkey),
      fk && refTable ? int2Array(fk.refColumns.map((name) => attnum(refTable, name))) : null,
      fk?.onDeleteColumns ? int2Array(fk.onDeleteColumns.map((name) => attnum(t, name))) : null,
      c?.kind === "check" ? checkClause(ctx, t, c.expr, false) : null,
    ]);
  }
  return rel(
    [
      ["oid", "oid"],
      ["conname", "name"],
      ["connamespace", "oid"],
      ["contype", "bpchar"],
      ["condeferrable", "bool"],
      ["condeferred", "bool"],
      ["convalidated", "bool"],
      ["conrelid", "oid"],
      ["contypid", "oid"],
      ["confrelid", "oid"],
      ["conindid", "oid"],
      ["confupdtype", "bpchar"],
      ["confdeltype", "bpchar"],
      ["confmatchtype", "bpchar"],
      ["conislocal", "bool"],
      ["coninhcount", "int2"],
      ["connoinherit", "bool"],
      ["conkey", "int2[]"],
      ["confkey", "int2[]"],
      ["confdelsetcols", "int2[]"],
      // PostgreSQL stores a pg_node_tree here; this is the text pg_get_expr() returns
      ["conbin", "text"],
    ],
    rows,
    "pg_constraint",
  );
}

/** pg_index.indkey: each key column's number (0 for an expression), then the INCLUDE columns. */
function indexKey(table: TableData | undefined, index: IndexMeta): Datum {
  const numbers = [
    ...index.columns.map((column) => (column.column !== null && table ? attnum(table, column.column) : 0)),
    ...(index.include ?? []).map((name) => (table ? attnum(table, name) : 0)),
  ];
  return makeArray("int2", numbers, [numbers.length], [0]);
}

function pgIndex(ctx: EngineCtx): Relation {
  const rows: Datum[][] = [];
  for (const schema of ctx.state.schemas.values()) {
    for (const i of schema.indexes.values()) {
      const table = schema.tables.get(i.table);
      const isPrimary =
        i.isConstraint && table?.constraints.some((c) => c.kind === "primary_key" && c.indexOid === i.oid) === true;
      // a build that did not finish is neither usable for queries nor maintained by writes
      const valid = i.valid !== false;
      rows.push([
        i.oid ?? 0,
        table?.oid ?? i.tableOid ?? 0,
        indexAttributeCount(i),
        i.columns.length,
        i.unique,
        i.nullsNotDistinct,
        isPrimary,
        false,
        true,
        false,
        valid,
        false,
        valid,
        true,
        false,
        deparseIndexExpressions(ctx, i),
        deparseIndexPredicate(ctx, i),
        indexKey(table, i),
      ]);
    }
  }
  return rel(
    [
      ["indexrelid", "oid"],
      ["indrelid", "oid"],
      ["indnatts", "int2"],
      ["indnkeyatts", "int2"],
      ["indisunique", "bool"],
      ["indnullsnotdistinct", "bool"],
      ["indisprimary", "bool"],
      ["indisexclusion", "bool"],
      ["indimmediate", "bool"],
      ["indisclustered", "bool"],
      ["indisvalid", "bool"],
      ["indcheckxmin", "bool"],
      ["indisready", "bool"],
      ["indislive", "bool"],
      ["indisreplident", "bool"],
      // PostgreSQL stores these two as pg_node_tree; here they are the text pg_get_expr() returns
      ["indexprs", "text"],
      ["indpred", "text"],
      // int2vector in PostgreSQL: here an int2 array subscripted from 0 the way int2vector is
      ["indkey", "int2[]"],
    ],
    rows,
    "pg_index",
  );
}

function pgAm(): Relation {
  return rel(
    [
      ["oid", "oid"],
      ["amname", "name"],
      ["amtype", "bpchar"],
    ],
    [...ACCESS_METHODS].map(([name, [oid, type]]) => [oid, name, type]),
    "pg_am",
  );
}

const timestamptz = (ms: number | undefined): Datum =>
  ms === undefined ? null : BigInt(Math.round(ms)) * 1000n + UNIX_EPOCH_MICROS_FROM_PG;

/**
 * pg_stat_user_tables. `n_live_tup` is the exact current row count and ANALYZE is
 * recorded; the activity counters PostgreSQL collects asynchronously (scans, tuples
 * inserted / updated / deleted, dead tuples, vacuum) are not tracked and read zero.
 */
function pgStatUserTables(ctx: EngineCtx): Relation {
  const state = ctx.state;
  const rows: Datum[][] = [];
  const push = (oid: number, schema: string, name: string, live: number, indexes: IndexMeta[]) => {
    const stats = state.tableStats.get(oid);
    const scanned = indexes.filter((index) => index.lastScan !== undefined).map((index) => index.lastScan!);
    rows.push([
      oid,
      schema,
      name,
      0n,
      null,
      0n,
      // the index columns are NULL, not zero, for a relation that has no index
      indexes.length === 0 ? null : indexes.reduce((sum, index) => sum + (index.scans ?? 0n), 0n),
      scanned.length === 0 ? null : timestamptz(Math.max(...scanned)),
      indexes.length === 0 ? null : 0n,
      0n,
      0n,
      0n,
      0n,
      0n,
      BigInt(live),
      0n,
      0n,
      0n,
      null,
      null,
      timestamptz(stats?.lastAnalyze),
      null,
      0n,
      0n,
      BigInt(stats?.analyzeCount ?? 0),
      0n,
      0,
      0,
      0,
      0,
    ]);
  };
  for (const schema of state.schemas.values()) {
    const indexes = [...schema.indexes.values()];
    for (const table of schema.tables.values()) {
      push(
        table.oid,
        table.schema,
        table.name,
        table.rowCount(),
        indexes.filter((index) => index.table === table.name),
      );
    }
    // materialized views are relations with storage, and are reported too
    for (const view of schema.views.values()) {
      if (view.materialized) push(view.oid, view.schema, view.name, view.matRows?.length ?? 0, []);
    }
  }
  return rel(
    [
      ["relid", "oid"],
      ["schemaname", "name"],
      ["relname", "name"],
      ["seq_scan", "int8"],
      ["last_seq_scan", "timestamptz"],
      ["seq_tup_read", "int8"],
      ["idx_scan", "int8"],
      ["last_idx_scan", "timestamptz"],
      ["idx_tup_fetch", "int8"],
      ["n_tup_ins", "int8"],
      ["n_tup_upd", "int8"],
      ["n_tup_del", "int8"],
      ["n_tup_hot_upd", "int8"],
      ["n_tup_newpage_upd", "int8"],
      ["n_live_tup", "int8"],
      ["n_dead_tup", "int8"],
      ["n_mod_since_analyze", "int8"],
      ["n_ins_since_vacuum", "int8"],
      ["last_vacuum", "timestamptz"],
      ["last_autovacuum", "timestamptz"],
      ["last_analyze", "timestamptz"],
      ["last_autoanalyze", "timestamptz"],
      ["vacuum_count", "int8"],
      ["autovacuum_count", "int8"],
      ["analyze_count", "int8"],
      ["autoanalyze_count", "int8"],
      ["total_vacuum_time", "float8"],
      ["total_autovacuum_time", "float8"],
      ["total_analyze_time", "float8"],
      ["total_autoanalyze_time", "float8"],
    ],
    rows,
    "pg_stat_user_tables",
  );
}

function pgDescription(ctx: EngineCtx): Relation {
  const rows: Datum[][] = descriptions(ctx.state).map((d) => [d.objoid, d.classoid, d.objsubid, d.description]);
  return rel(
    [
      ["objoid", "oid"],
      ["classoid", "oid"],
      ["objsubid", "int4"],
      ["description", "text"],
    ],
    rows,
    "pg_description",
  );
}

function pgStatUserIndexes(ctx: EngineCtx): Relation {
  const rows: Datum[][] = [];
  for (const schema of ctx.state.schemas.values()) {
    for (const index of schema.indexes.values()) {
      const table = schema.tables.get(index.table);
      rows.push([
        table?.oid ?? index.tableOid ?? 0,
        index.oid ?? 0,
        schema.name,
        index.table,
        index.name,
        index.scans ?? 0n,
        timestamptz(index.lastScan),
        0n,
        0n,
      ]);
    }
  }
  return rel(
    [
      ["relid", "oid"],
      ["indexrelid", "oid"],
      ["schemaname", "name"],
      ["relname", "name"],
      ["indexrelname", "name"],
      ["idx_scan", "int8"],
      ["last_idx_scan", "timestamptz"],
      ["idx_tup_read", "int8"],
      ["idx_tup_fetch", "int8"],
    ],
    rows,
    "pg_stat_user_indexes",
  );
}

function pgSequence(ctx: EngineCtx): Relation {
  const rows: Datum[][] = [];
  for (const s of allSequences(ctx.state)) {
    rows.push([s.oid, typeOid(s.dataType), s.startValue, s.increment, s.maxValue, s.minValue, s.cache, s.cycle]);
  }
  return rel(
    [
      ["seqrelid", "oid"],
      ["seqtypid", "oid"],
      ["seqstart", "int8"],
      ["seqincrement", "int8"],
      ["seqmax", "int8"],
      ["seqmin", "int8"],
      ["seqcache", "int8"],
      ["seqcycle", "bool"],
    ],
    rows,
    "pg_sequence",
  );
}

function pgSequencesView(ctx: EngineCtx): Relation {
  const rows: Datum[][] = [];
  for (const s of allSequences(ctx.state)) {
    rows.push([
      s.schema,
      s.name,
      OWNER,
      typeDisplayName(s.dataType),
      s.startValue,
      s.minValue,
      s.maxValue,
      s.increment,
      s.cycle,
      s.cache,
      s.isCalled ? s.lastValue : null,
    ]);
  }
  return rel(
    [
      ["schemaname", "name"],
      ["sequencename", "name"],
      ["sequenceowner", "name"],
      ["data_type", "text"],
      ["start_value", "int8"],
      ["min_value", "int8"],
      ["max_value", "int8"],
      ["increment_by", "int8"],
      ["cycle", "bool"],
      ["cache_size", "int8"],
      ["last_value", "int8"],
    ],
    rows,
    "pg_sequences",
  );
}

function pgTables(ctx: EngineCtx): Relation {
  const rows: Datum[][] = [];
  for (const t of allTables(ctx.state)) {
    const hasIndexes =
      t.constraints.some((c) => c.kind === "primary_key" || c.kind === "unique") ||
      [...(ctx.state.schemas.get(t.schema)?.indexes.values() ?? [])].some((i) => i.table === t.name);
    rows.push([t.schema, t.name, OWNER, null, hasIndexes, false, t.triggers.length > 0, false]);
  }
  return rel(
    [
      ["schemaname", "name"],
      ["tablename", "name"],
      ["tableowner", "name"],
      ["tablespace", "name"],
      ["hasindexes", "bool"],
      ["hasrules", "bool"],
      ["hastriggers", "bool"],
      ["rowsecurity", "bool"],
    ],
    rows,
    "pg_tables",
  );
}

function pgViews(ctx: EngineCtx, materialized: boolean): Relation {
  const rows: Datum[][] = [];
  for (const schema of ctx.state.schemas.values()) {
    for (const v of schema.views.values()) {
      if (v.materialized !== materialized) continue;
      const definition = viewDefinition(ctx, v);
      if (materialized) rows.push([v.schema, v.name, OWNER, null, v.matRows !== null, definition]);
      else rows.push([v.schema, v.name, OWNER, definition]);
    }
  }
  if (materialized) {
    return rel(
      [
        ["schemaname", "name"],
        ["matviewname", "name"],
        ["matviewowner", "name"],
        ["tablespace", "name"],
        ["ispopulated", "bool"],
        ["definition", "text"],
      ],
      rows,
      "pg_matviews",
    );
  }
  return rel(
    [
      ["schemaname", "name"],
      ["viewname", "name"],
      ["viewowner", "name"],
      ["definition", "text"],
    ],
    rows,
    "pg_views",
  );
}

function pgIndexesView(ctx: EngineCtx): Relation {
  const rows: Datum[][] = [];
  for (const schema of ctx.state.schemas.values()) {
    for (const i of schema.indexes.values()) {
      rows.push([i.schema, i.table, i.name, null, deparseIndex(ctx, i)]);
    }
  }
  return rel(
    [
      ["schemaname", "name"],
      ["tablename", "name"],
      ["indexname", "name"],
      ["tablespace", "name"],
      ["indexdef", "text"],
    ],
    rows,
    "pg_indexes",
  );
}

function pgSettings(ctx: EngineCtx): Relation {
  const state = ctx.state;
  const rows: Datum[][] = [];
  for (const { key, name, value } of allSettings(state)) {
    const def = gucDef(key);
    if (!def) {
      // a custom (dotted) parameter: a placeholder string
      rows.push([name, value, null, "Customized Options", null, null, "user", "string", "session"]);
      rows[rows.length - 1]!.push(null, null, null, null, null, null, null, false);
      continue;
    }
    const defaultShown = gucDefaultDisplay(def);
    const reset = state.settingDefaults?.get(key);
    const source =
      state.localSettings.has(key) || (state.settings.has(key) && value !== (reset ?? defaultShown))
        ? "session"
        : reset !== undefined && reset !== defaultShown
          ? "client"
          : def.source;
    rows.push([
      def.name,
      gucBaseSetting(def, value),
      def.unit,
      def.category,
      def.shortDesc,
      null,
      def.context,
      def.vartype,
      source,
      def.min,
      def.max,
      def.enumvals ? makeArray("text", [...def.enumvals]) : null,
      def.bootVal,
      gucBaseSetting(def, reset ?? defaultShown),
      null,
      null,
      false,
    ]);
  }
  return rel(
    [
      ["name", "text"],
      ["setting", "text"],
      ["unit", "text"],
      ["category", "text"],
      ["short_desc", "text"],
      ["extra_desc", "text"],
      ["context", "text"],
      ["vartype", "text"],
      ["source", "text"],
      ["min_val", "text"],
      ["max_val", "text"],
      ["enumvals", "text[]"],
      ["boot_val", "text"],
      ["reset_val", "text"],
      ["sourcefile", "text"],
      ["sourceline", "int4"],
      ["pending_restart", "bool"],
    ],
    rows,
    "pg_settings",
  );
}

function pgDatabase(ctx: EngineCtx): Relation {
  const names = databaseCatalogContext(ctx.state).names();
  return rel(
    [
      ["oid", "oid"],
      ["datname", "name"],
      ["datdba", "oid"],
      ["encoding", "int4"],
      ["datlocprovider", "bpchar"],
      ["datistemplate", "bool"],
      ["datallowconn", "bool"],
      ["dathasloginevt", "bool"],
      ["datconnlimit", "int4"],
      ["datfrozenxid", "xid"],
      ["datminmxid", "xid"],
      ["dattablespace", "oid"],
      ["datcollate", "text"],
      ["datctype", "text"],
      ["datlocale", "text"],
      ["daticurules", "text"],
      ["datcollversion", "text"],
      ["datacl", "text[]"],
    ],
    // the engine compares and classifies text in the C locale
    names.map((name, index) => [
      5 + index,
      name,
      10,
      6,
      "c",
      false,
      true,
      false,
      -1,
      1,
      1,
      1663,
      "C",
      "C",
      null,
      null,
      null,
      null,
    ]),
    "pg_database",
  );
}

function pgRoles(): Relation {
  return rel(
    [
      ["oid", "oid"],
      ["rolname", "name"],
      ["rolsuper", "bool"],
      ["rolcanlogin", "bool"],
    ],
    [[10, OWNER, true, true]],
    "pg_roles",
  );
}

function pgTrigger(ctx: EngineCtx): Relation {
  const rows: Datum[][] = [];
  for (const { oid, table, trigger } of triggerEntries(ctx.state)) {
    const fn = ctx.state.schemas.get(trigger.funcSchema)?.functions.get(trigger.funcName)?.[0];
    const updateColumns = trigger.events.find((e) => e.event === "update")?.columns ?? [];
    rows.push([
      oid,
      table.oid,
      0,
      trigger.name,
      fn?.oid ?? 0,
      triggerType(trigger),
      "O",
      false,
      0,
      0,
      0,
      trigger.deferrable === true,
      trigger.initiallyDeferred === true,
      trigger.funcArgs.length,
      makeArray(
        "int2",
        updateColumns.map((name) => attnum(table, name)),
        [updateColumns.length],
        [0],
      ),
      trigger.oldTable ?? null,
      trigger.newTable ?? null,
    ]);
  }
  return rel(
    [
      ["oid", "oid"],
      ["tgrelid", "oid"],
      ["tgparentid", "oid"],
      ["tgname", "name"],
      ["tgfoid", "oid"],
      ["tgtype", "int2"],
      ["tgenabled", "bpchar"],
      // only user triggers are listed: foreign keys are enforced without RI triggers
      ["tgisinternal", "bool"],
      ["tgconstrrelid", "oid"],
      ["tgconstrindid", "oid"],
      ["tgconstraint", "oid"],
      ["tgdeferrable", "bool"],
      ["tginitdeferred", "bool"],
      ["tgnargs", "int2"],
      ["tgattr", "int2[]"],
      ["tgoldtable", "name"],
      ["tgnewtable", "name"],
    ],
    rows,
    "pg_trigger",
  );
}

// --- information_schema builders -------------------------------------------

const catalogName = (state: DatabaseState): string => databaseCatalogContext(state).name;

function infoSchemata(state: DatabaseState): Relation {
  const catalog = catalogName(state);
  const rows: Datum[][] = [
    [catalog, "pg_catalog", OWNER],
    [catalog, "information_schema", OWNER],
  ];
  for (const s of state.schemas.values()) rows.push([catalog, s.name, OWNER]);
  return rel(
    [
      ["catalog_name", "name"],
      ["schema_name", "name"],
      ["schema_owner", "name"],
    ],
    rows,
    "schemata",
  );
}

function infoTables(ctx: EngineCtx): Relation {
  const catalog = catalogName(ctx.state);
  const rows: Datum[][] = [];
  for (const schema of ctx.state.schemas.values()) {
    for (const t of schema.tables.values()) {
      rows.push([catalog, t.schema, t.name, t.temp ? "LOCAL TEMPORARY" : "BASE TABLE", "YES"]);
    }
    for (const v of schema.views.values()) {
      if (!v.materialized) rows.push([catalog, v.schema, v.name, "VIEW", "NO"]);
    }
  }
  return rel(
    [
      ["table_catalog", "name"],
      ["table_schema", "name"],
      ["table_name", "name"],
      ["table_type", "text"],
      ["is_insertable_into", "text"],
    ],
    rows,
    "tables",
  );
}

function infoColumns(ctx: EngineCtx): Relation {
  const catalog = catalogName(ctx.state);
  const rows: Datum[][] = [];
  for (const t of allTables(ctx.state)) {
    t.columns.forEach((c, i) => {
      const id = c.type.id;
      const isNumeric = id === "numeric";
      const isIntish = id === "int2" || id === "int4" || id === "int8";
      const charMax = (id === "varchar" || id === "bpchar") && c.type.mod?.a !== undefined ? c.type.mod.a : null;
      const dataType = isArrayType(id) ? "ARRAY" : isEnumType(id) ? "USER-DEFINED" : typeDisplayName(id);
      const udt = isArrayType(id) ? `_${arrayUdt(id)}` : isEnumType(id) ? id.slice(5).split(".").pop()! : id;
      rows.push([
        catalog,
        t.schema,
        t.name,
        c.name,
        i + 1,
        c.defaultExpr ? deparseDefault(ctx, c.defaultExpr, c.type) : null,
        c.notNull ? "NO" : "YES",
        dataType,
        charMax,
        isNumeric ? (c.type.mod?.a ?? null) : isIntish ? (id === "int2" ? 16 : id === "int4" ? 32 : 64) : null,
        isNumeric ? (c.type.mod?.b ?? null) : isIntish ? 0 : null,
        udt,
        c.identity ? "YES" : "NO",
        c.generated ? "ALWAYS" : "NEVER",
        "YES",
      ]);
    });
  }
  return rel(
    [
      ["table_catalog", "name"],
      ["table_schema", "name"],
      ["table_name", "name"],
      ["column_name", "name"],
      ["ordinal_position", "int4"],
      ["column_default", "text"],
      ["is_nullable", "text"],
      ["data_type", "text"],
      ["character_maximum_length", "int4"],
      ["numeric_precision", "int4"],
      ["numeric_scale", "int4"],
      ["udt_name", "name"],
      ["is_identity", "text"],
      ["is_generated", "text"],
      ["is_updatable", "text"],
    ],
    rows,
    "columns",
  );
}

function arrayUdt(t: TypeId): string {
  const elem = t.slice(0, -2);
  return isEnumType(elem) ? elem.slice(5).split(".").pop()! : elem;
}

function infoViews(ctx: EngineCtx): Relation {
  const catalog = catalogName(ctx.state);
  const rows: Datum[][] = [];
  for (const schema of ctx.state.schemas.values()) {
    for (const v of schema.views.values()) {
      if (!v.materialized) rows.push([catalog, v.schema, v.name, viewDefinition(ctx, v)]);
    }
  }
  return rel(
    [
      ["table_catalog", "name"],
      ["table_schema", "name"],
      ["table_name", "name"],
      ["view_definition", "text"],
    ],
    rows,
    "views",
  );
}

function infoSequences(ctx: EngineCtx): Relation {
  const catalog = catalogName(ctx.state);
  const rows: Datum[][] = [];
  for (const s of allSequences(ctx.state)) {
    rows.push([
      catalog,
      s.schema,
      s.name,
      typeDisplayName(s.dataType),
      String(s.startValue),
      String(s.minValue),
      String(s.maxValue),
      String(s.increment),
      s.cycle ? "YES" : "NO",
    ]);
  }
  return rel(
    [
      ["sequence_catalog", "name"],
      ["sequence_schema", "name"],
      ["sequence_name", "name"],
      ["data_type", "text"],
      ["start_value", "text"],
      ["minimum_value", "text"],
      ["maximum_value", "text"],
      ["increment", "text"],
      ["cycle_option", "text"],
    ],
    rows,
    "sequences",
  );
}

function infoTableConstraints(ctx: EngineCtx): Relation {
  const catalog = catalogName(ctx.state);
  const rows: Datum[][] = [];
  for (const entry of constraintEntries(ctx.state)) {
    const t = entry.table;
    const c = entry.contype === "n" ? null : entry.constraint;
    // PostgreSQL 18 lists each NOT NULL constraint as a CHECK
    const type =
      entry.contype === "p"
        ? "PRIMARY KEY"
        : entry.contype === "u"
          ? "UNIQUE"
          : entry.contype === "f"
            ? "FOREIGN KEY"
            : "CHECK";
    const deferrable = c?.kind === "foreign_key" && c.deferrable === true;
    const deferred = deferrable && c?.kind === "foreign_key" && c.initiallyDeferred === true;
    const nullsDistinct = c?.kind === "unique" ? (c.nullsNotDistinct ? "NO" : "YES") : null;
    rows.push([
      catalog,
      t.schema,
      entry.name,
      catalog,
      t.schema,
      t.name,
      type,
      deferrable ? "YES" : "NO",
      deferred ? "YES" : "NO",
      "YES",
      nullsDistinct,
    ]);
  }
  return rel(
    [
      ["constraint_catalog", "name"],
      ["constraint_schema", "name"],
      ["constraint_name", "name"],
      ["table_catalog", "name"],
      ["table_schema", "name"],
      ["table_name", "name"],
      ["constraint_type", "text"],
      ["is_deferrable", "text"],
      ["initially_deferred", "text"],
      ["enforced", "text"],
      ["nulls_distinct", "text"],
    ],
    rows,
    "table_constraints",
  );
}

/** information_schema.constraint_column_usage: the columns each constraint uses (a foreign key's referenced ones). */
function infoConstraintColumnUsage(ctx: EngineCtx): Relation {
  const catalog = catalogName(ctx.state);
  const rows: Datum[][] = [];
  for (const entry of constraintEntries(ctx.state)) {
    const t = entry.table;
    const push = (schema: string, table: string, column: string) =>
      rows.push([catalog, schema, table, column, catalog, t.schema, entry.name]);
    if (entry.contype === "n") {
      push(t.schema, t.name, entry.column);
      continue;
    }
    const c = entry.constraint;
    if (c.kind === "foreign_key") {
      for (const column of c.refColumns) push(c.refSchema, c.refTable, column);
    } else if (c.kind === "check") {
      for (const n of referencedColumns(t, c.expr)) push(t.schema, t.name, t.columns[n - 1]!.name);
    } else {
      for (const column of c.columns) push(t.schema, t.name, column);
    }
  }
  return rel(
    [
      ["table_catalog", "name"],
      ["table_schema", "name"],
      ["table_name", "name"],
      ["column_name", "name"],
      ["constraint_catalog", "name"],
      ["constraint_schema", "name"],
      ["constraint_name", "name"],
    ],
    rows,
    "constraint_column_usage",
  );
}

/** information_schema.referential_constraints: each foreign key, the key it references and its rules. */
function infoReferentialConstraints(ctx: EngineCtx): Relation {
  const catalog = catalogName(ctx.state);
  const rows: Datum[][] = [];
  for (const entry of constraintEntries(ctx.state)) {
    if (entry.contype !== "f" || entry.constraint.kind !== "foreign_key") continue;
    const fk = entry.constraint;
    const refTable = ctx.state.schemas.get(fk.refSchema)?.tables.get(fk.refTable);
    const wanted = [...fk.refColumns].sort().join("\0");
    const key = refTable?.constraints.find(
      (c) => (c.kind === "primary_key" || c.kind === "unique") && [...c.columns].sort().join("\0") === wanted,
    );
    rows.push([
      catalog,
      entry.table.schema,
      entry.name,
      key ? catalog : null,
      key ? fk.refSchema : null,
      key?.name ?? null,
      fk.match === "full" ? "FULL" : "NONE",
      actionRule(fk.onUpdate),
      actionRule(fk.onDelete),
    ]);
  }
  return rel(
    [
      ["constraint_catalog", "name"],
      ["constraint_schema", "name"],
      ["constraint_name", "name"],
      ["unique_constraint_catalog", "name"],
      ["unique_constraint_schema", "name"],
      ["unique_constraint_name", "name"],
      ["match_option", "text"],
      ["update_rule", "text"],
      ["delete_rule", "text"],
    ],
    rows,
    "referential_constraints",
  );
}

/** information_schema.check_constraints: CHECK constraints and, as PostgreSQL 18 lists them, NOT NULLs. */
function infoCheckConstraints(ctx: EngineCtx): Relation {
  const catalog = catalogName(ctx.state);
  const rows: Datum[][] = [];
  for (const entry of constraintEntries(ctx.state)) {
    if (entry.contype === "n") {
      rows.push([catalog, entry.table.schema, entry.name, `${quoteIdentifier(entry.column)} IS NOT NULL`]);
    } else if (entry.constraint.kind === "check") {
      rows.push([catalog, entry.table.schema, entry.name, checkClause(ctx, entry.table, entry.constraint.expr, false)]);
    }
  }
  return rel(
    [
      ["constraint_catalog", "name"],
      ["constraint_schema", "name"],
      ["constraint_name", "name"],
      ["check_clause", "text"],
    ],
    rows,
    "check_constraints",
  );
}

/** information_schema.triggers: one row per trigger and event. */
function infoTriggers(ctx: EngineCtx): Relation {
  const catalog = catalogName(ctx.state);
  const rows: Datum[][] = [];
  const entries = triggerEntries(ctx.state);
  for (const { table, trigger } of entries) {
    const timing = trigger.timing === "instead_of" ? "INSTEAD OF" : trigger.timing.toUpperCase();
    for (const { event } of triggerEvents(trigger)) {
      // action_order: rank among the table's triggers for the same event, timing and level, by name
      const order =
        1 +
        entries.filter(
          (other) =>
            other.table === table &&
            other.trigger.timing === trigger.timing &&
            other.trigger.forEachRow === trigger.forEachRow &&
            other.trigger.events.some((e) => e.event.toUpperCase() === event) &&
            other.trigger.name < trigger.name,
        ).length;
      rows.push([
        catalog,
        table.schema,
        trigger.name,
        event,
        catalog,
        table.schema,
        table.name,
        order,
        triggerCondition(ctx, table, trigger, false),
        triggerAction(ctx.state, trigger),
        trigger.forEachRow ? "ROW" : "STATEMENT",
        timing,
        trigger.oldTable ?? null,
        trigger.newTable ?? null,
        null,
        null,
        null,
      ]);
    }
  }
  return rel(
    [
      ["trigger_catalog", "name"],
      ["trigger_schema", "name"],
      ["trigger_name", "name"],
      ["event_manipulation", "text"],
      ["event_object_catalog", "name"],
      ["event_object_schema", "name"],
      ["event_object_table", "name"],
      ["action_order", "int4"],
      ["action_condition", "text"],
      ["action_statement", "text"],
      ["action_orientation", "text"],
      ["action_timing", "text"],
      ["action_reference_old_table", "name"],
      ["action_reference_new_table", "name"],
      ["action_reference_old_row", "name"],
      ["action_reference_new_row", "name"],
      ["created", "timestamptz"],
    ],
    rows,
    "triggers",
  );
}

function infoKeyColumnUsage(ctx: EngineCtx): Relation {
  const catalog = catalogName(ctx.state);
  const rows: Datum[][] = [];
  for (const t of allTables(ctx.state)) {
    for (const c of t.constraints) {
      if (c.kind !== "primary_key" && c.kind !== "unique" && c.kind !== "foreign_key") continue;
      c.columns.forEach((col, i) => {
        rows.push([catalog, t.schema, c.name, catalog, t.schema, t.name, col, i + 1]);
      });
    }
  }
  return rel(
    [
      ["constraint_catalog", "name"],
      ["constraint_schema", "name"],
      ["constraint_name", "name"],
      ["table_catalog", "name"],
      ["table_schema", "name"],
      ["table_name", "name"],
      ["column_name", "name"],
      ["ordinal_position", "int4"],
    ],
    rows,
    "key_column_usage",
  );
}

function infoRoutines(ctx: EngineCtx): Relation {
  const catalog = catalogName(ctx.state);
  const rows: Datum[][] = [];
  for (const schema of ctx.state.schemas.values()) {
    for (const fns of schema.functions.values()) {
      for (const f of fns) {
        rows.push([
          catalog,
          f.schema,
          f.name,
          "FUNCTION",
          f.returns ? typeDisplayName(f.returns) : null,
          f.language.toUpperCase(),
        ]);
      }
    }
  }
  return rel(
    [
      ["routine_catalog", "name"],
      ["routine_schema", "name"],
      ["routine_name", "name"],
      ["routine_type", "text"],
      ["data_type", "text"],
      ["external_language", "text"],
    ],
    rows,
    "routines",
  );
}

// --- dispatch ----------------------------------------------------------------

function buildCatalogRelation(ctx: EngineCtx, schema: string, name: string): Relation | null {
  const extended = catalogRelation692(ctx, schema, name);
  if (extended) return extended;
  if (schema === "pg_catalog") {
    switch (name) {
      case "pg_namespace":
        return pgNamespace(ctx.state);
      case "pg_class":
        return pgClass(ctx);
      case "pg_attribute":
        return pgAttribute(ctx);
      case "pg_type":
        return pgType(ctx);
      case "pg_proc":
        return pgProc(ctx);
      case "pg_enum":
        return pgEnum(ctx);
      case "pg_constraint":
        return pgConstraint(ctx);
      case "pg_index":
        return pgIndex(ctx);
      case "pg_am":
        return pgAm();
      case "pg_description":
        return pgDescription(ctx);
      case "pg_stat_user_tables":
        return pgStatUserTables(ctx);
      case "pg_stat_user_indexes":
        return pgStatUserIndexes(ctx);
      case "pg_sequence":
        return pgSequence(ctx);
      case "pg_sequences":
        return pgSequencesView(ctx);
      case "pg_tables":
        return pgTables(ctx);
      case "pg_views":
        return pgViews(ctx, false);
      case "pg_matviews":
        return pgViews(ctx, true);
      case "pg_indexes":
        return pgIndexesView(ctx);
      case "pg_settings":
        return pgSettings(ctx);
      case "pg_database":
        return pgDatabase(ctx);
      case "pg_roles":
      case "pg_user":
        return pgRoles();
      case "pg_trigger":
        return pgTrigger(ctx);
      default:
        return (
          systemCatalogRelation(ctx, name) ??
          extensionCatalogRelation(ctx.state, name, (ns) => namespaceOid(ctx.state, ns))
        );
    }
  }
  switch (name) {
    case "schemata":
      return infoSchemata(ctx.state);
    case "tables":
      return infoTables(ctx);
    case "columns":
      return infoColumns(ctx);
    case "views":
      return infoViews(ctx);
    case "sequences":
      return infoSequences(ctx);
    case "table_constraints":
      return infoTableConstraints(ctx);
    case "key_column_usage":
      return infoKeyColumnUsage(ctx);
    case "routines":
      return infoRoutines(ctx);
    case "triggers":
      return infoTriggers(ctx);
    case "constraint_column_usage":
      return infoConstraintColumnUsage(ctx);
    case "referential_constraints":
      return infoReferentialConstraints(ctx);
    case "check_constraints":
      return infoCheckConstraints(ctx);
    default:
      return null;
  }
}

setCatalogBuilder(buildCatalogRelation);
setRegResolver({
  typeIn: regtypeIn,
  procIn: regprocIn,
  oid: (state, t, name) => (t === "regtype" ? regtypeOid(state, name) : regprocOid(state, name)),
  name: (state, t, oid) => (t === "regtype" ? regtypeName(state, oid) : regprocName(state, oid)),
});
