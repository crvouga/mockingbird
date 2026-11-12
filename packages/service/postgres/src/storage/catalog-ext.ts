import type { Expr, PartitionBoundSpec, PartitionKeyDef, PolicyCommand, TypeName } from "../ast/nodes.ts";
import type { ColumnType } from "../types/value.ts";

/**
 * Catalog state added for issue #692 — roles and their memberships, privileges, composite types,
 * event triggers, and per-table partitioning and row-level security — kept as one immutable value
 * on {@link DatabaseState.catalogExt}. Every change replaces the value (see {@link updateCatalogExt}),
 * so snapshots, transactions and rollback share or restore it by reference.
 */

export interface RoleData {
  readonly oid: number;
  readonly name: string;
  readonly superuser: boolean;
  readonly inherit: boolean;
  readonly createrole: boolean;
  readonly createdb: boolean;
  readonly login: boolean;
  readonly replication: boolean;
  readonly bypassrls: boolean;
  readonly connlimit: number;
  readonly password: string | null;
  /** `VALID UNTIL` as written */
  readonly validUntil: string | null;
  /** ALTER ROLE ... SET name = value (per-role defaults; recorded, applied at the next login over the wire) */
  readonly settings?: Readonly<Record<string, string>>;
}

export interface RoleMembership {
  readonly oid: number;
  readonly role: number;
  readonly member: number;
  readonly grantor: number;
  readonly admin: boolean;
  readonly inherit: boolean;
  readonly set: boolean;
}

/** One grantee's privileges on one object (an `aclitem`). Privilege letters as in `aclitem` (`arwdDxtm`...). */
export interface GrantData {
  /** "table" covers tables, views, sequences (relation oids); "schema", "function", "database", "type" */
  readonly objectKind: string;
  readonly objectOid: number;
  /** column privileges: the column; absent for the whole object */
  readonly column?: string;
  /** 0 = PUBLIC */
  readonly grantee: number;
  readonly grantor: number;
  readonly privileges: string;
  /** the privileges held WITH GRANT OPTION */
  readonly grantable: string;
}

export interface CompositeAttribute {
  readonly name: string;
  readonly type: ColumnType;
  /** the type as written (kept for `format_type` of a domain or enum attribute) */
  readonly typeName?: TypeName;
  readonly collate: string | null;
}

export interface CompositeTypeData {
  readonly oid: number;
  /** pg_class oid of the type's relation (relkind 'c') */
  readonly relOid: number;
  readonly arrayOid: number;
  readonly schema: string;
  readonly name: string;
  readonly attributes: readonly CompositeAttribute[];
  readonly owner: number;
  readonly comment?: string;
}

export interface PartitionKey {
  readonly strategy: "range" | "list" | "hash";
  readonly keys: readonly PartitionKeyDef[];
}

export interface PolicyData {
  readonly oid: number;
  readonly name: string;
  readonly command: PolicyCommand;
  readonly permissive: boolean;
  /** role oids; 0 = PUBLIC */
  readonly roles: readonly number[];
  readonly using: Expr | null;
  readonly check: Expr | null;
}

export interface TableExt {
  /** `PARTITION BY` of a partitioned table */
  readonly partitionKey?: PartitionKey;
  /** the parent's oid and this partition's bound */
  readonly partitionOf?: { readonly parent: number; readonly bound: PartitionBoundSpec };
  readonly rowSecurity?: boolean;
  readonly forceRowSecurity?: boolean;
  readonly policies?: readonly PolicyData[];
  /** relowner, when not the bootstrap superuser */
  readonly owner?: number;
}

export interface EventTriggerData {
  readonly oid: number;
  readonly name: string;
  readonly event: string;
  readonly tags: readonly string[] | null;
  readonly funcSchema: string;
  readonly funcName: string;
  readonly funcOid: number;
  /** pg_event_trigger.evtenabled: O (origin), D (disabled), R (replica), A (always) */
  readonly enabled: "O" | "D" | "R" | "A";
  readonly owner: number;
}

