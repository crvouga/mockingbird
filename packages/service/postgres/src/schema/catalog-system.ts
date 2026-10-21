import type { Relation, RelColumn } from "../executor/relation.ts";
import type { EngineCtx } from "../expressions/context.ts";
import { pgTrgmInstalled } from "../functions/pgtrgm.ts";
import { databaseCatalogContext } from "../runtime/database-context.ts";
import { deparseDefault } from "../sql/deparse-default.ts";
import { UNIX_EPOCH_MICROS_FROM_PG } from "../types/datetime.ts";
import { builtinNamespaceOid } from "../types/regnamespace.ts";
import { type Datum, TYPE_OIDS, type TypeId } from "../types/value.ts";
import { catalogRelationOid } from "./catalog-oids.ts";
import { ACCESS_METHODS } from "./index-catalog.ts";

/**
 * Catalogs that describe the engine itself rather than a user's objects: column defaults,
 * dependencies, inheritance, collations, operator classes, roles, locks and sessions. Each one
 * lists what the engine really models (no inheritance, one role, one backend) and is otherwise
 * empty, so a tool that only probes them gets rows instead of `42P01`.
 */

type ColSpec = readonly [name: string, type: TypeId];

function rel(specs: readonly ColSpec[], rows: Datum[][], table: string): Relation {
  const columns: RelColumn[] = specs.map(([name, type]) => ({ name, type, table }));
  return { columns, rows };
}

const PG_CATALOG = builtinNamespaceOid("pg_catalog") ?? 11;
const PG_CLASS_OID = 1259;
const PG_ATTRDEF_OID = 2604;
const SUPERUSER_OID = 10;

/** Rooms for one oid per (table, column) above every oid the engine allocates. */
const ATTRDEF_OID_BASE = 3_000_000_000;

/**
 * Oid of the `pg_attrdef` row of a column: derived from the table oid and column number so it is
 * stable across reads and never collides with another catalog row.
 */
export const attrdefOid = (tableOid: number, attnum: number): number => ATTRDEF_OID_BASE + tableOid * 1024 + attnum;

/** The text `pg_get_expr(adbin, adrelid)` prints for each column that has a default expression. */
export function columnDefaults(ctx: EngineCtx): Array<{ tableOid: number; attnum: number; text: string }> {
  const defaults: Array<{ tableOid: number; attnum: number; text: string }> = [];
  for (const schema of ctx.state.schemas.values()) {
    for (const table of schema.tables.values()) {
      table.columns.forEach((column, index) => {
        // a stored generated column keeps its expression in pg_attrdef; an identity column has none,
        // and neither does a column whose default is NULL
        const expr = column.generated ?? column.defaultExpr;
        if (expr === null) return;
        const text = deparseDefault(ctx, expr, column.type);
        if (text !== null) defaults.push({ tableOid: table.oid, attnum: index + 1, text });
      });
    }
  }
  return defaults;
}

/**
 * `pg_attrdef`: one row per column default. `adbin` is `pg_node_tree` in PostgreSQL; here it is the
 * text `pg_get_expr(adbin, adrelid)` returns (as `pg_index.indexprs` already is), so that function
 * hands it back unchanged.
 */
function pgAttrdef(ctx: EngineCtx): Relation {
  const rows: Datum[][] = columnDefaults(ctx).map((d) => [attrdefOid(d.tableOid, d.attnum), d.tableOid, d.attnum, d.text]);
  return rel(
    [
      ["oid", "oid"],
      ["adrelid", "oid"],
      ["adnum", "int2"],
      ["adbin", "text"],
    ],
    rows,
    "pg_attrdef",
  );
}

/**
 * `pg_depend`: the dependencies the engine tracks. A sequence owned by a column (`serial`,
 * `OWNED BY`) is auto-dependent on it (`a`) and an identity column's sequence is internal (`i`);
 * a column default and an index on plain columns depend on the columns they use.
 */
