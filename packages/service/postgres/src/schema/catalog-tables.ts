import type { Relation, RelColumn } from "../executor/relation.ts";
import type { EngineCtx } from "../expressions/context.ts";
import { getAggregateFactories } from "../functions/aggregates.ts";
import { getScalarFunctions } from "../functions/scalar.ts";
import { getSrfFunctions } from "../functions/srf.ts";
import { WINDOW_FUNCTION_NAMES } from "../functions/window.ts";
import type { DatabaseState, SequenceData, TableData } from "../storage/database-state.ts";
import {
  type Datum,
  isArrayType,
  isEnumType,
  TYPE_OIDS,
  type TypeId,
  typeDisplayName,
  typeOid,
} from "../types/value.ts";
import { setCatalogBuilder } from "./catalog.ts";

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
const NS_INFORMATION_SCHEMA = 13212;

function namespaceOid(state: DatabaseState, name: string): number {
  if (name === "pg_catalog") return NS_PG_CATALOG;
  if (name === "information_schema") return NS_INFORMATION_SCHEMA;
  return state.schemas.get(name)?.oid ?? 0;
}

function attTypmod(mod: { a?: number; b?: number } | null, type: TypeId): number {
  if (!mod || mod.a === undefined) return -1;
  if (type === "numeric") return ((mod.a << 16) | (mod.b ?? 0)) + 4;
  if (type === "varchar" || type === "bpchar") return mod.a + 4;
  return mod.a;
}

function enumOid(ctx: EngineCtx, t: TypeId): number {
  if (!isEnumType(t)) return typeOid(t);
  const e = ctx.state.findEnumByKey(t.slice(5));
  return e ? e.oid : 0;
}

// --- pg_catalog builders ---------------------------------------------------

function pgNamespace(state: DatabaseState): Relation {
  const rows: Datum[][] = [
    [NS_PG_CATALOG, "pg_catalog", 10, null],
    [NS_INFORMATION_SCHEMA, "information_schema", 10, null],
  ];
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
    temp: boolean,
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
      temp ? "t" : "p",
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
      push(t.oid, t.name, t.schema, "r", t.columns.length, t.rowCount(), hasIndex, true, t.temp);
    }
    for (const v of schemaData.views.values()) {
      push(
        v.oid,
        v.name,
        v.schema,
        v.materialized ? "m" : "v",
        v.columns?.length ?? 0,
        v.matRows?.length ?? 0,
        false,
        !v.materialized || v.matRows !== null,
        v.temp,
      );
    }
    for (const s of schemaData.sequences.values()) push(s.oid, s.name, s.schema, "S", 3, 1, false, true, s.temp);
    for (const i of schemaData.indexes.values()) {
      push(
        state.schemas.get(i.schema)?.tables.get(i.table)?.oid ?? 0,
        i.name,
        i.schema,
        "i",
        i.columns.length,
        0,
        false,
        true,
        false,
      );
    }
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
        c.defaultExpr !== null || c.identity !== null,
        false,
        c.identity ? (c.identity.always ? "a" : "d") : "",
        c.generated ? "s" : "",
        isArrayType(c.type.id) ? 1 : 0,
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

