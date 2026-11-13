/**
 * AST of the statements added for issue #692: cursors, roles and privileges, row-level security,
 * composite types, declarative partitioning, event triggers and JSON_TABLE. `nodes.ts` folds them
 * into its unions.
 */
import type { Expr, SelectStmt, TypeName } from "./nodes.ts";

// --- cursors ------------------------------------------------------------------

export type FetchDirection =
  | { readonly kind: "forward" | "backward"; readonly count: number | "all" }
  | { readonly kind: "absolute" | "relative"; readonly count: number };

/** `DECLARE name [BINARY] [[NO] SCROLL] CURSOR [{WITH | WITHOUT} HOLD] FOR query` */
export interface DeclareCursorStmt {
  readonly type: "declare_cursor";
  readonly name: string;
  readonly binary: boolean;
  /** null when neither SCROLL nor NO SCROLL is written */
  readonly scroll: boolean | null;
  readonly hold: boolean;
  readonly query: SelectStmt;
  /** the statement as written, for `pg_cursors.statement` */
  readonly text: string;
}

/** `FETCH` / `MOVE [direction] [FROM | IN] cursor` */
export interface FetchStmt {
  readonly type: "fetch";
  readonly move: boolean;
  readonly direction: FetchDirection;
  readonly cursor: string;
}

/** `CLOSE name` / `CLOSE ALL` (name null) */
export interface CloseCursorStmt {
  readonly type: "close_cursor";
  readonly name: string | null;
}

// --- roles and privileges -----------------------------------------------------

/** One option of CREATE / ALTER ROLE, keyed by its catalog meaning. */
export type RoleOption =
  | { readonly kind: "flag"; readonly name: string; readonly value: boolean }
  | { readonly kind: "password"; readonly value: string | null }
  | { readonly kind: "connection_limit"; readonly value: number }
  | { readonly kind: "valid_until"; readonly value: string }
  | { readonly kind: "in_role" | "role" | "admin"; readonly roles: string[] }
  | { readonly kind: "sysid" };

export interface CreateRoleStmt {
  readonly type: "create_role";
  readonly name: string;
  /** CREATE USER implies LOGIN */
  readonly kind: "role" | "user" | "group";
  readonly options: RoleOption[];
}

export interface AlterRoleStmt {
  readonly type: "alter_role";
  /** a role name, or CURRENT_USER / SESSION_USER / CURRENT_ROLE (resolved when executed) */
  readonly name: string;
  /** `ALTER ROLE ALL ... SET` and `ALTER DATABASE d SET`: a default for every role (pg_db_role_setting.setrole 0) */
  readonly allRoles?: boolean;
  /** `IN DATABASE d` / `ALTER DATABASE d`: the default applies in that database only */
  readonly database?: string;
  /** the command tag, when written as `ALTER DATABASE d SET / RESET` */
  readonly tag?: "ALTER DATABASE";
  readonly action:
    | { readonly kind: "options"; readonly options: RoleOption[] }
    | { readonly kind: "rename"; readonly to: string }
    | { readonly kind: "set"; readonly setting: string; readonly value: string | null }
    | { readonly kind: "reset"; readonly setting: string };
}

export interface DropRoleStmt {
  readonly type: "drop_role";
  readonly names: string[];
  readonly ifExists: boolean;
}

/** `GRANT role [, ...] TO role [, ...] [WITH ...]` / `REVOKE [ADMIN OPTION FOR] role FROM role` */
export interface GrantRoleStmt {
  readonly type: "grant_role";
  readonly revoke: boolean;
  readonly roles: string[];
  readonly grantees: string[];
  readonly admin: boolean;
  readonly inherit: boolean | null;
  readonly set: boolean | null;
  readonly grantedBy: string | null;
}

/** `GRANT privileges ON object TO role` / `REVOKE ...`: privileges on tables, sequences, schemas, functions... */
export interface GrantStmt {
  readonly type: "grant";
  readonly revoke: boolean;
  /** lowercased privilege names; `all` for ALL [PRIVILEGES] */
  readonly privileges: Array<{ readonly name: string; readonly columns: string[] | null }>;
  readonly objectKind: string;
  readonly objects: string[][];
  /** `ON ALL TABLES IN SCHEMA s, ...` */
  readonly allInSchema: string[] | null;
  readonly grantees: string[];
  readonly grantOption: boolean;
  readonly cascade: boolean;
}

/** `ALTER DEFAULT PRIVILEGES`, `REASSIGN OWNED`, `DROP OWNED`: accepted, recorded nowhere */
export interface RoleUtilityStmt {
  readonly type: "role_utility";
  /** also `ALTER SCHEMA / SEQUENCE / TYPE ... OWNER TO role`: the role must exist; ownership is not recorded */
  readonly what:
    | "ALTER DEFAULT PRIVILEGES"
    | "REASSIGN OWNED"
    | "DROP OWNED"
    | "ALTER SCHEMA"
    | "ALTER SEQUENCE"
    | "ALTER TYPE";
  readonly roles: string[];
  /** the object of `ALTER ... OWNER TO` */
  readonly target?: string[];
}

// --- row-level security -------------------------------------------------------

export type PolicyCommand = "all" | "select" | "insert" | "update" | "delete";

