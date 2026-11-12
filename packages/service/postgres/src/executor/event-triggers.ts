import type { AlterEventTriggerStmt, CreateEventTriggerStmt, Statement } from "../ast/nodes.ts";
import { pgError } from "../errors/error.ts";
import type { EventTriggerData } from "../storage/catalog-ext.ts";
import type { DatabaseState, TableData } from "../storage/database-state.ts";
import { replicaRole } from "../storage/guc.ts";
import { currentRole } from "../storage/roles.ts";
import { typeDisplayName } from "../types/value.ts";
import { type DdlCommand, type DroppedObject, type FiringContext, firing } from "./event-trigger-context.ts";
import { callPlpgsqlEventTrigger } from "./plpgsql.ts";
import { commandResult, type ExecEnv, type ExecResult } from "./relation.ts";

/**
 * Event triggers (https://www.postgresql.org/docs/18/event-triggers.html): CREATE / ALTER / DROP
 * EVENT TRIGGER, and firing `ddl_command_start`, `ddl_command_end`, `sql_drop` and `table_rewrite`
 * around the DDL commands PostgreSQL's event trigger matrix lists, in trigger-name order, with
 * `TG_EVENT` / `TG_TAG`, `pg_event_trigger_ddl_commands()` and `pg_event_trigger_dropped_objects()`.
 * `login` triggers can be created; the engine has no logins to fire them on.
 */

const EVENTS = new Set(["ddl_command_start", "ddl_command_end", "sql_drop", "table_rewrite", "login"]);

/** The command tags event triggers fire for (PostgreSQL's event trigger firing matrix, the common ones). */
const DDL_TAGS = new Set([
  "ALTER AGGREGATE",
  "ALTER DEFAULT PRIVILEGES",
  "ALTER DOMAIN",
  "ALTER EXTENSION",
  "ALTER FUNCTION",
  "ALTER INDEX",
  "ALTER MATERIALIZED VIEW",
  "ALTER POLICY",
  "ALTER PROCEDURE",
  "ALTER ROUTINE",
  "ALTER SCHEMA",
  "ALTER SEQUENCE",
  "ALTER TABLE",
  "ALTER TRIGGER",
  "ALTER TYPE",
  "ALTER VIEW",
  "COMMENT",
  "CREATE AGGREGATE",
  "CREATE DOMAIN",
  "CREATE EXTENSION",
  "CREATE FUNCTION",
  "CREATE INDEX",
  "CREATE MATERIALIZED VIEW",
  "CREATE POLICY",
  "CREATE PROCEDURE",
  "CREATE SCHEMA",
  "CREATE SEQUENCE",
  "CREATE TABLE",
  "CREATE TABLE AS",
  "CREATE TRIGGER",
  "CREATE TYPE",
  "CREATE VIEW",
  "DROP AGGREGATE",
  "DROP DOMAIN",
  "DROP EXTENSION",
  "DROP FUNCTION",
  "DROP INDEX",
  "DROP MATERIALIZED VIEW",
  "DROP OWNED",
  "DROP POLICY",
  "DROP PROCEDURE",
  "DROP ROUTINE",
  "DROP SCHEMA",
  "DROP SEQUENCE",
  "DROP TABLE",
  "DROP TRIGGER",
  "DROP TYPE",
  "DROP VIEW",
  "GRANT",
  "REFRESH MATERIALIZED VIEW",
  "REVOKE",
  "SELECT INTO",
]);

function setEventTriggers(state: DatabaseState, change: (map: Map<string, EventTriggerData>) => void): void {
  const map = new Map(state.catalogExt.eventTriggers);
  change(map);
  state.catalogExt = { ...state.catalogExt, eventTriggers: map };
}

function requireSuperuser(state: DatabaseState, what: string): void {
  if (!currentRole(state).superuser) {
    throw pgError("misuse", `permission denied to ${what}`, "42501");
  }
}

