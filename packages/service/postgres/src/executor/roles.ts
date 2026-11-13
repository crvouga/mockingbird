import type {
  AlterRoleStmt,
  CreateRoleStmt,
  DropRoleStmt,
  GrantRoleStmt,
  GrantStmt,
  RoleOption,
  RoleUtilityStmt,
  SetStmt,
} from "../ast/nodes.ts";
import { pgError } from "../errors/error.ts";
import { type CatalogExt, type GrantData, isBuiltinRole, type RoleData, withTableExt } from "../storage/catalog-ext.ts";
import type { DatabaseState } from "../storage/database-state.ts";
import {
  currentRole,
  currentUserName,
  findRole,
  PUBLIC_ROLE_OID,
  roleByOid,
  rolesOf,
  sessionRole,
  sessionUserName,
} from "../storage/roles.ts";
import { encryptPassword } from "../storage/password.ts";
import { databaseCatalogContext } from "../runtime/database-context.ts";
import { commandResult, type ExecEnv, type ExecResult } from "./relation.ts";

/**
 * Roles (https://www.postgresql.org/docs/18/user-manag.html): CREATE / ALTER / DROP ROLE, role
 * membership (GRANT role TO role), SET ROLE / SET SESSION AUTHORIZATION, and GRANT / REVOKE of
 * object privileges.
 *
 * Enforced: who may create, alter, drop and grant roles, and which roles SET ROLE may assume. Object
 * privileges are recorded (pg_class.relacl, has_table_privilege, information_schema) but not
 * enforced: a role without SELECT on a table can still read it (see COMPATIBILITY.md).
 */

const RESERVED_ROLE_NAMES = new Set(["public", "none"]);

function updateExt(state: DatabaseState, change: (ext: CatalogExt) => CatalogExt): void {
  state.catalogExt = change(state.catalogExt);
}

function requireRole(state: DatabaseState, name: string, sqlstate = "42704"): RoleData {
  const role = findRole(state, resolveRoleSpec(state, name));
  if (!role) {
    throw pgError(
      sqlstate === "22023" ? "invalid_parameter_value" : "undefined_object",
      `role "${name}" does not exist`,
      sqlstate,
    );
  }
  return role;
}

/** CURRENT_USER / CURRENT_ROLE / SESSION_USER as a role specification. */
function resolveRoleSpec(state: DatabaseState, name: string): string {
  if (name === "current_user" || name === "current_role") return currentUserName(state);
  if (name === "session_user") return sessionUserName(state);
  return name;
}

/** Grantee oid: PUBLIC is 0. */
function granteeOid(state: DatabaseState, name: string): number {
  if (name === "public") return PUBLIC_ROLE_OID;
  return requireRole(state, name).oid;
}

function permissionDenied(message: string): never {
  throw pgError("misuse", message, "42501");
}

/** CREATEROLE or superuser may manage roles; only a superuser may manage superusers. */
function assertCanManageRoles(state: DatabaseState, action: "create" | "alter" | "drop", target?: RoleData): void {
  const me = currentRole(state);
  if (me.superuser) return;
  if (!me.createrole || target?.superuser) permissionDenied(`permission denied to ${action} role`);
}

/** Store a new password as PostgreSQL does: as a SCRAM-SHA-256 verifier with a fresh salt. */
function encryptRolePassword(state: DatabaseState, role: RoleData, options: RoleOption[]): RoleData {
  if (role.password === null || !options.some((o) => o.kind === "password")) return role;
  const salt = new Uint8Array(16).map(() => state.prng.nextInt(0, 255));
  return { ...role, password: encryptPassword(role.password, salt) };
}

