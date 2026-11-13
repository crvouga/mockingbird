/**
 * Grammar added for issue #692: cursors, roles and GRANT / REVOKE, row-level security policies,
 * composite types, declarative partitioning, event triggers and JSON_TABLE. The main parser
 * dispatches here through its {@link ParserApi} facade.
 */
import type {
  AlterCompositeTypeAction,
  AlterEventTriggerStmt,
  AlterPolicyStmt,
  AlterRoleStmt,
  CloseCursorStmt,
  CompositeAttributeDef,
  CreateCompositeTypeStmt,
  CreateEventTriggerStmt,
  CreatePolicyStmt,
  CreateRoleStmt,
  DeclareCursorStmt,
  DropRoleStmt,
  Expr,
  FetchDirection,
  FetchStmt,
  FromJsonTable,
  GrantRoleStmt,
  GrantStmt,
  JsonTableBehavior,
  JsonTableColumn,
  PartitionBoundSpec,
  PartitionKeyDef,
  PartitionSpec,
  PolicyCommand,
  RangeBoundDatum,
  RoleOption,
  RoleUtilityStmt,
  Statement,
} from "../ast/nodes.ts";
import { pgError } from "../errors/error.ts";
import type { ParserApi } from "./api.ts";

// --- helpers --------------------------------------------------------------------

function stringLiteral(p: ParserApi, what: string): string {
  const t = p.next();
  if (t.type !== "string") p.errorAt(t, `expected ${what}`);
  return t.value;
}

function signedInt(p: ParserApi): number {
  let sign = 1;
  if (p.eatOp("-")) sign = -1;
  else p.eatOp("+");
  const t = p.next();
  if (t.type !== "number" || !/^\d+$/.test(t.value)) p.errorAt(t, "expected integer");
  return sign * Number(t.value);
}

function atSignedInt(p: ParserApi): boolean {
  const t = p.peek();
  if (t.type === "number") return true;
  return (p.atOp("-") || p.atOp("+")) && p.peek(1).type === "number";
}

/** A role specification: a name, PUBLIC, CURRENT_USER / CURRENT_ROLE / SESSION_USER (kept as written). */
function roleSpec(p: ParserApi): string {
  const t = p.peek();
  if (t.type === "string") {
    p.pos++;
    return t.value;
  }
  return p.ident(true);
}

function roleList(p: ParserApi): string[] {
  const roles: string[] = [];
  do {
    p.eatKw("group");
    roles.push(roleSpec(p));
  } while (p.eatPunct(","));
  return roles;
}

function skipParens(p: ParserApi): void {
  if (!p.eatPunct("(")) return;
  let depth = 1;
  while (depth > 0) {
    const t = p.next();
    if (t.type === "eof") p.errorAt(t, 'expected ")"');
    if (t.type === "punct" && t.value === "(") depth++;
    if (t.type === "punct" && t.value === ")") depth--;
  }
}

// --- cursors --------------------------------------------------------------------

export function parseDeclareCursor(p: ParserApi, sourceOf: (start: number) => string): DeclareCursorStmt {
  const start = p.pos;
  p.expectKw("declare");
  const name = p.ident();
  let binary = false;
  let scroll: boolean | null = null;
  for (;;) {
    if (p.eatKw("binary")) binary = true;
    else if (p.eatKw("insensitive") || p.eatKw("asensitive")) continue;
    else if (p.eatKw("scroll")) scroll = true;
    else if (p.atKw("no") && p.atKw("scroll", 1)) {
      p.pos += 2;
      scroll = false;
    } else break;
  }
  p.expectKw("cursor");
  let hold = false;
  if (p.atKw("with") && p.atKw("hold", 1)) {
    p.pos += 2;
    hold = true;
  } else if (p.atKw("without") && p.atKw("hold", 1)) p.pos += 2;
  p.expectKw("for");
  const query = p.parseSelectStmt();
  return { type: "declare_cursor", name, binary, scroll, hold, query, text: sourceOf(start) };
}

