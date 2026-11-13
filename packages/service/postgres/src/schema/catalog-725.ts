import type { Relation, RelColumn } from "../executor/relation.ts";
import type { EngineCtx } from "../expressions/context.ts";
import { databaseCatalogContext } from "../runtime/database-context.ts";
import { deparseSelect } from "../sql/deparse.ts";
import { type Datum, makeArray } from "../types/value.ts";
import { catalogRelation } from "./catalog.ts";
import { catalogRelationNames, catalogRelationOid } from "./catalog-oids.ts";
import { PG_OPERATORS } from "./pg-operator-data.ts";

/**
 * pg_catalog relations of issue #725: pg_db_role_setting (ALTER ROLE / DATABASE ... SET),
 * pg_rewrite (the `_RETURN` rule of every view), pg_operator (PostgreSQL's built-in operators the
 * engine evaluates), and pg_stat_all_tables / pg_stat_sys_tables beside pg_stat_user_tables.
 */

type ColSpec = readonly [string, string];

function rel(specs: readonly ColSpec[], rows: Datum[][], table: string): Relation {
  const columns: RelColumn[] = specs.map(([name, type]) => ({ name, type, table }));
  return { columns, rows };
}

const PG_CATALOG = 11;
const BOOTSTRAP_SUPERUSER = 10;

/** A database's oid as pg_database numbers it: 5, 6, ... in name order. */
function databaseOid(ctx: EngineCtx, name: string | null): number {
  if (name === null) return 0;
  const names = databaseCatalogContext(ctx.state).names();
  return 5 + Math.max(names.indexOf(name), 0);
}

const config = (settings: Readonly<Record<string, string>>): Datum =>
  makeArray(
    "text",
    Object.entries(settings).map(([k, v]) => `${k}=${v}`),
  );

/**
 * `pg_db_role_setting`: the defaults of `ALTER ROLE r SET` (setdatabase 0), `ALTER ROLE r IN DATABASE
 * d SET`, `ALTER ROLE ALL [IN DATABASE d] SET` and `ALTER DATABASE d SET` (setrole 0). They are
 * recorded only: a new wire connection does not apply them.
 */
function pgDbRoleSetting(ctx: EngineCtx): Relation {
  const ext = ctx.state.catalogExt;
  const rows: Datum[][] = [];
  for (const role of ext.roles.values()) {
    if (role.settings && Object.keys(role.settings).length > 0) rows.push([0, role.oid, config(role.settings)]);
  }
  for (const entry of ext.dbRoleSettings ?? []) {
    rows.push([databaseOid(ctx, entry.database), entry.role, config(entry.settings)]);
  }
  return rel(
    [
      ["setdatabase", "oid"],
      ["setrole", "oid"],
      ["setconfig", "text[]"],
    ],
    rows,
    "pg_db_role_setting",
  );
}

/** Rules have no oid of their own in the engine: each `_RETURN` rule is numbered from its view's. */
const RULE_OID_BASE = 0x40000000;

/**
 * `pg_rewrite`: the `_RETURN` rule of each view and materialized view, the engine's own catalog
 * views included. `ev_qual` is `<>` (no qualification) as in PostgreSQL; `ev_action` is the
 * view's query as SQL text rather than a `pg_node_tree`. CREATE RULE is not supported, so there
 * are no other rules.
 */
function pgRewrite(ctx: EngineCtx): Relation {
  const rows: Datum[][] = [];
  const push = (viewOid: number, action: string) =>
    rows.push([RULE_OID_BASE + viewOid, "_RETURN", viewOid, "1", "O", true, "<>", action]);
  for (const [schema, name] of catalogRelationNames()) {
    const oid = catalogRelationOid(schema, name)!;
    // the base catalogs have fixed oids below 10000; the system views come after them
    if (oid >= 12000) push(oid, `SELECT * FROM ${schema}.${name}`);
  }
  for (const schema of ctx.state.schemas.values()) {
    for (const view of schema.views.values()) {
      let action: string;
      try {
        action = deparseSelect(view.query);
      } catch {
        action = "";
      }
      push(view.oid, action);
    }
  }
  return rel(
    [
      ["oid", "oid"],
      ["rulename", "name"],
      ["ev_class", "oid"],
      ["ev_type", "bpchar"],
      ["ev_enabled", "bpchar"],
      ["is_instead", "bool"],
      ["ev_qual", "text"],
      ["ev_action", "text"],
    ],
    rows,
    "pg_rewrite",
  );
}

