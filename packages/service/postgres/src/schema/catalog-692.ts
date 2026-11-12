import type { PartitionBoundSpec } from "../ast/nodes.ts";
import type { Relation, RelColumn } from "../executor/relation.ts";
import type { EngineCtx } from "../expressions/context.ts";
import { deparseRuleExpr } from "../sql/ruleutils.ts";
import { type CatalogExt, type GrantData, type RoleData, tableExt } from "../storage/catalog-ext.ts";
import type { DatabaseState, TableData } from "../storage/database-state.ts";
import { databaseCatalogContext } from "../runtime/database-context.ts";
import { currentUserName, hasPrivsOfRole, roleByOid } from "../storage/roles.ts";
import { parseTimestampTz } from "../types/datetime.ts";
import { type Datum, makeArray } from "../types/value.ts";

/**
 * pg_catalog relations of the issue #692 features: roles (pg_roles, pg_user, pg_authid,
 * pg_auth_members), row-level security (pg_policy, pg_policies), cursors (pg_cursors),
 * partitioning (pg_partitioned_table, pg_inherits) and event triggers (pg_event_trigger), plus the
 * pg_class columns they decide.
 */

type ColSpec = readonly [string, string];

function rel(specs: readonly ColSpec[], rows: Datum[][], table: string): Relation {
  const columns: RelColumn[] = specs.map(([name, type]) => ({ name, type, table }));
  return { columns, rows };
}

function roleName(ext: CatalogExt, oid: number): string {
  if (oid === 0) return "public";
  return roleByOid(ext, oid)?.name ?? String(oid);
}

function rolesInOidOrder(ext: CatalogExt): RoleData[] {
  return [...ext.roles.values()].sort((a, b) => a.oid - b.oid);
}

function validUntil(ctx: EngineCtx, role: RoleData): Datum {
  if (role.validUntil === null) return null;
  try {
    return parseTimestampTz(role.validUntil, (naive) => ctx.zoneOffsetForNaive(naive));
  } catch {
    return null;
  }
}

function roleConfig(role: RoleData): Datum {
  const entries = Object.entries(role.settings ?? {});
  return entries.length === 0
    ? null
    : makeArray(
        "text",
        entries.map(([k, v]) => `${k}=${v}`),
      );
}

/** The aclitem text of a grant: `grantee=privs/grantor`, `*` after a grantable privilege. */
export function aclItemText(ext: CatalogExt, grant: GrantData): string {
  const grantee = grant.grantee === 0 ? "" : roleName(ext, grant.grantee);
  const privileges = [...grant.privileges].map((p) => (grant.grantable.includes(p) ? `${p}*` : p)).join("");
  return `${grantee}=${privileges}/${roleName(ext, grant.grantor)}`;
}

export function objectAcl(ext: CatalogExt, oid: number): Datum {
  const items = ext.grants.filter((g) => g.objectOid === oid && g.column === undefined);
  return items.length === 0
    ? null
    : makeArray(
        "text",
        items.map((g) => aclItemText(ext, g)),
      );
}

/** `FOR VALUES ...` / `DEFAULT`, as pg_get_expr(relpartbound) prints it. */
export function partitionBoundText(ctx: EngineCtx, table: TableData, bound: PartitionBoundSpec): string {
  const value = (expr: import("../ast/nodes.ts").Expr) => deparseRuleExpr({ ctx, table }, expr, false);
  switch (bound.kind) {
    case "default":
      return "DEFAULT";
    case "hash":
      return `FOR VALUES WITH (modulus ${bound.modulus}, remainder ${bound.remainder})`;
    case "list":
      return `FOR VALUES IN (${bound.values.map(value).join(", ")})`;
    case "range": {
      const datums = (list: typeof bound.from) =>
        list.map((d) => (d.kind === "value" ? value(d.expr) : d.kind.toUpperCase())).join(", ");
      return `FOR VALUES FROM (${datums(bound.from)}) TO (${datums(bound.to)})`;
    }
  }
}

const RELOWNER = 4;
const RELAM = 5;
const RELFILENODE = 6;
const RELKIND = 15;
const RELHASSUBCLASS = 20;
const RELROWSECURITY = 21;
const RELFORCEROWSECURITY = 22;
const RELISPARTITION = 25;
const RELACL = 27;
const RELPARTBOUND = 29;