export function parseFetch(p: ParserApi): FetchStmt {
  const move = p.next().value === "move";
  let direction: FetchDirection = { kind: "forward", count: 1 };
  const fromIn = () => p.eatKw("from") || p.eatKw("in");
  if (p.eatKw("next")) direction = { kind: "forward", count: 1 };
  else if (p.eatKw("prior")) direction = { kind: "backward", count: 1 };
  else if (p.eatKw("first")) direction = { kind: "absolute", count: 1 };
  else if (p.eatKw("last")) direction = { kind: "absolute", count: -1 };
  else if (p.eatKw("absolute")) direction = { kind: "absolute", count: signedInt(p) };
  else if (p.eatKw("relative")) direction = { kind: "relative", count: signedInt(p) };
  else if (p.eatKw("all")) direction = { kind: "forward", count: "all" };
  else if (p.atKw("forward") || p.atKw("backward")) {
    const kind = p.next().value as "forward" | "backward";
    if (p.eatKw("all")) direction = { kind, count: "all" };
    else if (atSignedInt(p)) {
      const n = signedInt(p);
      direction = n < 0 ? { kind: kind === "forward" ? "backward" : "forward", count: -n } : { kind, count: n };
    } else direction = { kind, count: 1 };
  } else if (atSignedInt(p)) {
    const n = signedInt(p);
    direction =
      n < 0
        ? { kind: "backward", count: -n }
        : n === 0
          ? { kind: "relative", count: 0 }
          : { kind: "forward", count: n };
  }
  fromIn();
  const cursor = p.ident();
  return { type: "fetch", move, direction, cursor };
}

export function parseCloseCursor(p: ParserApi): CloseCursorStmt {
  p.expectKw("close");
  if (p.eatKw("all")) return { type: "close_cursor", name: null };
  return { type: "close_cursor", name: p.ident() };
}

// --- roles ------------------------------------------------------------------------

const ROLE_FLAGS: Record<string, [string, boolean]> = {
  superuser: ["superuser", true],
  nosuperuser: ["superuser", false],
  createdb: ["createdb", true],
  nocreatedb: ["createdb", false],
  createrole: ["createrole", true],
  nocreaterole: ["createrole", false],
  inherit: ["inherit", true],
  noinherit: ["inherit", false],
  login: ["login", true],
  nologin: ["login", false],
  replication: ["replication", true],
  noreplication: ["replication", false],
  bypassrls: ["bypassrls", true],
  nobypassrls: ["bypassrls", false],
  createuser: ["createrole", true],
  nocreateuser: ["createrole", false],
};

function roleOptions(p: ParserApi, create: boolean): RoleOption[] {
  const options: RoleOption[] = [];
  p.eatKw("with");
  while (!p.atStatementEnd()) {
    const t = p.peek();
    const flag = t.type === "ident" ? ROLE_FLAGS[t.value] : undefined;
    if (flag) {
      p.pos++;
      options.push({ kind: "flag", name: flag[0], value: flag[1] });
      continue;
    }
    if (p.atKw("connection") && p.atKw("limit", 1)) {
      p.pos += 2;
      options.push({ kind: "connection_limit", value: signedInt(p) });
      continue;
    }
    if (p.eatKw("encrypted") || p.eatKw("unencrypted") || p.atKw("password")) {
      p.expectKw("password");
      if (p.eatKw("null")) options.push({ kind: "password", value: null });
      else options.push({ kind: "password", value: stringLiteral(p, "password") });
      continue;
    }
    if (p.atKw("valid") && p.atKw("until", 1)) {
      p.pos += 2;
      options.push({ kind: "valid_until", value: stringLiteral(p, "timestamp") });
      continue;
    }
    if (create && p.atKw("in") && (p.atKw("role", 1) || p.atKw("group", 1))) {
      p.pos += 2;
      options.push({ kind: "in_role", roles: roleList(p) });
      continue;
    }
    if (create && (p.atKw("role") || p.atKw("user"))) {
      p.pos++;
      options.push({ kind: "role", roles: roleList(p) });
      continue;
    }
    if (create && p.eatKw("admin")) {
      options.push({ kind: "admin", roles: roleList(p) });
      continue;
    }
    if (create && p.eatKw("sysid")) {
      p.next();
      options.push({ kind: "sysid" });
      continue;
    }
    p.errorAt(t, "unrecognized role option");
  }
  return options;
}