function pgProc(ctx: EngineCtx): Relation {
  const rows: Datum[][] = [];
  let oid = 1000;
  const seen = new Set<string>();
  const push = (name: string, ns: number, kind: string, retset: boolean, nargs: number, realOid?: number) => {
    rows.push([realOid ?? oid++, name, ns, kind, retset, nargs]);
  };
  for (const name of getScalarFunctions().keys()) {
    if (!seen.has(name)) {
      seen.add(name);
      push(name, NS_PG_CATALOG, "f", false, -1);
    }
  }
  for (const name of Object.keys(getAggregateFactories())) {
    if (!seen.has(`agg:${name}`)) {
      seen.add(`agg:${name}`);
      push(name, NS_PG_CATALOG, "a", false, -1);
    }
  }
  for (const name of WINDOW_FUNCTION_NAMES) push(name, NS_PG_CATALOG, "w", false, -1);
  for (const name of getSrfFunctions().keys()) push(name, NS_PG_CATALOG, "f", true, -1);
  for (const schema of ctx.state.schemas.values()) {
    for (const fns of schema.functions.values()) {
      for (const f of fns) {
        push(f.name, namespaceOid(ctx.state, f.schema), "f", f.returnsSet, f.argTypes.length, f.oid);
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

function pgConstraint(ctx: EngineCtx): Relation {
  const rows: Datum[][] = [];
  let oid = 30000;
  for (const t of allTables(ctx.state)) {
    for (const c of t.constraints) {
      const contype = c.kind === "primary_key" ? "p" : c.kind === "unique" ? "u" : c.kind === "check" ? "c" : "f";
      const refTable =
        c.kind === "foreign_key" ? ctx.state.schemas.get(c.refSchema)?.tables.get(c.refTable) : undefined;
      rows.push([oid++, c.name, namespaceOid(ctx.state, t.schema), contype, false, false, t.oid, refTable?.oid ?? 0]);
    }
    for (const col of t.columns) {
      if (col.notNull) {
        rows.push([
          oid++,
          `${t.name}_${col.name}_not_null`,
          namespaceOid(ctx.state, t.schema),
          "n",
          false,
          false,
          t.oid,
          0,
        ]);
      }
    }
  }
  return rel(
    [
      ["oid", "oid"],
      ["conname", "name"],
      ["connamespace", "oid"],
      ["contype", "bpchar"],
      ["condeferrable", "bool"],
      ["condeferred", "bool"],
      ["conrelid", "oid"],
      ["confrelid", "oid"],
    ],
    rows,
    "pg_constraint",
  );
}

function pgIndex(ctx: EngineCtx): Relation {
  const rows: Datum[][] = [];
  for (const schema of ctx.state.schemas.values()) {
    for (const i of schema.indexes.values()) {
      const table = schema.tables.get(i.table);
      const isPrimary =
        i.isConstraint && table?.constraints.some((c) => c.kind === "primary_key" && c.name === i.name) === true;
      rows.push([table?.oid ?? 0, table?.oid ?? 0, i.columns.length, i.unique, isPrimary, i.where !== null]);
    }
  }
  return rel(
    [
      ["indexrelid", "oid"],
      ["indrelid", "oid"],
      ["indnatts", "int2"],
      ["indisunique", "bool"],
      ["indisprimary", "bool"],
      ["indpred", "bool"],
    ],
    rows,
    "pg_index",
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
      if (materialized) rows.push([v.schema, v.name, OWNER, null, v.matRows !== null, null]);
      else rows.push([v.schema, v.name, OWNER, null]);
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
      rows.push([i.schema, i.table, i.name, null, null]);
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
  const rows: Datum[][] = [];
  const keys = new Set([...ctx.state.settings.keys(), ...ctx.state.localSettings.keys()]);
  for (const name of [...keys].sort()) {
    rows.push([name, ctx.state.getSetting(name) ?? null]);
  }
  return rel(
    [
      ["name", "text"],
      ["setting", "text"],
    ],
    rows,
    "pg_settings",
  );
}

function pgDatabase(): Relation {
  return rel(
    [
      ["oid", "oid"],
      ["datname", "name"],
      ["encoding", "int4"],
      ["datistemplate", "bool"],
      ["datallowconn", "bool"],
    ],
    [[5, "postgres", 6, false, true]],
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
  let oid = 40000;
  for (const t of allTables(ctx.state)) {
    for (const tr of t.triggers) {
      rows.push([oid++, tr.name, t.oid, !tr.forEachRow]);
    }
  }
  return rel(
    [
      ["oid", "oid"],
      ["tgname", "name"],
      ["tgrelid", "oid"],
      ["tgisinternal", "bool"],
    ],
    rows,
    "pg_trigger",
  );
}

// --- information_schema builders -------------------------------------------

const CATALOG_NAME = "postgres";

function infoSchemata(state: DatabaseState): Relation {
  const rows: Datum[][] = [
    [CATALOG_NAME, "pg_catalog", OWNER],
    [CATALOG_NAME, "information_schema", OWNER],
  ];
  for (const s of state.schemas.values()) rows.push([CATALOG_NAME, s.name, OWNER]);
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
  const rows: Datum[][] = [];
  for (const schema of ctx.state.schemas.values()) {
    for (const t of schema.tables.values()) {
      rows.push([CATALOG_NAME, t.schema, t.name, t.temp ? "LOCAL TEMPORARY" : "BASE TABLE", "YES"]);
    }
    for (const v of schema.views.values()) {
      if (!v.materialized) rows.push([CATALOG_NAME, v.schema, v.name, "VIEW", "NO"]);
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
        CATALOG_NAME,
        t.schema,
        t.name,
        c.name,
        i + 1,
        null,
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
  const rows: Datum[][] = [];
  for (const schema of ctx.state.schemas.values()) {
    for (const v of schema.views.values()) {
      if (!v.materialized) rows.push([CATALOG_NAME, v.schema, v.name, null]);
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
  const rows: Datum[][] = [];
  for (const s of allSequences(ctx.state)) {
    rows.push([
      CATALOG_NAME,
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
  const rows: Datum[][] = [];
  for (const t of allTables(ctx.state)) {
    for (const c of t.constraints) {
      const type =
        c.kind === "primary_key"
          ? "PRIMARY KEY"
          : c.kind === "unique"
            ? "UNIQUE"
            : c.kind === "check"
              ? "CHECK"
              : "FOREIGN KEY";
      rows.push([CATALOG_NAME, t.schema, c.name, CATALOG_NAME, t.schema, t.name, type]);
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
      ["constraint_type", "text"],
    ],
    rows,
    "table_constraints",
  );
}

function infoKeyColumnUsage(ctx: EngineCtx): Relation {
  const rows: Datum[][] = [];
  for (const t of allTables(ctx.state)) {
    for (const c of t.constraints) {
      if (c.kind !== "primary_key" && c.kind !== "unique" && c.kind !== "foreign_key") continue;
      c.columns.forEach((col, i) => {
        rows.push([CATALOG_NAME, t.schema, c.name, CATALOG_NAME, t.schema, t.name, col, i + 1]);
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
  const rows: Datum[][] = [];
  for (const schema of ctx.state.schemas.values()) {
    for (const fns of schema.functions.values()) {
      for (const f of fns) {
        rows.push([
          CATALOG_NAME,
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
        return pgDatabase();
      case "pg_roles":
      case "pg_user":
        return pgRoles();
      case "pg_trigger":
        return pgTrigger(ctx);
      default:
        return null;
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
    default:
      return null;
  }
}

setCatalogBuilder(buildCatalogRelation);