/** Fill the pg_class columns partitioning, row security, ownership and privileges decide. */
export function extendPgClass(ctx: EngineCtx, rows: Datum[][]): void {
  const state = ctx.state;
  const ext = state.catalogExt;
  const tables = new Map<number, TableData>();
  for (const schema of state.schemas.values()) for (const t of schema.tables.values()) tables.set(t.oid, t);
  const parents = new Set<number>();
  for (const t of ext.tables.values()) if (t.partitionOf) parents.add(t.partitionOf.parent);
  for (const row of rows) {
    const oid = row[0] as number;
    row[RELACL] = objectAcl(ext, oid);
    const data = ext.tables.get(oid);
    if (!data) continue;
    if (data.owner !== undefined) row[RELOWNER] = data.owner;
    if (data.partitionKey) {
      row[RELKIND] = "p";
      row[RELAM] = 0;
      row[RELFILENODE] = 0;
    }
    if (parents.has(oid)) row[RELHASSUBCLASS] = true;
    row[RELROWSECURITY] = data.rowSecurity === true;
    row[RELFORCEROWSECURITY] = data.forceRowSecurity === true;
    if (data.partitionOf) {
      row[RELISPARTITION] = true;
      const table = tables.get(oid);
      if (table) row[RELPARTBOUND] = partitionBoundText(ctx, table, data.partitionOf.bound);
    }
  }
}

function pgRoles(ctx: EngineCtx): Relation {
  const ext = ctx.state.catalogExt;
  return rel(
    [
      ["rolname", "name"],
      ["rolsuper", "bool"],
      ["rolinherit", "bool"],
      ["rolcreaterole", "bool"],
      ["rolcreatedb", "bool"],
      ["rolcanlogin", "bool"],
      ["rolreplication", "bool"],
      ["rolconnlimit", "int4"],
      ["rolpassword", "text"],
      ["rolvaliduntil", "timestamptz"],
      ["rolbypassrls", "bool"],
      ["rolconfig", "text[]"],
      ["oid", "oid"],
    ],
    rolesInOidOrder(ext).map((r) => [
      r.name,
      r.superuser,
      r.inherit,
      r.createrole,
      r.createdb,
      r.login,
      r.replication,
      r.connlimit,
      "********",
      validUntil(ctx, r),
      r.bypassrls,
      roleConfig(r),
      r.oid,
    ]),
    "pg_roles",
  );
}

function pgUser(ctx: EngineCtx): Relation {
  const ext = ctx.state.catalogExt;
  return rel(
    [
      ["usename", "name"],
      ["usesysid", "oid"],
      ["usecreatedb", "bool"],
      ["usesuper", "bool"],
      ["userepl", "bool"],
      ["usebypassrls", "bool"],
      ["passwd", "text"],
      ["valuntil", "timestamptz"],
      ["useconfig", "text[]"],
    ],
    rolesInOidOrder(ext)
      .filter((r) => r.login)
      .map((r) => [
        r.name,
        r.oid,
        r.createdb,
        r.superuser,
        r.replication,
        r.bypassrls,
        "********",
        validUntil(ctx, r),
        roleConfig(r),
      ]),
    "pg_user",
  );
}

function pgAuthid(ctx: EngineCtx): Relation {
  const ext = ctx.state.catalogExt;
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
    rolesInOidOrder(ext).map((r) => [
      r.oid,
      r.name,
      r.superuser,
      r.inherit,
      r.createrole,
      r.createdb,
      r.login,
      r.replication,
      r.bypassrls,
      r.connlimit,
      r.password,
      validUntil(ctx, r),
    ]),
    "pg_authid",
  );
}

function pgAuthMembers(ctx: EngineCtx): Relation {
  return rel(
    [
      ["oid", "oid"],
      ["roleid", "oid"],
      ["member", "oid"],
      ["grantor", "oid"],
      ["admin_option", "bool"],
      ["inherit_option", "bool"],
      ["set_option", "bool"],
    ],
    ctx.state.catalogExt.memberships.map((m) => [m.oid, m.role, m.member, m.grantor, m.admin, m.inherit, m.set]),
    "pg_auth_members",
  );
}

const POLICY_COMMAND_CHAR: Record<string, string> = { all: "*", select: "r", insert: "a", update: "w", delete: "d" };

function policyEntries(
  state: DatabaseState,
): Array<{ table: TableData; policy: import("../storage/catalog-ext.ts").PolicyData }> {
  const out: Array<{ table: TableData; policy: import("../storage/catalog-ext.ts").PolicyData }> = [];
  for (const schema of state.schemas.values()) {
    for (const table of schema.tables.values()) {
      for (const policy of tableExt(state.catalogExt, table.oid).policies ?? []) out.push({ table, policy });
    }
  }
  return out;
}