function applyRoleOptions(base: RoleData, options: RoleOption[]): RoleData {
  const seen = new Set<string>();
  let role: RoleData = base;
  for (const option of options) {
    const key = option.kind === "flag" ? option.name : option.kind;
    if (seen.has(key)) throw pgError("syntax", "conflicting or redundant options", "42601");
    seen.add(key);
    switch (option.kind) {
      case "flag":
        role = { ...role, [option.name === "login" ? "login" : option.name]: option.value };
        break;
      case "password":
        role = { ...role, password: option.value === null || option.value === "" ? null : option.value };
        break;
      case "connection_limit":
        if (option.value < -1) {
          throw pgError("invalid_parameter_value", `invalid connection limit: ${option.value}`, "22023");
        }
        role = { ...role, connlimit: option.value };
        break;
      case "valid_until":
        role = { ...role, validUntil: option.value };
        break;
      default:
        break;
    }
  }
  return role;
}

function addMembership(
  state: DatabaseState,
  role: RoleData,
  member: RoleData,
  options: { admin: boolean; inherit: boolean | null; set: boolean | null },
): void {
  if (role.oid === member.oid || rolesOf(state.catalogExt, role.oid, "any").has(member.oid)) {
    throw pgError("misuse", `role "${role.name}" is a member of role "${member.name}"`, "0LP01");
  }
  if (role.oid === 10) {
    throw pgError("misuse", `role "${role.name}" cannot have explicit members`, "0LP01");
  }
  const grantor = currentRole(state).oid === role.oid ? 10 : currentRole(state).superuser ? 10 : currentRole(state).oid;
  updateExt(state, (ext) => {
    const existing = ext.memberships.find(
      (m) => m.role === role.oid && m.member === member.oid && m.grantor === grantor,
    );
    if (existing) {
      const merged = {
        ...existing,
        admin: existing.admin || options.admin,
        inherit: options.inherit ?? existing.inherit,
        set: options.set ?? existing.set,
      };
      return { ...ext, memberships: ext.memberships.map((m) => (m === existing ? merged : m)) };
    }
    return {
      ...ext,
      memberships: [
        ...ext.memberships,
        {
          oid: state.nextOid(),
          role: role.oid,
          member: member.oid,
          grantor,
          admin: options.admin,
          inherit: options.inherit ?? member.inherit,
          set: options.set ?? true,
        },
      ],
    };
  });
}

export function executeCreateRole(env: ExecEnv, stmt: CreateRoleStmt): ExecResult {
  const state = env.ctx.state;
  const name = stmt.name;
  if (RESERVED_ROLE_NAMES.has(name) || name.startsWith("pg_")) {
    throw pgError("misuse", `role name "${name}" is reserved`, "42939");
  }
  assertCanManageRoles(state, "create");
  if (findRole(state, name)) throw pgError("duplicate_object", `role "${name}" already exists`, "42710");
  const role = applyRoleOptions(
    {
      oid: state.nextOid(),
      name,
      superuser: false,
      inherit: true,
      createrole: false,
      createdb: false,
      login: stmt.kind === "user",
      replication: false,
      bypassrls: false,
      connlimit: -1,
      password: null,
      validUntil: null,
    },
    stmt.options,
  );
  if (role.superuser && !currentRole(state).superuser) permissionDenied("permission denied to create role");
  const stored = encryptRolePassword(state, role, stmt.options);
  // check every named role before changing anything
  const lists = stmt.options.flatMap((o) =>
    o.kind === "in_role" || o.kind === "role" || o.kind === "admin"
      ? [{ kind: o.kind, roles: o.roles.map((r) => requireRole(state, r)) }]
      : [],
  );
  updateExt(state, (ext) => ({ ...ext, roles: new Map([...ext.roles, [name, stored]]) }));
  for (const list of lists) {
    for (const other of list.roles) {
      if (list.kind === "in_role") addMembership(state, other, stored, { admin: false, inherit: null, set: null });
      else addMembership(state, stored, other, { admin: list.kind === "admin", inherit: null, set: null });
    }
  }
  return commandResult("CREATE ROLE", 0);
}

