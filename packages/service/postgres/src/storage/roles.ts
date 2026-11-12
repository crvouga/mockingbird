import type { CatalogExt, RoleData } from "./catalog-ext.ts";
import type { DatabaseState } from "./database-state.ts";

/**
 * Who the session is: `session_user` (the `session_authorization` setting, the bootstrap superuser
 * by default) and `current_user` (the `role` setting when it is not `none`). Both are ordinary
 * settings, so they are per session over the wire, transactional, and `SET LOCAL`-able.
 */

export const PUBLIC_ROLE_OID = 0;

export function findRole(state: DatabaseState, name: string): RoleData | undefined {
  return state.catalogExt.roles.get(name);
}

export function roleByOid(ext: CatalogExt, oid: number): RoleData | undefined {
  for (const role of ext.roles.values()) if (role.oid === oid) return role;
  return undefined;
}

export function sessionUserName(state: DatabaseState): string {
  const value = state.getSetting("session_authorization");
  return value && value !== "default" ? value : "postgres";
}

export function currentUserName(state: DatabaseState): string {
  const role = state.getSetting("role");
  return role && role !== "none" ? role : sessionUserName(state);
}

/** The current role's catalog entry (the bootstrap superuser if the setting names a role since dropped). */
export function currentRole(state: DatabaseState): RoleData {
  return findRole(state, currentUserName(state)) ?? state.catalogExt.roles.get("postgres")!;
}

export function sessionRole(state: DatabaseState): RoleData {
  return findRole(state, sessionUserName(state)) ?? state.catalogExt.roles.get("postgres")!;
}

/**
 * The roles `member` is a member of, directly or through other roles. `via` limits the walk to
 * memberships granted WITH INHERIT (whose privileges the member has) or WITH SET (that SET ROLE can
 * assume); `any` follows every membership.
 */
export function rolesOf(ext: CatalogExt, member: number, via: "inherit" | "set" | "any"): Set<number> {
  const out = new Set<number>([member]);
  const queue = [member];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const m of ext.memberships) {
      if (m.member !== current || out.has(m.role)) continue;
      if (via === "inherit" && !m.inherit) continue;
      if (via === "set" && !m.set) continue;
      out.add(m.role);
      queue.push(m.role);
    }
  }
  return out;
}

/** Whether `member` has the privileges of `role` (has_privs_of_role): superusers have every role's. */
export function hasPrivsOfRole(ext: CatalogExt, member: RoleData, role: number): boolean {
  if (member.superuser || member.oid === role) return true;
  return rolesOf(ext, member.oid, "inherit").has(role);
}
