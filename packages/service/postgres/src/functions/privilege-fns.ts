import { pgError } from "../errors/error.ts";
import type { EngineCtx } from "../expressions/context.ts";
import type { RoleData } from "../storage/catalog-ext.ts";
import type { DatabaseState } from "../storage/database-state.ts";
import { currentRole, findRole, hasPrivsOfRole, roleByOid, rolesOf } from "../storage/roles.ts";
import { castTo } from "../types/cast.ts";
import { type TypedValue, tv } from "../types/value.ts";
import { quoteIdentifier } from "../sql/keywords.ts";
import { deparseRuleExpr } from "../sql/ruleutils.ts";
import { tableRewriteInfo } from "../executor/event-trigger-context.ts";
import type { ScalarFn } from "./util.ts";

/**
 * Privilege inquiry functions over the recorded grants (issue #692): `has_table_privilege`,
 * `has_schema_privilege`, `has_column_privilege`, `has_sequence_privilege`, `pg_has_role`,
 * `pg_get_userbyid`. An object's owner and superusers hold every privilege; with no GRANT / REVOKE
 * on a table only its owner has any.
 */

const TABLE_PRIVILEGES: Record<string, string> = {
  select: "r",
  insert: "a",
  update: "w",
  delete: "d",
  truncate: "D",
  references: "x",
  trigger: "t",
  maintain: "m",
  usage: "U",
};

function roleArg(ctx: EngineCtx, arg: TypedValue): RoleData {
  if (arg.t === "oid" || arg.t === "int4" || arg.t === "int8") {
    const role = roleByOid(ctx.state.catalogExt, Number(arg.v));
    if (!role) throw pgError("undefined_object", `role with OID ${arg.v} does not exist`, "42704");
    return role;
  }
  const name = castTo(ctx, arg, "text", { explicit: true }).v as string;
  if (name === "public") return { ...currentRole(ctx.state), oid: 0, name: "public", superuser: false };
  const role = findRole(ctx.state, name);
  if (!role) throw pgError("undefined_object", `role "${name}" does not exist`, "42704");
  return role;
}

function relationOidArg(ctx: EngineCtx, arg: TypedValue): number {
  if (arg.t === "oid" || arg.t === "regclass" || arg.t === "int4" || arg.t === "int8") return Number(arg.v);
  const text = castTo(ctx, arg, "text", { explicit: true }).v as string;
  return castTo(ctx, tv("unknown", text), "regclass", { explicit: true }).v as number;
}

function privilegeLetters(
  ctx: EngineCtx,
  arg: TypedValue,
  table: Record<string, string>,
): Array<{ letter: string; grant: boolean }> {
  const text = (castTo(ctx, arg, "text", { explicit: true }).v as string).toLowerCase();
  return text.split(",").map((part) => {
    const words = part.trim().replace(/\s+/g, " ");
    const grant = words.endsWith(" with grant option");
    const name = grant ? words.slice(0, -" with grant option".length) : words;
    const letter = table[name];
    if (letter === undefined) {
      throw pgError("invalid_parameter_value", `unrecognized privilege type: "${part.trim()}"`, "22023");
    }
    return { letter, grant };
  });
}

/** Whether `role` holds privilege `letter` on the object `oid` owned by `owner`. */
export function holdsPrivilege(
  state: DatabaseState,
  role: RoleData,
  oid: number,
  owner: number,
  letter: string,
  grantOption = false,
): boolean {
  if (role.superuser) return true;
  const ext = state.catalogExt;
  const acl = ext.grants.filter((g) => g.objectOid === oid && g.column === undefined);
  if (acl.length === 0) return role.oid !== 0 && hasPrivsOfRole(ext, role, owner);
  const mine = role.oid === 0 ? new Set([0]) : new Set([...rolesOf(ext, role.oid, "inherit"), 0]);
  return acl.some((g) => mine.has(g.grantee) && (grantOption ? g.grantable : g.privileges).includes(letter));
}

function tableOwner(state: DatabaseState, oid: number): number {
  return state.catalogExt.tables.get(oid)?.owner ?? 10;
}

function relationExists(state: DatabaseState, oid: number): boolean {
  for (const schema of state.schemas.values()) {
    for (const map of [schema.tables, schema.views, schema.sequences]) {
      for (const relation of map.values()) if (relation.oid === oid) return true;
    }
  }
  return false;
}