function replaceRole(state: DatabaseState, old: RoleData, next: RoleData): void {
  updateExt(state, (ext) => {
    const roles = new Map<string, RoleData>();
    for (const [key, value] of ext.roles) {
      if (key === old.name) roles.set(next.name, next);
      else roles.set(key, value);
    }
    return { ...ext, roles };
  });
}

/** The SET / RESET of one pg_db_role_setting entry: the new settings, in PostgreSQL's order (a changed name keeps its place). */
function changeSettings(
  current: Readonly<Record<string, string>>,
  action: Extract<AlterRoleStmt["action"], { kind: "set" | "reset" }>,
): Record<string, string> {
  const settings = { ...current };
  if (action.kind === "set" && action.value !== null) settings[action.setting] = action.value;
  else if (action.kind === "reset" && action.setting === "all")
    for (const key of Object.keys(settings)) delete settings[key];
  else delete settings[action.setting];
  return settings;
}

/** `ALTER ROLE ALL ...`, `ALTER ROLE r IN DATABASE d ...`, `ALTER DATABASE d SET / RESET`. */
function alterScopedSettings(env: ExecEnv, stmt: AlterRoleStmt, role: RoleData | null): ExecResult {
  const state = env.ctx.state;
  const action = stmt.action;
  const tag = stmt.tag ?? "ALTER ROLE";
  if (action.kind !== "set" && action.kind !== "reset") throw pgError("syntax", "expected SET or RESET", "42601");
  const database = stmt.database ?? null;
  if (database !== null && !databaseCatalogContext(state).names().includes(database)) {
    throw pgError("undefined_object", `database "${database}" does not exist`, "3D000");
  }
  const me = currentRole(state);
  // a role's own defaults need CREATEROLE (or being that role); every role's need a superuser
  if (role === null ? !me.superuser : me.oid !== role.oid && !me.superuser) {
    if (role === null)
      permissionDenied(stmt.tag ? `must be owner of database ${database}` : "permission denied to alter role");
    assertCanManageRoles(state, "alter", role);
  }
  const roleOid = role?.oid ?? 0;
  updateExt(state, (ext) => {
    const rows = (ext.dbRoleSettings ?? []).slice();
    const index = rows.findIndex((r) => r.database === database && r.role === roleOid);
    const settings = changeSettings(index >= 0 ? rows[index]!.settings : {}, action);
    if (Object.keys(settings).length === 0) {
      if (index >= 0) rows.splice(index, 1);
    } else if (index >= 0) rows[index] = { database, role: roleOid, settings };
    else rows.push({ database, role: roleOid, settings });
    const { dbRoleSettings: _old, ...rest } = ext;
    return rows.length > 0 ? { ...rest, dbRoleSettings: rows } : rest;
  });
  return commandResult(tag, 0);
}