export function parseCreateRole(p: ParserApi): CreateRoleStmt {
  const kind = p.next().value as "role" | "user" | "group";
  const name = roleSpec(p);
  return { type: "create_role", name, kind, options: roleOptions(p, true) };
}

export function parseAlterRole(p: ParserApi): Statement {
  const kind = p.next().value;
  if (kind === "group") {
    // ALTER GROUP g { ADD | DROP } USER u, ...
    const group = roleSpec(p);
    const add = p.eatKw("add");
    if (!add) p.expectKw("drop");
    p.expectKw("user");
    return {
      type: "grant_role",
      revoke: !add,
      roles: [group],
      grantees: roleList(p),
      admin: false,
      inherit: null,
      set: null,
      grantedBy: null,
    } satisfies GrantRoleStmt;
  }
  // ALTER ROLE ALL [IN DATABASE d] SET / RESET: a default for every role
  const allRoles = p.eatKw("all");
  const name = allRoles ? "all" : roleSpec(p);
  let database: string | undefined;
  if (p.atKw("in") && p.atKw("database", 1)) {
    p.pos += 2;
    database = p.ident(true);
  }
  return parseAlterRoleAction(p, name, {
    ...(allRoles ? { allRoles } : {}),
    ...(database !== undefined ? { database } : {}),
  });
}

/** `ALTER DATABASE d SET / RESET ...`: the database's defaults, as ALTER ROLE ALL IN DATABASE d sets them. */
export function parseAlterDatabaseSet(p: ParserApi, database: string): AlterRoleStmt {
  return parseAlterRoleAction(p, "all", { allRoles: true, database, tag: "ALTER DATABASE" });
}

function parseAlterRoleAction(
  p: ParserApi,
  name: string,
  scope: Pick<AlterRoleStmt, "allRoles" | "database" | "tag">,
): AlterRoleStmt {
  let action: AlterRoleStmt["action"];
  if (scope.allRoles && !p.atKw("set") && !p.atKw("reset")) p.errorAt(p.peek(), "expected SET or RESET");
  if (p.eatKw("rename")) {
    p.expectKw("to");
    action = { kind: "rename", to: roleSpec(p) };
  } else if (p.eatKw("set")) {
    const setting = p.ident(true);
    if (p.atKw("from") && p.atKw("current", 1)) {
      p.pos += 2;
      action = { kind: "set", setting, value: null };
    } else {
      if (!p.eatKw("to") && !p.eatOp("=")) p.errorAt(p.peek(), "expected TO or =");
      const values: string[] = [];
      do {
        const t = p.next();
        values.push(t.value);
      } while (p.eatPunct(","));
      action = { kind: "set", setting, value: values.join(", ") };
    }
  } else if (p.eatKw("reset")) {
    action = { kind: "reset", setting: p.ident(true) };
  } else {
    action = { kind: "options", options: roleOptions(p, false) };
  }
  return { type: "alter_role", name, action, ...scope } satisfies AlterRoleStmt;
}

export function parseDropRole(p: ParserApi): DropRoleStmt {
  p.next(); // ROLE / USER / GROUP
  const ifExists = p.parseIfExists();
  const names: string[] = [];
  do {
    names.push(roleSpec(p));
  } while (p.eatPunct(","));
  return { type: "drop_role", names, ifExists };
}

const PRIVILEGES = new Set([
  "select",
  "insert",
  "update",
  "delete",
  "truncate",
  "references",
  "trigger",
  "maintain",
  "create",
  "connect",
  "temporary",
  "temp",
  "execute",
  "usage",
  "set",
  "all",
  "alter",
]);

/** Whether a GRANT / REVOKE (positioned after the keyword and any GRANT OPTION FOR) is on privileges. */
function grantsPrivileges(p: ParserApi): boolean {
  for (let i = 0; ; i++) {
    const t = p.peek(i);
    if (t.type === "eof" || (t.type === "punct" && t.value === ";")) return false;
    if (t.type === "ident" && t.value === "on") return true;
    if (t.type === "ident" && (t.value === "to" || t.value === "from")) return false;
  }
}