/** has_table_privilege([user,] table, privilege) and its sequence / column variants. */
function relationPrivilege(columnForm: boolean): ScalarFn {
  return (ctx, args) => {
    const explicitUser = args.length === (columnForm ? 4 : 3);
    if (args.some((a) => a.v === null)) return tv("bool", null);
    const role = explicitUser ? roleArg(ctx, args[0]!) : currentRole(ctx.state);
    const rest = explicitUser ? args.slice(1) : args;
    const oid = relationOidArg(ctx, rest[0]!);
    if (!relationExists(ctx.state, oid)) return tv("bool", null);
    const privileges = privilegeLetters(ctx, rest[columnForm ? 2 : 1]!, TABLE_PRIVILEGES);
    const owner = tableOwner(ctx.state, oid);
    return tv(
      "bool",
      privileges.some((p) => holdsPrivilege(ctx.state, role, oid, owner, p.letter, p.grant)),
    );
  };
}

const SCHEMA_PRIVILEGES: Record<string, string> = { usage: "U", create: "C" };

const hasSchemaPrivilege: ScalarFn = (ctx, args) => {
  if (args.some((a) => a.v === null)) return tv("bool", null);
  const explicitUser = args.length === 3;
  const role = explicitUser ? roleArg(ctx, args[0]!) : currentRole(ctx.state);
  const rest = explicitUser ? args.slice(1) : args;
  const name = castTo(ctx, rest[0]!, "text", { explicit: true }).v as string;
  const schema = ctx.state.schemas.get(name);
  if (!schema) throw pgError("undefined_object", `schema "${name}" does not exist`, "3F000");
  const privileges = privilegeLetters(ctx, rest[1]!, SCHEMA_PRIVILEGES);
  const granted = ctx.state.catalogExt.grants.some((g) => g.objectOid === schema.oid);
  return tv(
    "bool",
    privileges.some((p) => {
      if (granted) return holdsPrivilege(ctx.state, role, schema.oid, 10, p.letter, p.grant);
      if (role.superuser || hasPrivsOfRole(ctx.state.catalogExt, role, 10)) return true;
      // public: USAGE for everyone, CREATE for the database owner (PostgreSQL 15+)
      return name === "public" && p.letter === "U" && !p.grant;
    }),
  );
};

const pgHasRole: ScalarFn = (ctx, args) => {
  if (args.some((a) => a.v === null)) return tv("bool", null);
  const explicitUser = args.length === 3;
  const member = explicitUser ? roleArg(ctx, args[0]!) : currentRole(ctx.state);
  const rest = explicitUser ? args.slice(1) : args;
  const role = roleArg(ctx, rest[0]!);
  const mode = (castTo(ctx, rest[1]!, "text", { explicit: true }).v as string).toLowerCase();
  const ext = ctx.state.catalogExt;
  const result = mode.split(",").some((m) => {
    const kind = m.trim();
    if (member.oid === role.oid) return true;
    if (kind.startsWith("usage")) return hasPrivsOfRole(ext, member, role.oid);
    if (kind.startsWith("set")) return member.superuser || rolesOf(ext, member.oid, "set").has(role.oid);
    if (kind.startsWith("member")) return member.superuser || rolesOf(ext, member.oid, "any").has(role.oid);
    throw pgError("invalid_parameter_value", `unrecognized privilege type: "${m.trim()}"`, "22023");
  });
  return tv("bool", result);
};

const pgGetUserById: ScalarFn = (ctx, args) => {
  if (args[0]!.v === null) return tv("name", null);
  const oid = Number(args[0]!.v);
  const role = roleByOid(ctx.state.catalogExt, oid);
  return tv("name", role?.name ?? `unknown (OID=${oid})`);
};

/** pg_get_partkeydef(oid): `RANGE (d)`; NULL for a table that is not partitioned. */
const pgGetPartkeydef: ScalarFn = (ctx, args) => {
  if (args[0]!.v === null) return tv("text", null);
  const oid = Number(args[0]!.v);
  for (const schema of ctx.state.schemas.values()) {
    for (const table of schema.tables.values()) {
      if (table.oid !== oid) continue;
      const key = ctx.state.catalogExt.tables.get(oid)?.partitionKey;
      if (!key) return tv("text", null);
      const keys = key.keys.map((k) =>
        k.column !== null ? quoteIdentifier(k.column) : `(${deparseRuleExpr({ ctx, table }, k.expr!, false)})`,
      );
      return tv("text", `${key.strategy.toUpperCase()} (${keys.join(", ")})`);
    }
  }
  return tv("text", null);
};

export function registerPrivilegeFunctions(m: Map<string, ScalarFn>): void {
  m.set("pg_event_trigger_table_rewrite_oid", () => tableRewriteInfo("oid"));
  m.set("pg_event_trigger_table_rewrite_reason", () => tableRewriteInfo("reason"));
  m.set("pg_get_partkeydef", pgGetPartkeydef);
  m.set("has_table_privilege", relationPrivilege(false));
  m.set("has_sequence_privilege", relationPrivilege(false));
  m.set("has_column_privilege", relationPrivilege(true));
  m.set("has_schema_privilege", hasSchemaPrivilege);
  m.set("pg_has_role", pgHasRole);
  m.set("pg_get_userbyid", pgGetUserById);
}