/**
 * `pg_operator`: PostgreSQL 18.3's built-in operators with their own oids, commutators, negators
 * and implementation functions, for the operator names and operand types the engine evaluates
 * (see pg-operator-data.ts). CREATE OPERATOR is not supported, so there are no user operators.
 */
function pgOperator(): Relation {
  const rows: Datum[][] = PG_OPERATORS.map(
    ([oid, name, kind, left, right, result, commutator, negator, flags, code, restrict, join]) => [
      oid,
      name,
      PG_CATALOG,
      BOOTSTRAP_SUPERUSER,
      kind,
      (flags & 1) !== 0,
      (flags & 2) !== 0,
      left,
      right,
      result,
      commutator,
      negator,
      code,
      restrict,
      join,
    ],
  );
  return rel(
    [
      ["oid", "oid"],
      ["oprname", "name"],
      ["oprnamespace", "oid"],
      ["oprowner", "oid"],
      ["oprkind", "bpchar"],
      ["oprcanmerge", "bool"],
      ["oprcanhash", "bool"],
      ["oprleft", "oid"],
      ["oprright", "oid"],
      ["oprresult", "oid"],
      ["oprcom", "oid"],
      ["oprnegate", "oid"],
      ["oprcode", "regproc"],
      ["oprrest", "regproc"],
      ["oprjoin", "regproc"],
    ],
    rows,
    "pg_operator",
  );
}

/**
 * The system catalogs' rows of pg_stat_sys_tables: every base catalog the engine has (pg_class,
 * pg_proc, ...). Their activity counters are not collected and read zero, `n_live_tup` included.
 */
function systemTableStats(user: Relation): Datum[][] {
  const rows: Datum[][] = [];
  for (const [schema, name] of catalogRelationNames()) {
    const oid = catalogRelationOid(schema, name)!;
    if (schema !== "pg_catalog" || oid >= 12000) continue;
    const row: Datum[] = user.columns.map((column) =>
      column.type === "int8" ? 0n : column.type === "float8" ? 0 : null,
    );
    row[0] = oid;
    row[1] = schema;
    row[2] = name;
    rows.push(row);
  }
  return rows;
}

/** `pg_stat_all_tables` / `pg_stat_sys_tables`: pg_stat_user_tables' columns, over all tables or the system ones. */
function pgStatTables(ctx: EngineCtx, name: "pg_stat_all_tables" | "pg_stat_sys_tables"): Relation | null {
  const user = catalogRelation(ctx, "pg_catalog", "pg_stat_user_tables");
  if (!user) return null;
  const system = systemTableStats(user);
  const rows = name === "pg_stat_sys_tables" ? system : [...system, ...user.rows];
  return { columns: user.columns.map((column) => ({ ...column, table: name })), rows };
}

/** The relation `name` in pg_catalog when this module provides it, else null. */
export function catalogRelation725(ctx: EngineCtx, schema: string, name: string): Relation | null {
  if (schema !== "pg_catalog") return null;
  switch (name) {
    case "pg_db_role_setting":
      return pgDbRoleSetting(ctx);
    case "pg_rewrite":
      return pgRewrite(ctx);
    case "pg_operator":
      return pgOperator();
    case "pg_stat_all_tables":
    case "pg_stat_sys_tables":
      return pgStatTables(ctx, name);
    default:
      return null;
  }
}

/** Relations above, resolvable unqualified through the implicit pg_catalog. */
export const CATALOG_725_RELATIONS = [
  "pg_db_role_setting",
  "pg_rewrite",
  "pg_operator",
  "pg_stat_all_tables",
  "pg_stat_sys_tables",
];
