import type { AlterPolicyStmt, CreatePolicyStmt, Expr, PolicyCommand } from "../ast/nodes.ts";
import { pgError } from "../errors/error.ts";
import { type PolicyData, tableExt, withTableExt } from "../storage/catalog-ext.ts";
import type { DatabaseState, TableData } from "../storage/database-state.ts";
import { currentRole, findRole, hasPrivsOfRole, PUBLIC_ROLE_OID } from "../storage/roles.ts";
import type { Datum } from "../types/value.ts";
import { commandResult, type ExecEnv, type ExecResult, RowScope } from "./relation.ts";
import { registerScanHooks } from "./scan.ts";
import { evalPredicate } from "./select.ts";
import { systemColumns } from "./system-columns.ts";

/**
 * Row-level security (https://www.postgresql.org/docs/18/ddl-rowsecurity.html): CREATE / ALTER /
 * DROP POLICY, `ALTER TABLE ... { ENABLE | DISABLE | [NO] FORCE } ROW LEVEL SECURITY`, and the
 * policies' effect on SELECT, INSERT, UPDATE and DELETE for the current role.
 *
 * A table's policies apply when row security is enabled on it and the current role is neither a
 * superuser nor BYPASSRLS, nor the table's owner (unless FORCE). A row is visible when it passes any
 * permissive policy and every restrictive one for the command; with no permissive policy nothing is
 * visible (default deny). New rows must pass the WITH CHECK expressions (the USING expression of a
 * policy without one).
 */

function requireTable(state: DatabaseState, name: string[]): TableData {
  const table = state.findTable(name);
  if (!table) throw pgError("undefined_table", `relation "${name.join(".")}" does not exist`, "42P01");
  return table;
}

function assertOwner(state: DatabaseState, table: TableData): void {
  const me = currentRole(state);
  const owner = tableExt(state.catalogExt, table.oid).owner ?? 10;
  if (!hasPrivsOfRole(state.catalogExt, me, owner)) {
    throw pgError("misuse", `must be owner of table ${table.name}`, "42501");
  }
}

function policyRoles(state: DatabaseState, names: string[]): number[] {
  const oids: number[] = [];
  for (const name of names) {
    if (name === "public") oids.push(PUBLIC_ROLE_OID);
    else {
      const role = findRole(state, name === "current_user" || name === "current_role" ? currentRole(state).name : name);
      if (!role) throw pgError("undefined_object", `role "${name}" does not exist`, "42704");
      oids.push(role.oid);
    }
  }
  return [...new Set(oids)].sort((a, b) => a - b);
}

function checkClauses(command: PolicyCommand, using: Expr | null, check: Expr | null): void {
  if ((command === "select" || command === "delete") && check) {
    throw pgError("syntax", "WITH CHECK cannot be applied to SELECT or DELETE", "42601");
  }
  if (command === "insert" && using) {
    throw pgError("syntax", "only WITH CHECK expression allowed for INSERT", "42601");
  }
}

export function executeCreatePolicy(env: ExecEnv, stmt: CreatePolicyStmt): ExecResult {
  const state = env.ctx.state;
  const table = requireTable(state, stmt.table);
  checkClauses(stmt.command, stmt.using, stmt.check);
  const policies = tableExt(state.catalogExt, table.oid).policies ?? [];
  if (policies.some((p) => p.name === stmt.name)) {
    throw pgError("duplicate_object", `policy "${stmt.name}" for table "${table.name}" already exists`, "42710");
  }
  const roles = policyRoles(state, stmt.roles);
  assertOwner(state, table);
  const policy: PolicyData = {
    oid: state.nextOid(),
    name: stmt.name,
    command: stmt.command,
    permissive: stmt.permissive,
    roles,
    using: stmt.using,
    check: stmt.check,
  };
  state.catalogExt = withTableExt(state.catalogExt, table.oid, (ext) => ({ ...ext, policies: [...policies, policy] }));
  return commandResult("CREATE POLICY", 0);
}

function requirePolicy(state: DatabaseState, table: TableData, name: string): PolicyData {
  const policy = tableExt(state.catalogExt, table.oid).policies?.find((p) => p.name === name);
  if (!policy) {
    throw pgError("undefined_object", `policy "${name}" for table "${table.name}" does not exist`, "42704");
  }
  return policy;
}

function replacePolicy(state: DatabaseState, table: TableData, old: PolicyData, next: PolicyData | null): void {
  state.catalogExt = withTableExt(state.catalogExt, table.oid, (ext) => ({
    ...ext,
    policies: (ext.policies ?? []).flatMap((p) => (p.oid === old.oid ? (next ? [next] : []) : [p])),
  }));
}

export function executeAlterPolicy(env: ExecEnv, stmt: AlterPolicyStmt): ExecResult {
  const state = env.ctx.state;
  const table = requireTable(state, stmt.table);
  const policy = requirePolicy(state, table, stmt.name);
  assertOwner(state, table);
  if (stmt.renameTo !== null) {
    if (tableExt(state.catalogExt, table.oid).policies?.some((p) => p.name === stmt.renameTo)) {
      throw pgError("duplicate_object", `policy "${stmt.renameTo}" for table "${table.name}" already exists`, "42710");
    }
    replacePolicy(state, table, policy, { ...policy, name: stmt.renameTo });
    return commandResult("ALTER POLICY", 0);
  }
  checkClauses(policy.command, stmt.using, stmt.check);
  replacePolicy(state, table, policy, {
    ...policy,
    roles: stmt.roles ? policyRoles(state, stmt.roles) : policy.roles,
    using: stmt.using ?? policy.using,
    check: stmt.check ?? policy.check,
  });
  return commandResult("ALTER POLICY", 0);
}