export function executeAlterRole(env: ExecEnv, stmt: AlterRoleStmt): ExecResult {
  const state = env.ctx.state;
  if (stmt.allRoles) return alterScopedSettings(env, stmt, null);
  const role = requireRole(state, stmt.name);
  if (stmt.database !== undefined) return alterScopedSettings(env, stmt, role);
  const action = stmt.action;
  const me = currentRole(state);
  switch (action.kind) {
    case "options": {
      // a role may change its own password; everything else needs CREATEROLE (superuser for superusers)
      const passwordOnly = action.options.every((o) => o.kind === "password");
      if (!(passwordOnly && me.oid === role.oid)) assertCanManageRoles(state, "alter", role);
      const next = encryptRolePassword(state, applyRoleOptions(role, action.options), action.options);
      if (
        !me.superuser &&
        (next.superuser !== role.superuser ||
          next.replication !== role.replication ||
          next.bypassrls !== role.bypassrls)
      ) {
        permissionDenied("permission denied to alter role");
      }
      replaceRole(state, role, next);
      return commandResult("ALTER ROLE", 0);
    }
    case "rename": {
      if (role.oid === sessionRole(state).oid) {
        throw pgError("feature_not_supported", "session user cannot be renamed", "0A000");
      }
      if (role.oid === currentRole(state).oid) {
        throw pgError("feature_not_supported", "current user cannot be renamed", "0A000");
      }
      if (isBuiltinRole(role)) {
        throw pgError("misuse", `role name "${role.name}" is reserved`, "42939");
      }
      if (RESERVED_ROLE_NAMES.has(action.to) || action.to.startsWith("pg_")) {
        throw pgError("misuse", `role name "${action.to}" is reserved`, "42939");
      }
      assertCanManageRoles(state, "alter", role);
      if (findRole(state, action.to)) throw pgError("duplicate_object", `role "${action.to}" already exists`, "42710");
      replaceRole(state, role, { ...role, name: action.to });
      return commandResult("ALTER ROLE", 0);
    }
    case "set":
    case "reset": {
      if (me.oid !== role.oid) assertCanManageRoles(state, "alter", role);
      const settings = changeSettings(role.settings ?? {}, action);
      const { settings: _old, ...rest } = role;
      replaceRole(state, role, Object.keys(settings).length > 0 ? { ...rest, settings } : rest);
      return commandResult("ALTER ROLE", 0);
    }
  }
}

/** What depends on a role: the objects it owns and the privileges granted to it. */
function roleDependents(state: DatabaseState, role: RoleData): string[] {
  const out: string[] = [];
  for (const grant of state.catalogExt.grants) {
    if (grant.grantee === role.oid && grant.privileges !== "") out.push(`privileges for ${grant.objectKind}`);
  }
  for (const [, ext] of state.catalogExt.tables) {
    if (ext.owner === role.oid) out.push("owner of table");
    for (const policy of ext.policies ?? []) if (policy.roles.includes(role.oid)) out.push("target of policy");
  }
  return out;
}

export function executeDropRole(env: ExecEnv, stmt: DropRoleStmt): ExecResult {
  const state = env.ctx.state;
  const dropping: RoleData[] = [];
  for (const name of stmt.names) {
    const role = findRole(state, resolveRoleSpec(state, name));
    if (!role) {
      if (stmt.ifExists) continue;
      throw pgError("undefined_object", `role "${name}" does not exist`, "42704");
    }
    if (role.oid === currentRole(state).oid) {
      throw pgError("object_not_in_prerequisite_state", "current user cannot be dropped", "55006");
    }
    if (role.oid === sessionRole(state).oid) {
      throw pgError("object_not_in_prerequisite_state", "session user cannot be dropped", "55006");
    }
    if (isBuiltinRole(role)) {
      throw pgError(
        "dependent_objects",
        `cannot drop role ${role.name} because it is required by the database system`,
        "2BP01",
      );
    }
    assertCanManageRoles(state, "drop", role);
    if (roleDependents(state, role).length > 0) {
      throw pgError(
        "dependent_objects",
        `role "${role.name}" cannot be dropped because some objects depend on it`,
        "2BP01",
      );
    }
    dropping.push(role);
  }
  const oids = new Set(dropping.map((r) => r.oid));
  updateExt(state, (ext) => {
    const { dbRoleSettings, ...rest } = ext;
    // its pg_db_role_setting rows go with the role
    const settings = dbRoleSettings?.filter((r) => !oids.has(r.role)) ?? [];
    return {
      ...rest,
      roles: new Map([...ext.roles].filter(([, r]) => !oids.has(r.oid))),
      memberships: ext.memberships.filter((m) => !oids.has(m.role) && !oids.has(m.member)),
      ...(settings.length > 0 ? { dbRoleSettings: settings } : {}),
    };
  });
  return commandResult("DROP ROLE", 0);
}

