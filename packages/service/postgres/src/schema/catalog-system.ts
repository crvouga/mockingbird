import type { Relation, RelColumn } from "../executor/relation.ts";
import type { EngineCtx } from "../expressions/context.ts";
import { ADVISORY_MODE_NAME, engineAdvisoryLocks } from "../functions/advisory-fns.ts";
import { pgTrgmInstalled } from "../functions/pgtrgm.ts";
import { databaseCatalogContext } from "../runtime/database-context.ts";
import { deparseDefault } from "../sql/deparse-default.ts";
import { type Interval, UNIX_EPOCH_MICROS_FROM_PG } from "../types/datetime.ts";
import { networkInput } from "../types/network.ts";
import { zoneOffsetAtUtc } from "../types/timezone.ts";
import { TIMEZONE_ABBREVS, TIMEZONE_NAMES } from "../types/timezone-data.ts";
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
  const rows: Datum[][] = columnDefaults(ctx).map((d) => [
    attrdefOid(d.tableOid, d.attnum),
    d.tableOid,
    d.attnum,
    d.text,
  ]);
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
  ): Datum[] => [
    oid,
    name,
    PG_CATALOG,
    SUPERUSER_OID,
    provider,
    true,
    encoding,
    collate,
    collate,
    locale,
    null,
    version,
  ];
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
 * transaction id lock and the `AccessShareLock` on `pg_locks` itself, plus the advisory locks held
 * (and, over the wire, waited for) by every session. Row and table locks live in the wire server's
 * cluster and are not listed.
 */
function pgLocks(ctx: EngineCtx): Relation {
  const databaseOid = databaseOidOf(ctx);
  const virtualTransaction = `1/${ctx.state.inTransaction ? 2 : 1}`;
  const context = databaseCatalogContext(ctx.state);
  const names = context.names();
  const self = currentBackendPid(ctx);
  const advisory = (
    context.advisoryLocks?.() ??
    engineAdvisoryLocks(ctx.state).map((lock) => ({ ...lock, pid: self, databaseName: context.name, granted: true }))
  ).map((lock): Datum[] => [
    "advisory",
    5 + Math.max(names.indexOf(lock.databaseName), 0),
    null,
    null,
    null,
    null,
    null,
    lock.key.classid,
    lock.key.objid,
    lock.key.objsubid,
    lock.pid === self ? virtualTransaction : `${lock.pid}/1`,
    lock.pid,
    ADVISORY_MODE_NAME[lock.mode],
    lock.granted,
    false,
    null,
  ]);
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
        currentBackendPid(ctx),
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
        currentBackendPid(ctx),
        "ExclusiveLock",
        true,
        true,
        null,
      ],
      ...advisory,
    ],
    "pg_locks",
  );
}

function databaseOidOf(ctx: EngineCtx): number {
  const names = databaseCatalogContext(ctx.state).names();
  const index = names.indexOf(databaseCatalogContext(ctx.state).name);
  return 5 + Math.max(index, 0);
}

/** The pid of the session running this statement: its wire connection's, or the engine's one backend. */
export function currentBackendPid(ctx: EngineCtx): number {
  return databaseCatalogContext(ctx.state).currentPid?.() ?? BACKEND_PID;
}

/**
 * `pg_stat_activity`: one row per backend. The engine on its own has one (the current, active);
 * a wire server lists each connected session, with its database, application_name, state, and a
 * Lock wait for a session waiting on another's lock. The statement text is not tracked, so `query`
 * is empty, and the timestamps are the current time.
 */