function pgPolicy(ctx: EngineCtx): Relation {
  const expr = (table: TableData, e: import("../ast/nodes.ts").Expr | null) =>
    e === null ? null : deparseRuleExpr({ ctx, table }, e, false);
  return rel(
    [
      ["oid", "oid"],
      ["polname", "name"],
      ["polrelid", "oid"],
      ["polcmd", "bpchar"],
      ["polpermissive", "bool"],
      ["polroles", "oid[]"],
      ["polqual", "text"],
      ["polwithcheck", "text"],
    ],
    policyEntries(ctx.state).map(({ table, policy }) => [
      policy.oid,
      policy.name,
      table.oid,
      POLICY_COMMAND_CHAR[policy.command]!,
      policy.permissive,
      makeArray("oid", [...policy.roles]),
      expr(table, policy.using),
      expr(table, policy.check),
    ]),
    "pg_policy",
  );
}

function pgPolicies(ctx: EngineCtx): Relation {
  const ext = ctx.state.catalogExt;
  const expr = (table: TableData, e: import("../ast/nodes.ts").Expr | null) =>
    e === null ? null : deparseRuleExpr({ ctx, table }, e, false);
  return rel(
    [
      ["schemaname", "name"],
      ["tablename", "name"],
      ["policyname", "name"],
      ["permissive", "text"],
      ["roles", "name[]"],
      ["cmd", "text"],
      ["qual", "text"],
      ["with_check", "text"],
    ],
    policyEntries(ctx.state).map(({ table, policy }) => [
      table.schema,
      table.name,
      policy.name,
      policy.permissive ? "PERMISSIVE" : "RESTRICTIVE",
      makeArray(
        "name",
        policy.roles.map((r) => roleName(ext, r)),
      ),
      policy.command.toUpperCase(),
      expr(table, policy.using),
      expr(table, policy.check),
    ]),
    "pg_policies",
  );
}

function pgCursors(ctx: EngineCtx): Relation {
  return rel(
    [
      ["name", "text"],
      ["statement", "text"],
      ["is_holdable", "bool"],
      ["is_binary", "bool"],
      ["is_scrollable", "bool"],
      ["creation_time", "timestamptz"],
    ],
    [...ctx.state.cursors.values()].map((c) => [c.name, c.statement, c.hold, c.binary, c.scrollable, c.created]),
    "pg_cursors",
  );
}

const STRATEGY_CHAR: Record<string, string> = { range: "r", list: "l", hash: "h" };

function pgPartitionedTable(ctx: EngineCtx): Relation {
  const state = ctx.state;
  const rows: Datum[][] = [];
  for (const schema of state.schemas.values()) {
    for (const table of schema.tables.values()) {
      const ext = tableExt(state.catalogExt, table.oid);
      if (!ext.partitionKey) continue;
      const defaultPartition = [...state.catalogExt.tables].find(
        ([, t]) => t.partitionOf?.parent === table.oid && t.partitionOf.bound.kind === "default",
      );
      const attrs = ext.partitionKey.keys.map((k) => (k.column === null ? 0 : table.columnIndex(k.column) + 1));
      rows.push([
        table.oid,
        STRATEGY_CHAR[ext.partitionKey.strategy]!,
        attrs.length,
        defaultPartition?.[0] ?? 0,
        attrs.join(" "),
      ]);
    }
  }
  return rel(
    [
      ["partrelid", "oid"],
      ["partstrat", "bpchar"],
      ["partnatts", "int2"],
      ["partdefid", "oid"],
      ["partattrs", "text"],
    ],
    rows,
    "pg_partitioned_table",
  );
}

function pgInherits(ctx: EngineCtx): Relation {
  const rows: Datum[][] = [];
  for (const [oid, ext] of ctx.state.catalogExt.tables) {
    if (ext.partitionOf) rows.push([oid, ext.partitionOf.parent, 1, false]);
  }
  rows.sort((a, b) => (a[0] as number) - (b[0] as number));
  return rel(
    [
      ["inhrelid", "oid"],
      ["inhparent", "oid"],
      ["inhseqno", "int4"],
      ["inhdetachpending", "bool"],
    ],
    rows,
    "pg_inherits",
  );
}