export function executeGrantRole(env: ExecEnv, stmt: GrantRoleStmt): ExecResult {
  const state = env.ctx.state;
  const roles = stmt.roles.map((r) => requireRole(state, r));
  const members = stmt.grantees.map((r) => requireRole(state, r));
  const me = currentRole(state);
  for (const role of roles) {
    const adminOf = state.catalogExt.memberships.some(
      (m) => m.role === role.oid && rolesOf(state.catalogExt, me.oid, "any").has(m.member) && m.admin,
    );
    if (!me.superuser && !me.createrole && !adminOf) {
      permissionDenied(`permission denied to ${stmt.revoke ? "revoke" : "grant"} role "${role.name}"`);
    }
  }
  for (const role of roles) {
    for (const member of members) {
      if (!stmt.revoke) {
        addMembership(state, role, member, { admin: stmt.admin, inherit: stmt.inherit, set: stmt.set });
        continue;
      }
      updateExt(state, (ext) => ({
        ...ext,
        memberships: ext.memberships.flatMap((m) => {
          if (m.role !== role.oid || m.member !== member.oid) return [m];
          // REVOKE ADMIN / INHERIT / SET OPTION FOR keeps the membership without the option
          if (stmt.admin) return [{ ...m, admin: false }];
          if (stmt.inherit === false) return [{ ...m, inherit: false }];
          if (stmt.set === false) return [{ ...m, set: false }];
          return [];
        }),
      }));
    }
  }
  return commandResult(stmt.revoke ? "REVOKE ROLE" : "GRANT ROLE", 0);
}

// --- object privileges ------------------------------------------------------------

const PRIVILEGE_LETTERS: Record<string, string> = {
  select: "r",
  insert: "a",
  update: "w",
  delete: "d",
  truncate: "D",
  references: "x",
  trigger: "t",
  maintain: "m",
  execute: "X",
  usage: "U",
  create: "C",
  connect: "c",
  temporary: "T",
  set: "s",
  "alter system": "A",
};

/** Every privilege an object kind has (what ALL means), in aclitem order. */
const ALL_PRIVILEGES: Record<string, string> = {
  table: "arwdDxtm",
  sequence: "rwU",
  schema: "UC",
  function: "X",
  procedure: "X",
  routine: "X",
  database: "CTc",
  type: "U",
  domain: "U",
  language: "U",
};

/** Resolve the objects a GRANT names to (kind, oid) pairs, checking they exist. */
function grantTargets(state: DatabaseState, stmt: GrantStmt): Array<{ kind: string; oid: number }> {
  const out: Array<{ kind: string; oid: number }> = [];
  const kind = stmt.objectKind === "procedure" || stmt.objectKind === "routine" ? "function" : stmt.objectKind;
  if (stmt.allInSchema) {
    for (const schemaName of stmt.allInSchema) {
      const schema = state.getSchema(schemaName);
      if (kind === "table") {
        for (const t of schema.tables.values()) out.push({ kind: "table", oid: t.oid });
        for (const v of schema.views.values()) out.push({ kind: "table", oid: v.oid });
      } else if (kind === "sequence") {
        for (const s of schema.sequences.values()) out.push({ kind: "sequence", oid: s.oid });
      } else if (kind === "function") {
        for (const overloads of schema.functions.values())
          for (const f of overloads) out.push({ kind: "function", oid: f.oid });
      }
    }
    return out;
  }
  for (const name of stmt.objects) {
    switch (kind) {
      case "table":
      case "sequence": {
        const relation = state.findTable(name) ?? state.findView(name) ?? state.findSequence(name);
        if (!relation) throw pgError("undefined_table", `relation "${name.join(".")}" does not exist`, "42P01");
        const isSequence = state.findSequence(name) === relation;
        if (kind === "sequence" && !isSequence) {
          throw pgError("wrong_object_type", `"${name.join(".")}" is not a sequence`, "42809");
        }
        out.push({ kind: isSequence ? "sequence" : "table", oid: relation.oid });
        break;
      }
      case "schema":
        out.push({ kind: "schema", oid: state.getSchema(name.join(".")).oid });
        break;
      case "function": {
        const fns = state.findFunctions(name);
        if (fns.length === 0) {
          throw pgError("undefined_function", `function ${name.join(".")} does not exist`, "42883");
        }
        for (const fn of fns) out.push({ kind: "function", oid: fn.oid });
        break;
      }
      default:
        // databases, types, languages, ...: accepted, not recorded
        break;
    }
  }
  return out;
}