export function parseGrant(p: ParserApi): Statement {
  const revoke = p.next().value === "revoke";
  let admin = false;
  let inherit: boolean | null = null;
  let set: boolean | null = null;
  let grantOption = false;
  if (revoke) {
    if (p.atKw("grant") && p.atKw("option", 1)) {
      p.pos += 2;
      p.expectKw("for");
      grantOption = true;
    } else if ((p.atKw("admin") || p.atKw("inherit") || p.atKw("set")) && p.atKw("option", 1)) {
      const which = p.next().value;
      p.pos++;
      p.expectKw("for");
      if (which === "admin") admin = true;
      else if (which === "inherit") inherit = false;
      else set = false;
    }
  }
  if (grantsPrivileges(p)) {
    const privileges: GrantStmt["privileges"] = [];
    do {
      let name = p.ident(true);
      if (name === "all") p.eatKw("privileges");
      if (name === "alter" && p.eatKw("system")) name = "alter system";
      if (name === "temp") name = "temporary";
      if (!PRIVILEGES.has(name.split(" ")[0]!)) p.errorAt(p.peek(), "unrecognized privilege type");
      let columns: string[] | null = null;
      if (p.eatPunct("(")) {
        columns = [];
        do {
          columns.push(p.ident());
        } while (p.eatPunct(","));
        p.expectPunct(")");
      }
      privileges.push({ name, columns });
    } while (p.eatPunct(","));
    p.expectKw("on");
    let objectKind = "table";
    let allInSchema: string[] | null = null;
    const objects: string[][] = [];
    if (p.eatKw("all")) {
      objectKind = p.ident(true).replace(/s$/, "");
      p.expectKw("in");
      p.expectKw("schema");
      allInSchema = [];
      do {
        allInSchema.push(p.ident());
      } while (p.eatPunct(","));
    } else {
      const words = [
        "table",
        "sequence",
        "database",
        "schema",
        "function",
        "procedure",
        "routine",
        "type",
        "domain",
        "language",
        "tablespace",
        "parameter",
      ];
      for (const word of words) {
        if (p.eatKw(word)) {
          objectKind = word;
          break;
        }
      }
      if (p.atKw("foreign") || p.atKw("large")) {
        objectKind = `${p.next().value} ${p.next().value}`;
        if (objectKind === "foreign data") {
          p.expectKw("wrapper");
          objectKind = "foreign data wrapper";
        }
      }
      do {
        if (objectKind === "parameter") {
          objects.push([p.ident(true)]);
          while (p.eatPunct(".")) objects[objects.length - 1]!.push(p.ident(true));
        } else if (p.peek().type === "number") objects.push([p.next().value]);
        else objects.push(p.qualifiedName());
        if (objectKind === "function" || objectKind === "procedure" || objectKind === "routine") skipParens(p);
      } while (p.eatPunct(","));
    }
    p.expectKw(revoke ? "from" : "to");
    const grantees = roleList(p);
    if (!revoke && p.atKw("with") && p.atKw("grant", 1)) {
      p.pos += 2;
      p.expectKw("option");
      grantOption = true;
    }
    if (p.atKw("granted") && p.atKw("by", 1)) {
      p.pos += 2;
      roleSpec(p);
    }
    const cascade = p.eatKw("cascade");
    if (!cascade) p.eatKw("restrict");
    return {
      type: "grant",
      revoke,
      privileges,
      objectKind,
      objects,
      allInSchema,
      grantees,
      grantOption,
      cascade,
    } satisfies GrantStmt;
  }
  const roles = roleList(p);
  p.expectKw(revoke ? "from" : "to");
  const grantees = roleList(p);
  if (!revoke && p.eatKw("with")) {
    do {
      const which = p.ident(true);
      let value = true;
      if (!p.eatKw("option") && !p.eatKw("true")) {
        p.expectKw("false");
        value = false;
      }
      if (which === "admin") admin = value;
      else if (which === "inherit") inherit = value;
      else if (which === "set") set = value;
      else p.errorAt(p.peek(), "unrecognized role option");
    } while (p.eatPunct(","));
  }
  let grantedBy: string | null = null;
  if (p.atKw("granted") && p.atKw("by", 1)) {
    p.pos += 2;
    grantedBy = roleSpec(p);
  }
  if (!p.eatKw("cascade")) p.eatKw("restrict");
  return { type: "grant_role", revoke, roles, grantees, admin, inherit, set, grantedBy } satisfies GrantRoleStmt;
}