function pgEventTrigger(ctx: EngineCtx): Relation {
  const triggers = [...ctx.state.catalogExt.eventTriggers.values()].sort((a, b) => a.oid - b.oid);
  return rel(
    [
      ["oid", "oid"],
      ["evtname", "name"],
      ["evtevent", "name"],
      ["evtowner", "oid"],
      ["evtfoid", "oid"],
      ["evtenabled", "bpchar"],
      ["evttags", "text[]"],
    ],
    triggers.map((t) => [
      t.oid,
      t.name,
      t.event,
      t.owner,
      t.funcOid,
      t.enabled,
      t.tags === null ? null : makeArray("text", [...t.tags]),
    ]),
    "pg_event_trigger",
  );
}

const INFO_PRIVILEGES: ReadonlyArray<[string, string]> = [
  ["a", "INSERT"],
  ["r", "SELECT"],
  ["w", "UPDATE"],
  ["d", "DELETE"],
  ["D", "TRUNCATE"],
  ["x", "REFERENCES"],
  ["t", "TRIGGER"],
];

/** information_schema.table_privileges / role_table_grants: one row per privilege of each ACL entry. */
function infoTablePrivileges(ctx: EngineCtx, name: string): Relation {
  const state = ctx.state;
  const ext = state.catalogExt;
  const me = roleByOid(ext, 10)!;
  const current = state.catalogExt.roles.get(currentUserName(state)) ?? me;
  const enabled = (oid: number) => current.superuser || hasPrivsOfRole(ext, current, oid);
  const database = databaseCatalogContext(state).name;
  const rows: Datum[][] = [];
  for (const schema of state.schemas.values()) {
    const relations = [...schema.tables.values(), ...schema.views.values()];
    for (const relation of relations) {
      const owner = ext.tables.get(relation.oid)?.owner ?? 10;
      const recorded = ext.grants.filter((g) => g.objectOid === relation.oid && g.column === undefined);
      const acl: GrantData[] =
        recorded.length > 0
          ? recorded
          : [
              {
                objectKind: "table",
                objectOid: relation.oid,
                grantee: owner,
                grantor: owner,
                privileges: "arwdDxtm",
                grantable: "",
              },
            ];
      for (const grant of acl) {
        if (!(enabled(grant.grantor) || grant.grantee === 0 || enabled(grant.grantee))) continue;
        for (const [letter, privilege] of INFO_PRIVILEGES) {
          if (!grant.privileges.includes(letter)) continue;
          const grantable = grant.grantable.includes(letter) || (grant.grantee !== 0 && grant.grantee === owner);
          rows.push([
            roleName(ext, grant.grantor),
            grant.grantee === 0 ? "PUBLIC" : roleName(ext, grant.grantee),
            database,
            schema.name,
            relation.name,
            privilege,
            grantable ? "YES" : "NO",
            privilege === "SELECT" ? "YES" : "NO",
          ]);
        }
      }
    }
  }
  return rel(
    [
      ["grantor", "name"],
      ["grantee", "name"],
      ["table_catalog", "name"],
      ["table_schema", "name"],
      ["table_name", "name"],
      ["privilege_type", "varchar"],
      ["is_grantable", "varchar"],
      ["with_hierarchy", "varchar"],
    ],
    rows,
    name,
  );
}

/** The relation `name` in pg_catalog when this module provides it, else null. */
export function catalogRelation692(ctx: EngineCtx, schema: string, name: string): Relation | null {
  if (schema === "information_schema") {
    return name === "table_privileges" || name === "role_table_grants" ? infoTablePrivileges(ctx, name) : null;
  }
  if (schema !== "pg_catalog") return null;
  switch (name) {
    case "pg_roles":
      return pgRoles(ctx);
    case "pg_user":
      return pgUser(ctx);
    case "pg_authid":
      return pgAuthid(ctx);
    case "pg_auth_members":
      return pgAuthMembers(ctx);
    case "pg_policy":
      return pgPolicy(ctx);
    case "pg_policies":
      return pgPolicies(ctx);
    case "pg_cursors":
      return pgCursors(ctx);
    case "pg_partitioned_table":
      return pgPartitionedTable(ctx);
    case "pg_inherits":
      return pgInherits(ctx);
    case "pg_event_trigger":
      return pgEventTrigger(ctx);
    default:
      return null;
  }
}

/** Relations above, resolvable unqualified through the implicit pg_catalog. */
export const CATALOG_692_RELATIONS = [
  "pg_auth_members",
  "pg_policy",
  "pg_policies",
  "pg_cursors",
  "pg_partitioned_table",
  "pg_event_trigger",
];