/** DROP POLICY [IF EXISTS] name ON table */
export function dropPolicy(env: ExecEnv, name: string, tableName: string[], ifExists: boolean): void {
  const state = env.ctx.state;
  const table = requireTable(state, tableName);
  const policy = tableExt(state.catalogExt, table.oid).policies?.find((p) => p.name === name);
  if (!policy) {
    if (ifExists) return;
    requirePolicy(state, table, name);
    return;
  }
  assertOwner(state, table);
  replacePolicy(state, table, policy, null);
}

/** ALTER TABLE ... { ENABLE | DISABLE } ROW LEVEL SECURITY / [NO] FORCE ROW LEVEL SECURITY */
export function alterRowSecurity(state: DatabaseState, table: TableData, enable?: boolean, force?: boolean): void {
  state.catalogExt = withTableExt(state.catalogExt, table.oid, (ext) => {
    const next = { ...ext };
    if (enable !== undefined) {
      if (enable) next.rowSecurity = true;
      else delete next.rowSecurity;
    }
    if (force !== undefined) {
      if (force) next.forceRowSecurity = true;
      else delete next.forceRowSecurity;
    }
    return next;
  });
}

// --- enforcement -----------------------------------------------------------------------------

type Command = "select" | "insert" | "update" | "delete";

/** The policies that bind the current role on `table`, or null when row security does not apply. */
function activePolicies(state: DatabaseState, table: TableData): readonly PolicyData[] | null {
  const ext = tableExt(state.catalogExt, table.oid);
  if (!ext.rowSecurity) return null;
  const me = currentRole(state);
  if (me.superuser || me.bypassrls) return null;
  const owner = ext.owner ?? 10;
  if (!ext.forceRowSecurity && hasPrivsOfRole(state.catalogExt, me, owner)) return null;
  if (state.getSetting("row_security") === "off") {
    throw pgError("misuse", `query would be affected by row-level security policy for table "${table.name}"`, "42501");
  }
  return (ext.policies ?? []).filter((p) =>
    p.roles.some((r) => r === PUBLIC_ROLE_OID || hasPrivsOfRole(state.catalogExt, me, r)),
  );
}

/** Whether row security changes what a scan of `table` sees for the current role. */
export function rowSecurityActive(state: DatabaseState, table: TableData): boolean {
  const ext = tableExt(state.catalogExt, table.oid);
  if (!ext.rowSecurity) return false;
  const me = currentRole(state);
  if (me.superuser || me.bypassrls) return false;
  return ext.forceRowSecurity === true || !hasPrivsOfRole(state.catalogExt, me, ext.owner ?? 10);
}

function applies(policy: PolicyData, command: Command): boolean {
  return policy.command === "all" || policy.command === command;
}

function rowScope(table: TableData, row: Datum[], withSystem: boolean): RowScope {
  const columns = [
    ...table.columns.map((c) => ({ name: c.name, type: c.type.id, table: table.name })),
    ...(withSystem ? systemColumns(table.name) : []),
  ];
  return new RowScope(columns, row, null, new Set([table.name]));
}

/**
 * The USING test of `command` (null when every row passes). A row passes when any permissive
 * policy's USING holds and every restrictive one's does.
 */
export function rowSecurityFilter(
  env: ExecEnv,
  table: TableData,
  command: Command,
  withSystem = false,
): ((row: Datum[]) => boolean) | null {
  const policies = activePolicies(env.ctx.state, table);
  if (policies === null) return null;
  const relevant = policies.filter((p) => applies(p, command));
  const permissive = relevant.filter((p) => p.permissive);
  const restrictive = relevant.filter((p) => !p.permissive);
  const holds = (expr: Expr | null, row: Datum[]): boolean =>
    expr === null ? true : evalPredicate(env, rowScope(table, row, withSystem), expr);
  return (row) => permissive.some((p) => holds(p.using, row)) && restrictive.every((p) => holds(p.using, row));
}

/** WITH CHECK of a new row for INSERT or UPDATE (`42501` when it fails). */
export function checkRowSecurity(env: ExecEnv, table: TableData, command: "insert" | "update", row: Datum[]): void {
  const policies = activePolicies(env.ctx.state, table);
  if (policies === null) return;
  const relevant = policies.filter((p) => applies(p, command));
  const expr = (p: PolicyData) => p.check ?? (command === "update" || p.command === "all" ? p.using : null);
  const holds = (e: Expr | null): boolean => e === null || evalPredicate(env, rowScope(table, row, false), e);
  const permissive = relevant.filter((p) => p.permissive);
  const ok =
    permissive.some((p) => holds(expr(p))) && relevant.filter((p) => !p.permissive).every((p) => holds(expr(p)));
  if (!ok) {
    throw pgError("misuse", `new row violates row-level security policy for table "${table.name}"`, "42501");
  }
}

/** A row INSERT / UPDATE ... RETURNING hands back must also pass the SELECT policies. */
export function checkReturnedRowVisible(env: ExecEnv, table: TableData, row: Datum[]): void {
  const visible = rowSecurityFilter(env, table, "select");
  if (visible && !visible(row)) {
    throw pgError("misuse", `new row violates row-level security policy for table "${table.name}"`, "42501");
  }
}

registerScanHooks({
  filter(env, table, rows) {
    const visible = rowSecurityFilter(env, table, "select", true);
    return visible ? rows.filter(visible) : rows;
  },
  plain(env, table) {
    return !rowSecurityActive(env.ctx.state, table);
  },
});