/** `REASSIGN OWNED BY ... TO ...`, `DROP OWNED BY ...`, `ALTER DEFAULT PRIVILEGES ...` */
export function parseRoleUtility(p: ParserApi, what: RoleUtilityStmt["what"]): RoleUtilityStmt {
  const roles: string[] = [];
  if (what !== "ALTER DEFAULT PRIVILEGES") {
    p.expectKw("owned");
    p.expectKw("by");
    roles.push(...roleList(p));
    if (what === "REASSIGN OWNED") {
      p.expectKw("to");
      roles.push(roleSpec(p));
    } else if (!p.eatKw("cascade")) p.eatKw("restrict");
  }
  while (!p.atStatementEnd()) p.next();
  return { type: "role_utility", what, roles };
}

// --- row-level security ------------------------------------------------------------

function parenExpr(p: ParserApi): Expr {
  p.expectPunct("(");
  const expr = p.parseExpr();
  p.expectPunct(")");
  return expr;
}

export function parseCreatePolicy(p: ParserApi): CreatePolicyStmt {
  p.expectKw("policy");
  const name = p.ident();
  p.expectKw("on");
  const table = p.qualifiedName();
  let permissive = true;
  let command: PolicyCommand = "all";
  let roles: string[] = ["public"];
  let using: Expr | null = null;
  let check: Expr | null = null;
  if (p.eatKw("as")) {
    const mode = p.ident(true);
    if (mode === "restrictive") permissive = false;
    else if (mode !== "permissive") {
      throw pgError("syntax", `unrecognized row security option "${mode}"`, "42601");
    }
  }
  if (p.eatKw("for")) {
    const c = p.ident(true);
    if (!["all", "select", "insert", "update", "delete"].includes(c)) p.errorAt(p.peek(), "expected policy command");
    command = c as PolicyCommand;
  }
  if (p.eatKw("to")) roles = roleList(p);
  if (p.eatKw("using")) using = parenExpr(p);
  if (p.atKw("with") && p.atKw("check", 1)) {
    p.pos += 2;
    check = parenExpr(p);
  }
  return { type: "create_policy", name, table, permissive, command, roles, using, check };
}

export function parseAlterPolicy(p: ParserApi): AlterPolicyStmt {
  p.expectKw("policy");
  const name = p.ident();
  p.expectKw("on");
  const table = p.qualifiedName();
  if (p.eatKw("rename")) {
    p.expectKw("to");
    return { type: "alter_policy", name, table, renameTo: p.ident(), roles: null, using: null, check: null };
  }
  let roles: string[] | null = null;
  let using: Expr | null = null;
  let check: Expr | null = null;
  if (p.eatKw("to")) roles = roleList(p);
  if (p.eatKw("using")) using = parenExpr(p);
  if (p.atKw("with") && p.atKw("check", 1)) {
    p.pos += 2;
    check = parenExpr(p);
  }
  return { type: "alter_policy", name, table, renameTo: null, roles, using, check };
}

// --- composite types ---------------------------------------------------------------

function attributeDef(p: ParserApi): CompositeAttributeDef {
  const name = p.ident();
  const typeName = p.parseTypeName();
  let collate: string[] | null = null;
  if (p.eatKw("collate")) collate = p.qualifiedName();
  return { name, typeName, collate };
}

/** `CREATE TYPE name AS ( attr type [COLLATE c], ... )`, positioned at the "(" */
export function parseCompositeTypeBody(p: ParserApi, name: string[]): CreateCompositeTypeStmt {
  p.expectPunct("(");
  const attributes: CompositeAttributeDef[] = [];
  if (!p.atPunct(")")) {
    do {
      attributes.push(attributeDef(p));
    } while (p.eatPunct(","));
  }
  p.expectPunct(")");
  return { type: "create_composite_type", name, attributes };
}