export function executeCreateEventTrigger(env: ExecEnv, stmt: CreateEventTriggerStmt): ExecResult {
  const state = env.ctx.state;
  requireSuperuser(state, `create event trigger "${stmt.name}"`);
  if (!EVENTS.has(stmt.event)) throw pgError("syntax", `unrecognized event name "${stmt.event}"`, "42601");
  if (state.catalogExt.eventTriggers.has(stmt.name)) {
    throw pgError("duplicate_object", `event trigger "${stmt.name}" already exists`, "42710");
  }
  const tags = stmt.tags?.map((t) => t.toUpperCase()) ?? null;
  for (const tag of tags ?? []) {
    if (!DDL_TAGS.has(tag)) {
      throw pgError("syntax", `filter value "${tag}" not recognized for filter variable "tag"`, "42601");
    }
  }
  const fn = state.findFunctions(stmt.funcName).find((f) => f.argTypes.length === 0);
  if (!fn) throw pgError("undefined_function", `function ${stmt.funcName.join(".")}() does not exist`, "42883");
  if (fn.returns !== "event_trigger") {
    throw pgError("invalid_table_definition", `function ${fn.name} must return type event_trigger`, "42P17");
  }
  setEventTriggers(state, (map) =>
    map.set(stmt.name, {
      oid: state.nextOid(),
      name: stmt.name,
      event: stmt.event,
      tags,
      funcSchema: fn.schema,
      funcName: fn.name,
      funcOid: fn.oid,
      enabled: "O",
      owner: currentRole(state).oid,
    }),
  );
  return commandResult("CREATE EVENT TRIGGER", 0);
}

function requireEventTrigger(state: DatabaseState, name: string): EventTriggerData {
  const found = state.catalogExt.eventTriggers.get(name);
  if (!found) throw pgError("undefined_object", `event trigger "${name}" does not exist`, "42704");
  return found;
}

export function executeAlterEventTrigger(env: ExecEnv, stmt: AlterEventTriggerStmt): ExecResult {
  const state = env.ctx.state;
  const trigger = requireEventTrigger(state, stmt.name);
  requireSuperuser(state, `alter event trigger "${stmt.name}"`);
  const action = stmt.action;
  setEventTriggers(state, (map) => {
    switch (action.kind) {
      case "enable":
        map.set(trigger.name, { ...trigger, enabled: action.mode });
        break;
      case "disable":
        map.set(trigger.name, { ...trigger, enabled: "D" });
        break;
      case "rename":
        if (map.has(action.to)) {
          throw pgError("duplicate_object", `event trigger "${action.to}" already exists`, "42710");
        }
        map.delete(trigger.name);
        map.set(action.to, { ...trigger, name: action.to });
        break;
      case "owner": {
        const role = state.catalogExt.roles.get(action.to);
        if (!role) throw pgError("undefined_object", `role "${action.to}" does not exist`, "42704");
        if (!role.superuser) {
          throw pgError("misuse", `permission denied to change owner of event trigger "${trigger.name}"`, "42501");
        }
        map.set(trigger.name, { ...trigger, owner: role.oid });
        break;
      }
    }
  });
  return commandResult("ALTER EVENT TRIGGER", 0);
}

export function dropEventTrigger(env: ExecEnv, name: string, ifExists: boolean): void {
  const state = env.ctx.state;
  if (!state.catalogExt.eventTriggers.has(name)) {
    if (ifExists) return;
    requireEventTrigger(state, name);
  }
  requireSuperuser(state, `drop event trigger "${name}"`);
  setEventTriggers(state, (map) => map.delete(name));
}

/** Event triggers run by a function: the function cannot be dropped while one uses it. */
export function eventTriggersUsing(state: DatabaseState, oid: number): EventTriggerData[] {
  return [...state.catalogExt.eventTriggers.values()].filter((t) => t.funcOid === oid);
}

// --- firing -------------------------------------------------------------------------------------

/** The command tag of a DDL statement event triggers fire for; null for anything else. */
export function ddlCommandTag(stmt: Statement): string | null {
  switch (stmt.type) {
    case "create_table":
      return "CREATE TABLE";
    case "create_table_as":
      return stmt.materialized ? "CREATE MATERIALIZED VIEW" : "CREATE TABLE AS";
    case "create_index":
      return "CREATE INDEX";
    case "create_view":
      return stmt.materialized ? "CREATE MATERIALIZED VIEW" : "CREATE VIEW";
    case "create_sequence":
      return "CREATE SEQUENCE";
    case "alter_sequence":
      return "ALTER SEQUENCE";
    case "create_schema":
      return "CREATE SCHEMA";
    case "create_extension":
      return "CREATE EXTENSION";
    case "create_enum":
    case "create_composite_type":
      return "CREATE TYPE";
    case "alter_enum":
    case "alter_composite_type":
      return "ALTER TYPE";
    case "create_domain":
      return "CREATE DOMAIN";
    case "create_function":
      return (stmt as { procedure?: boolean }).procedure ? "CREATE PROCEDURE" : "CREATE FUNCTION";
    case "create_trigger":
      return "CREATE TRIGGER";
    case "alter_table":
      return "ALTER TABLE";
    case "alter_view":
      return "ALTER VIEW";
    case "alter_index":
      return "ALTER INDEX";
    case "alter_schema":
      return "ALTER SCHEMA";
    case "drop":
      if (stmt.kind === "event_trigger") return null;
      return `DROP ${stmt.kind === "materialized_view" ? "MATERIALIZED VIEW" : stmt.kind.toUpperCase()}`;
    case "comment":
      return "COMMENT";
    case "grant":
      return stmt.revoke ? "REVOKE" : "GRANT";
    case "create_policy":
      return "CREATE POLICY";
    case "alter_policy":
      return "ALTER POLICY";
    case "refresh_materialized_view":
      return "REFRESH MATERIALIZED VIEW";
    default:
      return null;
  }
}