function privilegeLetters(kind: string, privileges: GrantStmt["privileges"]): string {
  const all = ALL_PRIVILEGES[kind] ?? "";
  let letters = "";
  for (const p of privileges) {
    if (p.name === "all") letters += all;
    else {
      const letter = PRIVILEGE_LETTERS[p.name];
      if (letter === undefined || (all !== "" && !all.includes(letter))) {
        throw pgError(
          "misuse",
          `invalid privilege type ${p.name.toUpperCase()} for ${kind === "table" ? "relation" : kind}`,
          "0LP01",
        );
      }
      letters += letter;
    }
  }
  return [...all].filter((l) => letters.includes(l)).join("");
}

/** Object owner: tables carry it in their extension data; everything else belongs to the bootstrap superuser. */
export function objectOwner(state: DatabaseState, kind: string, oid: number): number {
  if (kind === "table" || kind === "sequence") return state.catalogExt.tables.get(oid)?.owner ?? 10;
  return 10;
}

export function executeGrant(env: ExecEnv, stmt: GrantStmt): ExecResult {
  const state = env.ctx.state;
  const grantees = stmt.grantees.map((g) => granteeOid(state, g));
  const targets = grantTargets(state, stmt);
  for (const target of targets) {
    // a superuser (or the owner) grants as the object's owner
    const grantor = objectOwner(state, target.kind, target.oid);
    const letters = privilegeLetters(target.kind, stmt.privileges);
    updateExt(state, (ext) => {
      let grants = ext.grants.slice();
      const owner = objectOwner(state, target.kind, target.oid);
      // the first GRANT / REVOKE on an object materializes the owner's implicit privileges
      if (!grants.some((g) => g.objectOid === target.oid)) {
        const all = ALL_PRIVILEGES[target.kind] ?? "";
        grants.push({
          objectKind: target.kind,
          objectOid: target.oid,
          grantee: owner,
          grantor: owner,
          privileges: all,
          grantable: "",
        });
        // a function's default ACL also lets PUBLIC execute it (acldefault: {=X/owner, owner=X/owner})
        if (target.kind === "function") {
          grants.push({
            objectKind: "function",
            objectOid: target.oid,
            grantee: 0,
            grantor: owner,
            privileges: "X",
            grantable: "",
          });
        }
      }
      for (const grantee of grantees) {
        const index = grants.findIndex(
          (g) => g.objectOid === target.oid && g.grantee === grantee && g.column === undefined,
        );
        const old: GrantData =
          index >= 0
            ? grants[index]!
            : { objectKind: target.kind, objectOid: target.oid, grantee, grantor, privileges: "", grantable: "" };
        const order = ALL_PRIVILEGES[target.kind] ?? letters;
        const keep = (set: string) => [...order].filter((l) => set.includes(l)).join("");
        let next: GrantData;
        if (stmt.revoke) {
          const grantable = keep([...old.grantable].filter((l) => !letters.includes(l)).join(""));
          next = stmt.grantOption
            ? { ...old, grantable }
            : { ...old, privileges: keep([...old.privileges].filter((l) => !letters.includes(l)).join("")), grantable };
        } else {
          next = {
            ...old,
            privileges: keep(old.privileges + letters),
            grantable: stmt.grantOption ? keep(old.grantable + letters) : old.grantable,
          };
        }
        if (index >= 0) {
          if (next.privileges === "" && grantee !== owner) grants = grants.filter((_, i) => i !== index);
          else grants[index] = next;
        } else if (next.privileges !== "") grants.push(next);
      }
      return { ...ext, grants };
    });
  }
  return commandResult(stmt.revoke ? "REVOKE" : "GRANT", 0);
}