function pgStatActivity(ctx: EngineCtx): Relation {
  const now = BigInt(Math.round(ctx.state.clock().getTime())) * 1000n + UNIX_EPOCH_MICROS_FROM_PG;
  const context = databaseCatalogContext(ctx.state);
  const names = context.names();
  const self = currentBackendPid(ctx);
  const backends = context.backends?.() ?? [
    {
      pid: self,
      databaseName: context.name,
      applicationName: ctx.state.getSetting("application_name") ?? "",
      state: "active",
      waiting: false,
    },
  ];
  const rows: Datum[][] = backends.map((backend) => {
    const current = backend.pid === self;
    const state = current ? "active" : backend.state;
    return [
      5 + Math.max(names.indexOf(backend.databaseName), 0),
      backend.databaseName,
      backend.pid,
      null,
      SUPERUSER_OID,
      "postgres",
      current ? (ctx.state.getSetting("application_name") ?? "") : backend.applicationName,
      backend.clientAddr === undefined ? null : networkInput("inet", backend.clientAddr),
      null,
      backend.clientPort ?? null,
      now,
      state === "idle" ? null : now,
      now,
      now,
      backend.waiting ? "Lock" : state === "idle" ? "Client" : null,
      backend.waiting ? "advisory" : state === "idle" ? "ClientRead" : null,
      state,
      null,
      null,
      null,
      "",
      "client backend",
    ];
  });
  return rel(
    [
      ["datid", "oid"],
      ["datname", "name"],
      ["pid", "int4"],
      ["leader_pid", "int4"],
      ["usesysid", "oid"],
      ["usename", "name"],
      ["application_name", "text"],
      ["client_addr", "inet"],
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
    rows,
    "pg_stat_activity",
  );
}

/**
 * `pg_stat_database`: a row per database, plus PostgreSQL's row for shared objects (datid 0).
 * `numbackends` counts the sessions connected to each; the I/O and tuple counters the engine
 * does not collect read zero.
 */
function pgStatDatabase(ctx: EngineCtx): Relation {
  const context = databaseCatalogContext(ctx.state);
  const names = context.names();
  const backends = context.backends?.() ?? [{ databaseName: context.name }];
  const row = (datid: number, datname: string | null, numbackends: number | null): Datum[] => [
    datid,
    datname,
    numbackends,
    ...Array.from({ length: 14 }, () => 0n),
    null,
    0,
    0,
    0,
    0,
    0,
    0n,
    0n,
    0n,
    0n,
    0n,
    0n,
    null,
  ];
  const rows: Datum[][] = [row(0, null, 0)];
  names.forEach((name, index) => {
    rows.push(row(5 + index, name, backends.filter((b) => b.databaseName === name).length));
  });
  return rel(
    [
      ["datid", "oid"],
      ["datname", "name"],
      ["numbackends", "int4"],
      ["xact_commit", "int8"],
      ["xact_rollback", "int8"],
      ["blks_read", "int8"],
      ["blks_hit", "int8"],
      ["tup_returned", "int8"],
      ["tup_fetched", "int8"],
      ["tup_inserted", "int8"],
      ["tup_updated", "int8"],
      ["tup_deleted", "int8"],
      ["conflicts", "int8"],
      ["temp_files", "int8"],
      ["temp_bytes", "int8"],
      ["deadlocks", "int8"],
      ["checksum_failures", "int8"],
      ["checksum_last_failure", "timestamptz"],
      ["blk_read_time", "float8"],
      ["blk_write_time", "float8"],
      ["session_time", "float8"],
      ["active_time", "float8"],
      ["idle_in_transaction_time", "float8"],
      ["sessions", "int8"],
      ["sessions_abandoned", "int8"],
      ["sessions_fatal", "int8"],
      ["sessions_killed", "int8"],
      ["parallel_workers_to_launch", "int8"],
      ["parallel_workers_launched", "int8"],
      ["stats_reset", "timestamptz"],
    ],
    rows,
    "pg_stat_database",
  );
}

const interval = (seconds: number): Interval => ({
  kind: "interval",
  months: 0,
  days: 0,
  micros: BigInt(seconds) * 1_000_000n,
});

/**
 * `pg_timezone_names`: every zone name PostgreSQL's tz database has, with its abbreviation, offset
 * and DST flag at the current transaction time. The offsets come from the same zone rules
 * `AT TIME ZONE` uses; the abbreviations are PostgreSQL's (`MST`, `IST`, `-07`).
 */
function pgTimezoneNames(ctx: EngineCtx): Relation {
  const now = ctx.txNow;
  const year = new Date(Number((now - UNIX_EPOCH_MICROS_FROM_PG) / 1000n)).getUTCFullYear();
  const at = (month: number) => BigInt(Date.UTC(year, month, 15, 12)) * 1000n + UNIX_EPOCH_MICROS_FROM_PG;
  const rows: Datum[][] = [];
  for (const [name, january, july] of TIMEZONE_NAMES) {
    let offset = 0;
    let winter = 0;
    let summer = 0;
    try {
      offset = zoneOffsetAtUtc(name, now);
      winter = zoneOffsetAtUtc(name, at(0));
      summer = zoneOffsetAtUtc(name, at(6));
    } catch {
      // a zone the host's time zone data does not know (Factory): UTC
    }
    const abbrev = offset === winter ? january : offset === summer ? (july ?? january) : january;
    rows.push([name, abbrev, interval(offset), offset > Math.min(winter, summer)]);
  }
  return rel(
    [
      ["name", "text"],
      ["abbrev", "text"],
      ["utc_offset", "interval"],
      ["is_dst", "bool"],
    ],
    rows,
    "pg_timezone_names",
  );
}

/** `pg_timezone_abbrevs`: the abbreviations of PostgreSQL's Default set (timezone_abbreviations). */
function pgTimezoneAbbrevs(): Relation {
  return rel(
    [
      ["abbrev", "text"],
      ["utc_offset", "interval"],
      ["is_dst", "bool"],
    ],
    TIMEZONE_ABBREVS.map(([abbrev, offset, isDst]) => [abbrev, interval(offset), isDst]),
    "pg_timezone_abbrevs",
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
    case "pg_stat_database":
      return pgStatDatabase(ctx);
    case "pg_timezone_names":
      return pgTimezoneNames(ctx);
    case "pg_timezone_abbrevs":
      return pgTimezoneAbbrevs();
    default:
      return null;
  }
}