function triggersFor(state: DatabaseState, event: string, tag: string): EventTriggerData[] {
  const replica = replicaRole(state);
  return [...state.catalogExt.eventTriggers.values()]
    .filter((t) => t.event === event && (t.tags === null || t.tags.includes(tag)))
    .filter((t) => (replica ? t.enabled === "R" || t.enabled === "A" : t.enabled === "O" || t.enabled === "A"))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function fire(env: ExecEnv, event: string, tag: string, context: Omit<FiringContext, "event">): void {
  const state = env.ctx.state;
  for (const trigger of triggersFor(state, event, tag)) {
    const fn = state.schemas
      .get(trigger.funcSchema)
      ?.functions.get(trigger.funcName)
      ?.find((f) => f.oid === trigger.funcOid);
    if (!fn) continue;
    firing.push({ event, ...context });
    try {
      callPlpgsqlEventTrigger(env, fn, event, tag);
    } finally {
      firing.pop();
    }
  }
}

const PG_CLASS = 1259;
const PG_PROC = 1255;

function relationIdentity(schema: string, name: string): string {
  const quote = (s: string) => (/^[a-z_][a-z0-9_$]*$/.test(s) ? s : `"${s.replaceAll('"', '""')}"`);
  return `${quote(schema)}.${quote(name)}`;
}

/** What a command created or altered, as pg_event_trigger_ddl_commands() lists it. */
function commandsOf(state: DatabaseState, stmt: Statement, tag: string): DdlCommand[] {
  const table = (parts: string[]): TableData | null => state.findTable(parts);
  const row = (classid: number, objid: number, objectType: string, schema: string, name: string, commandTag = tag) => ({
    classid,
    objid,
    commandTag,
    objectType,
    schemaName: schema,
    objectIdentity: relationIdentity(schema, name),
  });
  switch (stmt.type) {
    case "create_table":
    case "alter_table": {
      const t = table(stmt.type === "create_table" ? stmt.name : stmt.table);
      if (!t) return [];
      const out: DdlCommand[] = [row(PG_CLASS, t.oid, "table", t.schema, t.name)];
      if (stmt.type === "create_table") {
        for (const con of t.constraints) {
          if ((con.kind === "primary_key" || con.kind === "unique") && con.indexOid !== undefined) {
            out.push(row(PG_CLASS, con.indexOid, "index", t.schema, con.name, "CREATE INDEX"));
          }
        }
      }
      return out;
    }
    case "create_index": {
      const t = table(stmt.table);
      if (!t) return [];
      const index = [...(state.schemas.get(t.schema)?.indexes.values() ?? [])].find(
        (i) => i.tableOid === t.oid && (stmt.name === null || i.name === stmt.name),
      );
      return index ? [row(PG_CLASS, index.oid ?? 0, "index", t.schema, index.name)] : [];
    }
    case "create_view": {
      const v = state.findView(stmt.name);
      return v ? [row(PG_CLASS, v.oid, v.materialized ? "materialized view" : "view", v.schema, v.name)] : [];
    }
    case "create_sequence": {
      const s = state.findSequence(stmt.name);
      return s ? [row(PG_CLASS, s.oid, "sequence", s.schema, s.name)] : [];
    }
    case "create_function": {
      const name = stmt.name[stmt.name.length - 1]!;
      const fn = state
        .findFunctions(stmt.name)
        .find((f) => f.name === name && f.argTypes.length === stmt.args.filter((a) => a.mode !== "out").length);
      if (!fn) return [];
      const args = fn.argTypes.map((t) => typeDisplayName(t)).join(", ");
      const kind = fn.kind === "p" ? "procedure" : "function";
      return [
        {
          classid: PG_PROC,
          objid: fn.oid,
          commandTag: tag,
          objectType: kind,
          schemaName: fn.schema,
          objectIdentity: `${relationIdentity(fn.schema, fn.name)}(${args})`,
        },
      ];
    }
    default:
      return [];
  }
}

/** What a DROP removes, captured before it runs. */
function droppedBy(state: DatabaseState, stmt: Statement): DroppedObject[] {
  if (stmt.type !== "drop") return [];
  const out: DroppedObject[] = [];
  const object = (
    objectType: string,
    schema: string | null,
    name: string | null,
    identity: string,
    original: boolean,
    oid = 0,
  ): DroppedObject => ({
    classid: PG_CLASS,
    objid: oid,
    objsubid: 0,
    original,
    normal: false,
    isTemporary: false,
    objectType,
    schemaName: schema,
    objectName: name,
    objectIdentity: identity,
  });
  for (const parts of stmt.names) {
    if (stmt.kind === "table") {
      const t = state.findTable(parts);
      if (!t) continue;
      const id = relationIdentity(t.schema, t.name);
      out.push(object("table", t.schema, t.name, id, true, t.oid));
      out.push(object("type", t.schema, t.name, id, false));
      out.push(object("type", t.schema, `_${t.name}`, `${id}[]`, false));
      for (const col of t.columns) {
        if (col.notNull) {
          const name = `${t.name}_${col.name}_not_null`;
          out.push(object("table constraint", t.schema, null, `${name} on ${id}`, false));
        }
      }
      for (const con of t.constraints)
        out.push(object("table constraint", t.schema, null, `${con.name} on ${id}`, false));
      for (const con of t.constraints) {
        if (con.kind === "primary_key" || con.kind === "unique") {
          out.push(object("index", t.schema, con.name, relationIdentity(t.schema, con.name), false));
        }
      }
    } else if (stmt.kind === "view" || stmt.kind === "materialized_view") {
      const v = state.findView(parts);
      if (!v) continue;
      const id = relationIdentity(v.schema, v.name);
      out.push(object(v.materialized ? "materialized view" : "view", v.schema, v.name, id, true, v.oid));
      out.push(object("type", v.schema, v.name, id, false));
      out.push(object("type", v.schema, `_${v.name}`, `${id}[]`, false));
      out.push(object("rule", null, null, `"_RETURN" on ${id}`, false));
    } else if (stmt.kind === "sequence") {
      const s = state.findSequence(parts);
      if (s) out.push(object("sequence", s.schema, s.name, relationIdentity(s.schema, s.name), true, s.oid));
    } else if (stmt.kind === "index") {
      const name = parts[parts.length - 1]!;
      for (const schema of state.schemas.values()) {
        const i = schema.indexes.get(name);
        if (i) out.push(object("index", schema.name, name, relationIdentity(schema.name, name), true, i.oid ?? 0));
      }
    }
  }
  return out;
}

/** ALTER TABLE actions that rewrite the table, and the table_rewrite reason bits. */
function rewriteReason(stmt: Statement): number {
  if (stmt.type !== "alter_table") return 0;
  let reason = 0;
  for (const action of stmt.actions) {
    if (action.kind === "set_logged") reason |= 1;
    if (action.kind === "alter_type") reason |= 4;
  }
  return reason;
}

/**
 * Run `run` (the statement) inside its event triggers: ddl_command_start before it, table_rewrite
 * and sql_drop as it runs, ddl_command_end after. Without event triggers, or for a statement they
 * do not fire for, just `run`.
 */
export function withEventTriggers(env: ExecEnv, stmt: Statement, run: () => ExecResult): ExecResult {
  const state = env.ctx.state;
  if (state.catalogExt.eventTriggers.size === 0) return run();
  const tag = ddlCommandTag(stmt);
  if (tag === null) return run();
  fire(env, "ddl_command_start", tag, { commands: [], dropped: [], rewrite: null });
  const dropped = droppedBy(state, stmt);
  const reason = rewriteReason(stmt);
  if (reason !== 0 && stmt.type === "alter_table") {
    const t = state.findTable(stmt.table);
    if (t) fire(env, "table_rewrite", tag, { commands: [], dropped: [], rewrite: { oid: t.oid, reason } });
  }
  const result = run();
  if (dropped.length > 0) fire(env, "sql_drop", tag, { commands: [], dropped, rewrite: null });
  fire(env, "ddl_command_end", tag, { commands: commandsOf(state, stmt, tag), dropped: [], rewrite: null });
  return result;
}