export interface CreatePolicyStmt {
  readonly type: "create_policy";
  readonly name: string;
  readonly table: string[];
  readonly permissive: boolean;
  readonly command: PolicyCommand;
  readonly roles: string[];
  readonly using: Expr | null;
  readonly check: Expr | null;
}

export interface AlterPolicyStmt {
  readonly type: "alter_policy";
  readonly name: string;
  readonly table: string[];
  readonly renameTo: string | null;
  readonly roles: string[] | null;
  readonly using: Expr | null;
  readonly check: Expr | null;
}

// --- composite types ----------------------------------------------------------

export interface CompositeAttributeDef {
  readonly name: string;
  readonly typeName: TypeName;
  readonly collate: string[] | null;
}

export interface CreateCompositeTypeStmt {
  readonly type: "create_composite_type";
  readonly name: string[];
  readonly attributes: CompositeAttributeDef[];
}

export type AlterCompositeTypeAction =
  | { readonly kind: "add_attribute"; readonly attribute: CompositeAttributeDef; readonly cascade: boolean }
  | { readonly kind: "drop_attribute"; readonly name: string; readonly ifExists: boolean; readonly cascade: boolean }
  | { readonly kind: "alter_attribute_type"; readonly name: string; readonly typeName: TypeName }
  | { readonly kind: "rename_attribute"; readonly from: string; readonly to: string };

export interface AlterCompositeTypeStmt {
  readonly type: "alter_composite_type";
  readonly name: string[];
  readonly actions: AlterCompositeTypeAction[];
}

// --- declarative partitioning -------------------------------------------------

export interface PartitionKeyDef {
  /** the column, or null for an expression key */
  readonly column: string | null;
  readonly expr: Expr | null;
}

export interface PartitionSpec {
  readonly strategy: "range" | "list" | "hash";
  readonly keys: PartitionKeyDef[];
}

/** A bound value of a range partition: an expression, or MINVALUE / MAXVALUE */
export type RangeBoundDatum =
  | { readonly kind: "value"; readonly expr: Expr }
  | { readonly kind: "minvalue" | "maxvalue" };

export type PartitionBoundSpec =
  | { readonly kind: "range"; readonly from: RangeBoundDatum[]; readonly to: RangeBoundDatum[] }
  | { readonly kind: "list"; readonly values: Expr[] }
  | { readonly kind: "hash"; readonly modulus: number; readonly remainder: number }
  | { readonly kind: "default" };

/** `CREATE TABLE name PARTITION OF parent [(constraints)] { FOR VALUES ... | DEFAULT }` */
export interface PartitionOfClause {
  readonly parent: string[];
  readonly bound: PartitionBoundSpec;
}

// --- event triggers -----------------------------------------------------------

export interface CreateEventTriggerStmt {
  readonly type: "create_event_trigger";
  readonly name: string;
  readonly event: string;
  /** WHEN TAG IN ('CREATE TABLE', ...); null when absent */
  readonly tags: string[] | null;
  readonly funcName: string[];
}

export interface AlterEventTriggerStmt {
  readonly type: "alter_event_trigger";
  readonly name: string;
  readonly action:
    | { readonly kind: "enable"; readonly mode: "O" | "R" | "A" }
    | { readonly kind: "disable" }
    | { readonly kind: "rename"; readonly to: string }
    | { readonly kind: "owner"; readonly to: string };
}

// --- JSON_TABLE ---------------------------------------------------------------

export type JsonTableBehavior =
  | { readonly kind: "error" | "null" | "empty" | "empty_array" | "empty_object" | "true" | "false" | "unknown" }
  | { readonly kind: "default"; readonly expr: Expr };

export type JsonTableColumn =
  | { readonly kind: "ordinality"; readonly name: string }
  | {
      readonly kind: "regular";
      readonly name: string;
      readonly typeName: TypeName;
      /** FORMAT JSON */
      readonly formatJson: boolean;
      readonly path: string | null;
      readonly wrapper: "without" | "conditional" | "unconditional" | null;
      readonly quotes: "keep" | "omit" | null;
      readonly onEmpty: JsonTableBehavior | null;
      readonly onError: JsonTableBehavior | null;
    }
  | {
      readonly kind: "exists";
      readonly name: string;
      readonly typeName: TypeName;
      readonly path: string | null;
      readonly onError: JsonTableBehavior | null;
    }
  | {
      readonly kind: "nested";
      readonly path: string;
      readonly pathName: string | null;
      readonly columns: JsonTableColumn[];
    };

export interface FromJsonTable {
  readonly type: "from_json_table";
  readonly context: Expr;
  readonly path: string;
  readonly pathName: string | null;
  readonly passing: ReadonlyArray<{ readonly name: string; readonly expr: Expr }>;
  readonly columns: JsonTableColumn[];
  readonly onError: JsonTableBehavior | null;
  readonly lateral: boolean;
  readonly alias: string | null;
  readonly colAliases: string[] | null;
}

export type Statement692 =
  | DeclareCursorStmt
  | FetchStmt
  | CloseCursorStmt
  | CreateRoleStmt
  | AlterRoleStmt
  | DropRoleStmt
  | GrantRoleStmt
  | GrantStmt
  | RoleUtilityStmt
  | CreatePolicyStmt
  | AlterPolicyStmt
  | CreateCompositeTypeStmt
  | AlterCompositeTypeStmt
  | CreateEventTriggerStmt
  | AlterEventTriggerStmt;