/** ALTER TYPE name { ADD | DROP | ALTER } ATTRIBUTE ... / RENAME ATTRIBUTE a TO b, positioned after the name */
export function parseAlterCompositeType(p: ParserApi, name: string[]): Statement {
  const cascadeTail = (): boolean => {
    const cascade = p.eatKw("cascade");
    if (!cascade) p.eatKw("restrict");
    return cascade;
  };
  if (p.eatKw("rename")) {
    p.expectKw("attribute");
    const from = p.ident();
    p.expectKw("to");
    const to = p.ident();
    cascadeTail();
    return { type: "alter_composite_type", name, actions: [{ kind: "rename_attribute", from, to }] };
  }
  const actions: AlterCompositeTypeAction[] = [];
  do {
    if (p.eatKw("add")) {
      p.expectKw("attribute");
      const attribute = attributeDef(p);
      actions.push({ kind: "add_attribute", attribute, cascade: cascadeTail() });
    } else if (p.eatKw("drop")) {
      p.expectKw("attribute");
      const ifExists = p.parseIfExists();
      const attr = p.ident();
      actions.push({ kind: "drop_attribute", name: attr, ifExists, cascade: cascadeTail() });
    } else {
      p.expectKw("alter");
      p.expectKw("attribute");
      const attr = p.ident();
      if (p.eatKw("set")) p.expectKw("data");
      p.expectKw("type");
      const typeName = p.parseTypeName();
      if (p.eatKw("collate")) p.qualifiedName();
      cascadeTail();
      actions.push({ kind: "alter_attribute_type", name: attr, typeName });
    }
  } while (p.eatPunct(","));
  return { type: "alter_composite_type", name, actions };
}

// --- partitioning ---------------------------------------------------------------------

/** `PARTITION BY { RANGE | LIST | HASH } ( key [COLLATE c] [opclass], ... )`, positioned after BY */
export function parsePartitionSpec(p: ParserApi): PartitionSpec {
  const strategy = p.ident(true);
  if (strategy !== "range" && strategy !== "list" && strategy !== "hash") {
    throw pgError("invalid_parameter_value", `unrecognized partitioning strategy "${strategy}"`, "22023");
  }
  p.expectPunct("(");
  const keys: PartitionKeyDef[] = [];
  do {
    let key: PartitionKeyDef;
    if (p.atPunct("(")) key = { column: null, expr: parenExpr(p) };
    else {
      const expr = p.parseExpr();
      key =
        expr.type === "colref" && expr.parts.length === 1
          ? { column: expr.parts[0]!, expr: null }
          : { column: null, expr };
    }
    if (p.eatKw("collate")) p.qualifiedName();
    if (!p.atPunct(",") && !p.atPunct(")")) p.qualifiedName(); // operator class
    keys.push(key);
  } while (p.eatPunct(","));
  p.expectPunct(")");
  if (strategy === "list" && keys.length > 1) {
    throw pgError(
      "invalid_table_definition",
      'cannot use "list" partition strategy with more than one column',
      "42P17",
    );
  }
  return { strategy, keys };
}

function rangeBound(p: ParserApi): RangeBoundDatum[] {
  p.expectPunct("(");
  const out: RangeBoundDatum[] = [];
  do {
    if (p.eatKw("minvalue")) out.push({ kind: "minvalue" });
    else if (p.eatKw("maxvalue")) out.push({ kind: "maxvalue" });
    else out.push({ kind: "value", expr: p.parseExpr() });
  } while (p.eatPunct(","));
  p.expectPunct(")");
  return out;
}