function pgDepend(ctx: EngineCtx): Relation {
  const rows: Datum[][] = [];
  const state = ctx.state;
  for (const schema of state.schemas.values()) {
    for (const seq of schema.sequences.values()) {
      const owner = seq.ownedBy ? schema.tables.get(seq.ownedBy.table) : undefined;
      const ownerColumn = owner?.columns.findIndex((c) => c.name === seq.ownedBy?.column) ?? -1;
      if (!owner || ownerColumn < 0) continue;
      const identity = owner.columns[ownerColumn]!.identity !== null;
      rows.push([PG_CLASS_OID, seq.oid, 0, PG_CLASS_OID, owner.oid, ownerColumn + 1, identity ? "i" : "a"]);
    }
    for (const index of schema.indexes.values()) {
      const table = schema.tables.get(index.table);
      if (!table || index.isConstraint) continue;
      for (const key of index.columns) {
        const attnum = key.column === null ? 0 : table.columns.findIndex((c) => c.name === key.column) + 1;
        if (attnum > 0) rows.push([PG_CLASS_OID, index.oid ?? 0, 0, PG_CLASS_OID, table.oid, attnum, "a"]);
      }
    }
  }
  for (const d of columnDefaults(ctx)) {
    rows.push([PG_ATTRDEF_OID, attrdefOid(d.tableOid, d.attnum), 0, PG_CLASS_OID, d.tableOid, d.attnum, "a"]);
  }
  return rel(
    [
      ["classid", "oid"],
      ["objid", "oid"],
      ["objsubid", "int4"],
      ["refclassid", "oid"],
      ["refobjid", "oid"],
      ["refobjsubid", "int4"],
      ["deptype", "bpchar"],
    ],
    rows,
    "pg_depend",
  );
}

/** `pg_inherits`: table inheritance and partitioning are not modelled, so it is always empty. */
function pgInherits(): Relation {
  return rel(
    [
      ["inhrelid", "oid"],
      ["inhparent", "oid"],
      ["inhseqno", "int4"],
      ["inhdetachpending", "bool"],
    ],
    [],
    "pg_inherits",
  );
}

/** `pg_collation`: the collations a database made by initdb on UTF8 always has (`C` ordering is the engine's). */
function pgCollation(): Relation {
  const row = (
    oid: number,
    name: string,
    provider: string,
    encoding: number,
    collate: string | null,
    locale: string | null,
    version: string | null,
  ): Datum[] => [oid, name, PG_CATALOG, SUPERUSER_OID, provider, true, encoding, collate, collate, locale, null, version];
  return rel(
    [
      ["oid", "oid"],
      ["collname", "name"],
      ["collnamespace", "oid"],
      ["collowner", "oid"],
      ["collprovider", "bpchar"],
      ["collisdeterministic", "bool"],
      ["collencoding", "int4"],
      ["collcollate", "text"],
      ["collctype", "text"],
      ["colllocale", "text"],
      ["collicurules", "text"],
      ["collversion", "text"],
    ],
    [
      row(100, "default", "d", -1, null, null, null),
      row(950, "C", "c", -1, "C", null, null),
      row(951, "POSIX", "c", -1, "POSIX", null, null),
      row(962, "ucs_basic", "b", 6, null, "C", "1"),
    ],
    "pg_collation",
  );
}

const OPCLASS_OID_BASE = 10_000;

/**
 * `pg_opclass`: the operator classes `CREATE INDEX` can name: the default class of each built-in
 * type for btree (`<type>_ops`), the gin classes for arrays, jsonb and tsvector, and `gin_trgm_ops`
 * while pg_trgm is installed. Their oids are not PostgreSQL's.
 */
function pgOpclass(trgmInstalled: boolean): Relation {
  const rows: Datum[][] = [];
  let oid = OPCLASS_OID_BASE;
  const push = (method: string, name: string, inputType: number, isDefault: boolean) => {
    const am = ACCESS_METHODS.get(method)![0];
    rows.push([oid++, am, name, PG_CATALOG, SUPERUSER_OID, 0, inputType, isDefault, 0]);
  };
  for (const [type, typeOid] of Object.entries(TYPE_OIDS)) {
    if (["unknown", "void", "record", "regclass", "regtype", "regproc", "regnamespace"].includes(type)) continue;
    push("btree", `${type === "varchar" ? "text" : type}_ops`, typeOid, type !== "varchar");
  }
  push("btree", "array_ops", 2277, true);
  push("btree", "enum_ops", 3500, true);
  push("gin", "array_ops", 2277, true);
  push("gin", "jsonb_ops", TYPE_OIDS.jsonb!, true);
  push("gin", "jsonb_path_ops", TYPE_OIDS.jsonb!, false);
  push("gin", "tsvector_ops", TYPE_OIDS.tsvector!, true);
  if (trgmInstalled) push("gin", "gin_trgm_ops", TYPE_OIDS.text!, true);
  return rel(
    [
      ["oid", "oid"],
      ["opcmethod", "oid"],
      ["opcname", "name"],
      ["opcnamespace", "oid"],
      ["opcowner", "oid"],
      ["opcfamily", "oid"],
      ["opcintype", "oid"],
      ["opcdefault", "bool"],
      ["opckeytype", "oid"],
    ],
    rows,
    "pg_opclass",
  );
}