export interface CatalogExt {
  readonly roles: ReadonlyMap<string, RoleData>;
  readonly memberships: readonly RoleMembership[];
  readonly grants: readonly GrantData[];
  /** keyed `schema.name` */
  readonly composites: ReadonlyMap<string, CompositeTypeData>;
  /** keyed by table oid */
  readonly tables: ReadonlyMap<number, TableExt>;
  readonly eventTriggers: ReadonlyMap<string, EventTriggerData>;
}

/** The bootstrap superuser every cluster has. */
export const BOOTSTRAP_SUPERUSER: RoleData = {
  oid: 10,
  name: "postgres",
  superuser: true,
  inherit: true,
  createrole: true,
  createdb: true,
  login: true,
  replication: true,
  bypassrls: true,
  connlimit: -1,
  password: null,
  validUntil: null,
};

/**
 * PostgreSQL 18's predefined roles (`pg_*`), with their oids: present in every cluster, NOLOGIN, and
 * members of each other as `initdb` sets up (pg_monitor holds the three monitoring roles).
 */
const PREDEFINED_ROLES: ReadonlyArray<[number, string]> = [
  [3373, "pg_monitor"],
  [3374, "pg_read_all_settings"],
  [3375, "pg_read_all_stats"],
  [3377, "pg_stat_scan_tables"],
  [4200, "pg_signal_backend"],
  [4544, "pg_checkpoint"],
  [4550, "pg_use_reserved_connections"],
  [4569, "pg_read_server_files"],
  [4570, "pg_write_server_files"],
  [4571, "pg_execute_server_program"],
  [6171, "pg_database_owner"],
  [6181, "pg_read_all_data"],
  [6182, "pg_write_all_data"],
  [6304, "pg_create_subscription"],
  [6337, "pg_maintain"],
  [6392, "pg_signal_autovacuum_worker"],
];

function predefinedRole(oid: number, name: string): RoleData {
  return {
    ...BOOTSTRAP_SUPERUSER,
    oid,
    name,
    superuser: false,
    createrole: false,
    createdb: false,
    login: false,
    replication: false,
    bypassrls: false,
  };
}

export const EMPTY_CATALOG_EXT: CatalogExt = {
  roles: new Map<string, RoleData>([
    ["postgres", BOOTSTRAP_SUPERUSER],
    ...PREDEFINED_ROLES.map(([oid, name]): [string, RoleData] => [name, predefinedRole(oid, name)]),
  ]),
  memberships: [
    { oid: 6001, role: 3374, member: 3373, grantor: 10, admin: false, inherit: true, set: true },
    { oid: 6002, role: 3375, member: 3373, grantor: 10, admin: false, inherit: true, set: true },
    { oid: 6003, role: 3377, member: 3373, grantor: 10, admin: false, inherit: true, set: true },
  ],
  grants: [],
  composites: new Map(),
  tables: new Map(),
  eventTriggers: new Map(),
};

/** Whether a role is one of the built-in ones (bootstrap superuser or `pg_*`). */
export function isBuiltinRole(role: RoleData): boolean {
  return role.oid < 16384;
}

/** Per-table extension data of `oid` (an empty object when there is none). */
export function tableExt(ext: CatalogExt, oid: number): TableExt {
  return ext.tables.get(oid) ?? {};
}

/** A copy of `ext` with `oid`'s table data replaced by `change(old)` (removed when it returns an empty object). */
export function withTableExt(ext: CatalogExt, oid: number, change: (old: TableExt) => TableExt): CatalogExt {
  const tables = new Map(ext.tables);
  const next = change(ext.tables.get(oid) ?? {});
  if (Object.values(next).every((v) => v === undefined)) tables.delete(oid);
  else tables.set(oid, next);
  return { ...ext, tables };
}