/** `FOR VALUES ... | DEFAULT` */
export function parsePartitionBound(p: ParserApi): PartitionBoundSpec {
  if (p.eatKw("default")) return { kind: "default" };
  p.expectKw("for");
  p.expectKw("values");
  if (p.eatKw("from")) {
    const from = rangeBound(p);
    p.expectKw("to");
    const to = rangeBound(p);
    return { kind: "range", from, to };
  }
  if (p.eatKw("in")) {
    p.expectPunct("(");
    const values: Expr[] = [];
    do {
      values.push(p.parseExpr());
    } while (p.eatPunct(","));
    p.expectPunct(")");
    return { kind: "list", values };
  }
  p.expectKw("with");
  p.expectPunct("(");
  let modulus: number | null = null;
  let remainder: number | null = null;
  do {
    const option = p.ident(true);
    const value = signedInt(p);
    if (option === "modulus") modulus = value;
    else if (option === "remainder") remainder = value;
    else throw pgError("syntax", `unrecognized hash partition bound specification "${option}"`, "42601");
  } while (p.eatPunct(","));
  p.expectPunct(")");
  if (modulus === null) throw pgError("syntax", "modulus for hash partition must be specified", "42601");
  if (remainder === null) throw pgError("syntax", "remainder for hash partition must be specified", "42601");
  return { kind: "hash", modulus, remainder };
}

// --- event triggers -----------------------------------------------------------------------

export function parseCreateEventTrigger(p: ParserApi): CreateEventTriggerStmt {
  p.expectKw("event");
  p.expectKw("trigger");
  const name = p.ident();
  p.expectKw("on");
  const event = p.ident(true);
  let tags: string[] | null = null;
  if (p.eatKw("when")) {
    do {
      const variable = p.ident(true);
      if (variable !== "tag") {
        throw pgError("syntax", `unrecognized filter variable "${variable}"`, "42601");
      }
      p.expectKw("in");
      p.expectPunct("(");
      tags ??= [];
      do {
        tags.push(stringLiteral(p, "command tag"));
      } while (p.eatPunct(","));
      p.expectPunct(")");
    } while (p.eatKw("and"));
  }
  p.expectKw("execute");
  if (!p.eatKw("function")) p.expectKw("procedure");
  const funcName = p.qualifiedName();
  p.expectPunct("(");
  p.expectPunct(")");
  return { type: "create_event_trigger", name, event, tags, funcName };
}

export function parseAlterEventTrigger(p: ParserApi): AlterEventTriggerStmt {
  p.expectKw("event");
  p.expectKw("trigger");
  const name = p.ident();
  if (p.eatKw("disable")) return { type: "alter_event_trigger", name, action: { kind: "disable" } };
  if (p.eatKw("enable")) {
    const mode = p.eatKw("replica") ? "R" : p.eatKw("always") ? "A" : "O";
    return { type: "alter_event_trigger", name, action: { kind: "enable", mode } };
  }
  if (p.eatKw("rename")) {
    p.expectKw("to");
    return { type: "alter_event_trigger", name, action: { kind: "rename", to: p.ident() } };
  }
  p.expectKw("owner");
  p.expectKw("to");
  return { type: "alter_event_trigger", name, action: { kind: "owner", to: roleSpec(p) } };
}

// --- JSON_TABLE ---------------------------------------------------------------------------------

/** `{ ERROR | NULL | EMPTY [ARRAY | OBJECT] | TRUE | FALSE | UNKNOWN | DEFAULT expr } ON { EMPTY | ERROR }` */
function jsonBehavior(p: ParserApi): { behavior: JsonTableBehavior; on: "empty" | "error" } | null {
  const save = p.pos;
  let behavior: JsonTableBehavior;
  if (p.eatKw("error")) behavior = { kind: "error" };
  else if (p.eatKw("null")) behavior = { kind: "null" };
  else if (p.eatKw("true")) behavior = { kind: "true" };
  else if (p.eatKw("false")) behavior = { kind: "false" };
  else if (p.eatKw("unknown")) behavior = { kind: "unknown" };
  else if (p.eatKw("empty")) {
    if (p.eatKw("object")) behavior = { kind: "empty_object" };
    else {
      p.eatKw("array");
      behavior = { kind: "empty_array" };
    }
  } else if (p.eatKw("default")) behavior = { kind: "default", expr: p.parseExpr() };
  else return null;
  if (!p.eatKw("on")) {
    p.pos = save;
    return null;
  }
  let on: "empty" | "error" = "empty";
  if (!p.eatKw("empty")) {
    p.expectKw("error");
    on = "error";
  }
  return { behavior, on };
}