export function executeRoleUtility(env: ExecEnv, stmt: RoleUtilityStmt): ExecResult {
  const state = env.ctx.state;
  const roles = stmt.roles.map((r) => requireRole(state, r));
  if (stmt.what === "ALTER SCHEMA" && stmt.target) state.getSchema(stmt.target[0]!);
  if (stmt.what === "ALTER SEQUENCE" && stmt.target) {
    const sequence = state.findSequence(stmt.target);
    if (!sequence) throw pgError("undefined_table", `relation "${stmt.target.join(".")}" does not exist`, "42P01");
    alterTableOwner(state, sequence, roles[0]!.name);
  }
  if (stmt.what === "DROP OWNED") {
    const oids = new Set(roles.map((r) => r.oid));
    updateExt(state, (ext) => ({ ...ext, grants: ext.grants.filter((g) => !oids.has(g.grantee) || g.grantee === 10) }));
  } else if (stmt.what === "REASSIGN OWNED") {
    const to = roles.pop()!;
    const from = new Set(roles.map((r) => r.oid));
    updateExt(state, (ext) => {
      const tables = new Map(ext.tables);
      for (const [oid, t] of tables) {
        if (t.owner !== undefined && from.has(t.owner))
          tables.set(oid, { ...t, owner: to.oid === 10 ? undefined : to.oid });
      }
      return { ...ext, tables };
    });
  }
  return commandResult(stmt.what, 0);
}

// --- SET ROLE / SET SESSION AUTHORIZATION ------------------------------------------------

/** `SET [LOCAL] ROLE` and `SET [LOCAL] SESSION AUTHORIZATION`; RESET is a value of null. */
export function executeSetRole(
  env: ExecEnv,
  stmt: SetStmt,
  apply: (name: string, value: string | null) => void,
): ExecResult {
  const state = env.ctx.state;
  if (stmt.name === "session_authorization") {
    if (stmt.value === null) {
      apply("session_authorization", null);
      apply("role", null);
      return commandResult(stmt.local ? "SET" : "SET", 0);
    }
    const role = requireRole(state, stmt.value);
    // the authenticated user (the bootstrap superuser here) may become anyone
    apply("session_authorization", role.name);
    apply("role", null);
    return commandResult("SET", 0);
  }
  if (stmt.value === null || stmt.value === "none") {
    apply("role", null);
    return commandResult("SET", 0);
  }
  const role = requireRole(state, stmt.value, "22023");
  const session = sessionRole(state);
  if (!session.superuser && role.oid !== session.oid && !rolesOf(state.catalogExt, session.oid, "set").has(role.oid)) {
    permissionDenied(`permission denied to set role "${role.name}"`);
  }
  apply("role", role.name);
  return commandResult("SET", 0);
}

/** `pg_has_role(user, role, 'MEMBER' | 'USAGE' | 'SET')`. */
export function pgHasRole(ext: CatalogExt, member: RoleData, role: RoleData, mode: string): boolean {
  if (member.superuser || member.oid === role.oid) return true;
  const kind = mode.toLowerCase().includes("usage") ? "inherit" : mode.toLowerCase().includes("set") ? "set" : "any";
  return rolesOf(ext, member.oid, kind).has(role.oid);
}

/** ALTER TABLE ... OWNER TO role: recorded as relowner (the role must exist). */
export function alterTableOwner(state: DatabaseState, table: { oid: number }, roleName: string): void {
  const role = requireRole(state, roleName);
  state.catalogExt = withTableExt(state.catalogExt, table.oid, (ext) => {
    const { owner: _owner, ...rest } = ext;
    return role.oid === 10 ? rest : { ...rest, owner: role.oid };
  });
}

export { roleByOid };