/** `pg_authid`: the one role the engine has (roles and authentication are not enforced). */
function pgAuthid(): Relation {
  return rel(
    [
      ["oid", "oid"],
      ["rolname", "name"],
      ["rolsuper", "bool"],
      ["rolinherit", "bool"],
      ["rolcreaterole", "bool"],
      ["rolcreatedb", "bool"],
      ["rolcanlogin", "bool"],
      ["rolreplication", "bool"],
      ["rolbypassrls", "bool"],
      ["rolconnlimit", "int4"],
      ["rolpassword", "text"],
      ["rolvaliduntil", "timestamptz"],
    ],
    [[SUPERUSER_OID, "postgres", true, true, true, true, true, true, true, -1, null, null]],
    "pg_authid",
  );
}

/** The one session the in-process engine has; the wire server serves each connection its own pid. */
const BACKEND_PID = 1;

/**
 * `pg_locks`: what a stock server shows for a session that is only reading: its virtual
 * transaction id lock and the `AccessShareLock` on `pg_locks` itself. Row, table and advisory
 * locks live in the wire server's cluster and are not listed.
 */
function pgLocks(ctx: EngineCtx): Relation {
  const databaseOid = databaseOidOf(ctx);
  const virtualTransaction = `1/${ctx.state.inTransaction ? 2 : 1}`;
  return rel(
    [
      ["locktype", "text"],
      ["database", "oid"],
      ["relation", "oid"],
      ["page", "int4"],
      ["tuple", "int2"],
      ["virtualxid", "text"],
      ["transactionid", "xid"],
      ["classid", "oid"],
      ["objid", "oid"],
      ["objsubid", "int2"],
      ["virtualtransaction", "text"],
      ["pid", "int4"],
      ["mode", "text"],
      ["granted", "bool"],
      ["fastpath", "bool"],
      ["waitstart", "timestamptz"],
    ],
    [
      [
        "relation",
        databaseOid,
        catalogRelationOid("pg_catalog", "pg_locks"),
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        virtualTransaction,
        BACKEND_PID,
        "AccessShareLock",
        true,
        true,
        null,
      ],
      [
        "virtualxid",
        null,
        null,
        null,
        null,
        virtualTransaction,
        null,
        null,
        null,
        null,
        virtualTransaction,
        BACKEND_PID,
        "ExclusiveLock",
        true,
        true,
        null,
      ],
    ],
    "pg_locks",
  );
}

function databaseOidOf(ctx: EngineCtx): number {
  const names = databaseCatalogContext(ctx.state).names();
  const index = names.indexOf(databaseCatalogContext(ctx.state).name);
  return 5 + Math.max(index, 0);
}

/**
 * `pg_stat_activity`: the current backend, active. The statement text is not tracked, so `query`
 * is empty; other backends of a wire server are not listed.
 */
function pgStatActivity(ctx: EngineCtx): Relation {
  const now = BigInt(Math.round(ctx.state.clock().getTime())) * 1000n + UNIX_EPOCH_MICROS_FROM_PG;
  return rel(
    [
      ["datid", "oid"],
      ["datname", "name"],
      ["pid", "int4"],
      ["leader_pid", "int4"],
      ["usesysid", "oid"],
      ["usename", "name"],
      ["application_name", "text"],
      ["client_addr", "text"],
      ["client_hostname", "text"],
      ["client_port", "int4"],
      ["backend_start", "timestamptz"],
      ["xact_start", "timestamptz"],
      ["query_start", "timestamptz"],
      ["state_change", "timestamptz"],
      ["wait_event_type", "text"],
      ["wait_event", "text"],
      ["state", "text"],
      ["backend_xid", "xid"],
      ["backend_xmin", "xid"],
      ["query_id", "int8"],
      ["query", "text"],
      ["backend_type", "text"],
    ],
    [
      [
        databaseOidOf(ctx),
        databaseCatalogContext(ctx.state).name,
        BACKEND_PID,
        null,
        SUPERUSER_OID,
        "postgres",
        "",
        null,
        null,
        null,
        now,
        now,
        now,
        now,
        null,
        null,
        "active",
        null,
        null,
        null,
        "",
        "client backend",
      ],
    ],
    "pg_stat_activity",
  );
}

/** System catalogs of `pg_catalog` that are not user-object listings, or null when `name` is not one of them. */
export function systemCatalogRelation(ctx: EngineCtx, name: string): Relation | null {
  switch (name) {
    case "pg_attrdef":
      return pgAttrdef(ctx);
    case "pg_depend":
      return pgDepend(ctx);
    case "pg_inherits":
      return pgInherits();
    case "pg_collation":
      return pgCollation();
    case "pg_opclass":
      return pgOpclass(pgTrgmInstalled(ctx.state));
    case "pg_authid":
      return pgAuthid();
    case "pg_locks":
      return pgLocks(ctx);
    case "pg_stat_activity":
      return pgStatActivity(ctx);
    default:
      return null;
  }
}