function jsonTableColumns(p: ParserApi): JsonTableColumn[] {
  p.expectKw("columns");
  p.expectPunct("(");
  const columns: JsonTableColumn[] = [];
  do {
    if (p.eatKw("nested")) {
      p.eatKw("path");
      const path = stringLiteral(p, "JSON path");
      let pathName: string | null = null;
      if (p.eatKw("as")) pathName = p.ident();
      columns.push({ kind: "nested", path, pathName, columns: jsonTableColumns(p) });
      continue;
    }
    const name = p.ident();
    if (p.atKw("for") && p.atKw("ordinality", 1)) {
      p.pos += 2;
      columns.push({ kind: "ordinality", name });
      continue;
    }
    const typeName = p.parseTypeName();
    if (p.eatKw("exists")) {
      let path: string | null = null;
      if (p.eatKw("path")) path = stringLiteral(p, "JSON path");
      let onError: JsonTableBehavior | null = null;
      const behavior = jsonBehavior(p);
      if (behavior) {
        if (behavior.on !== "error") throw pgError("syntax", "invalid ON EMPTY behavior for EXISTS column", "42601");
        onError = behavior.behavior;
      }
      columns.push({ kind: "exists", name, typeName, path, onError });
      continue;
    }
    let formatJson = false;
    if (p.eatKw("format")) {
      p.expectKw("json");
      formatJson = true;
      if (p.eatKw("encoding")) p.ident(true);
    }
    let path: string | null = null;
    if (p.eatKw("path")) path = stringLiteral(p, "JSON path");
    let wrapper: "without" | "conditional" | "unconditional" | null = null;
    if (p.eatKw("without")) {
      p.eatKw("array");
      p.expectKw("wrapper");
      wrapper = "without";
    } else if (p.atKw("with") && !p.atKw("ordinality", 1)) {
      p.pos++;
      wrapper = "unconditional";
      if (p.eatKw("conditional")) wrapper = "conditional";
      else p.eatKw("unconditional");
      p.eatKw("array");
      p.expectKw("wrapper");
    }
    let quotes: "keep" | "omit" | null = null;
    if (p.atKw("keep") || p.atKw("omit")) {
      quotes = p.next().value as "keep" | "omit";
      p.expectKw("quotes");
      if (p.eatKw("on")) {
        p.expectKw("scalar");
        p.expectKw("string");
      }
    }
    let onEmpty: JsonTableBehavior | null = null;
    let onError: JsonTableBehavior | null = null;
    for (let i = 0; i < 2; i++) {
      const behavior = jsonBehavior(p);
      if (!behavior) break;
      if (behavior.on === "empty") onEmpty = behavior.behavior;
      else onError = behavior.behavior;
    }
    columns.push({ kind: "regular", name, typeName, formatJson, path, wrapper, quotes, onEmpty, onError });
  } while (p.eatPunct(","));
  p.expectPunct(")");
  return columns;
}

/** `JSON_TABLE ( ... )`, positioned at JSON_TABLE; alias handled by the caller */
export function parseJsonTable(p: ParserApi, lateral: boolean): Omit<FromJsonTable, "alias" | "colAliases"> {
  p.expectKw("json_table");
  p.expectPunct("(");
  const context = p.parseExpr();
  if (p.eatKw("format")) {
    p.expectKw("json");
    if (p.eatKw("encoding")) p.ident(true);
  }
  p.expectPunct(",");
  const path = stringLiteral(p, "JSON path");
  let pathName: string | null = null;
  if (p.eatKw("as")) pathName = p.ident();
  const passing: Array<{ name: string; expr: Expr }> = [];
  if (p.eatKw("passing")) {
    do {
      const expr = p.parseExpr();
      p.expectKw("as");
      passing.push({ name: p.ident(true), expr });
    } while (p.eatPunct(","));
  }
  const columns = jsonTableColumns(p);
  let onError: JsonTableBehavior | null = null;
  const behavior = jsonBehavior(p);
  if (behavior) {
    if (behavior.on !== "error") throw pgError("syntax", "invalid ON EMPTY behavior for JSON_TABLE()", "42601");
    onError = behavior.behavior;
  }
  p.expectPunct(")");
  return { type: "from_json_table", context, path, pathName, passing, columns, onError, lateral };
}
