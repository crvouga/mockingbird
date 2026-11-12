import type { Expr } from "../ast/nodes.ts";
import type { EngineCtx } from "../expressions/context.ts";
import { quoteIdentifier } from "../sql/keywords.ts";
import { deparseRuleExpr } from "../sql/ruleutils.ts";
import type { ConstraintMeta, DatabaseState, FunctionData, TableData, TriggerMeta } from "../storage/database-state.ts";
import type { TypeId } from "../types/value.ts";
import type { ConstraintEntry } from "./catalog-entries.ts";
import { regtypeName, returnTypeOid, typeIdOid } from "./reg-types.ts";

/**
 * The definitions ruleutils.c prints: `pg_get_constraintdef`, `pg_get_triggerdef`,
 * `pg_get_functiondef` and its parts, and the clauses information_schema shows from them.
 */

type ForeignKey = Extract<ConstraintMeta, { kind: "foreign_key" }>;

const ACTION_TEXT: Record<string, string> = {
  cascade: "CASCADE",
  set_null: "SET NULL",
  set_default: "SET DEFAULT",
  restrict: "RESTRICT",
  no_action: "NO ACTION",
};

/** confupdtype / confdeltype: a = no action, r = restrict, c = cascade, n = set null, d = set default. */
export function actionCode(action: string | null): string {
  switch (action) {
    case "cascade":
      return "c";
    case "set_null":
      return "n";
    case "set_default":
      return "d";
    case "restrict":
      return "r";
    default:
      return "a";
  }
}

/** information_schema's spelling of a referential action. */
export function actionRule(action: string | null): string {
  return ACTION_TEXT[action ?? "no_action"] ?? "NO ACTION";
}

const columnList = (columns: readonly string[]): string => columns.map(quoteIdentifier).join(", ");

/** A relation as generate_relation_name prints it: bare when the search path finds it. */
export function relationName(state: DatabaseState, schema: string, name: string): string {
  const visible = state.resolveRelationSchema([name])?.schema === schema;
  return visible ? quoteIdentifier(name) : `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

/** The body of a CHECK constraint as pg_get_expr prints it (parenthesized unless pretty). */
export function checkClause(ctx: EngineCtx, table: TableData, expr: Expr, pretty: boolean): string {
  return deparseRuleExpr({ ctx, table }, expr, pretty);
}

/** pg_get_constraintdef(oid, pretty). */
export function constraintDefinition(ctx: EngineCtx, entry: ConstraintEntry, pretty: boolean): string {
  if (entry.contype === "n") return `NOT NULL ${quoteIdentifier(entry.column)}`;
  const c = entry.constraint;
  switch (c.kind) {
    case "primary_key":
      return `PRIMARY KEY (${columnList(c.columns)})`;
    case "unique":
      return `UNIQUE ${c.nullsNotDistinct ? "NULLS NOT DISTINCT " : ""}(${columnList(c.columns)})`;
    case "check":
      return `CHECK (${checkClause(ctx, entry.table, c.expr, pretty)})`;
    case "foreign_key":
      return foreignKeyDefinition(ctx.state, c);
  }
}

function foreignKeyDefinition(state: DatabaseState, c: ForeignKey): string {
  let out = `FOREIGN KEY (${columnList(c.columns)}) REFERENCES ${relationName(state, c.refSchema, c.refTable)}(${columnList(c.refColumns)})`;
  if (c.match === "full") out += " MATCH FULL";
  if (c.onUpdate && c.onUpdate !== "no_action") out += ` ON UPDATE ${actionRule(c.onUpdate)}`;
  if (c.onDelete && c.onDelete !== "no_action") out += ` ON DELETE ${actionRule(c.onDelete)}`;
  if (c.onDeleteColumns) out += ` (${columnList(c.onDeleteColumns)})`;
  if (c.deferrable) out += c.initiallyDeferred ? " DEFERRABLE INITIALLY DEFERRED" : " DEFERRABLE";
  return out;
}

const EVENT_ORDER = ["insert", "delete", "update", "truncate"] as const;

/** The events of a trigger in the order pg_get_triggerdef lists them. */
export function triggerEvents(trigger: TriggerMeta): Array<{ event: string; columns: string[] | null }> {
  return EVENT_ORDER.flatMap((event) =>
    trigger.events.filter((e) => e.event === event).map((e) => ({ event: e.event.toUpperCase(), columns: e.columns })),
  );
}

/** `EXECUTE FUNCTION fn(args)`, as pg_get_triggerdef and information_schema.triggers print it. */
export function triggerAction(state: DatabaseState, trigger: TriggerMeta): string {
  const visible = state.findFunctions([trigger.funcName])[0]?.schema === trigger.funcSchema;
  const name = visible
    ? quoteIdentifier(trigger.funcName)
    : `${quoteIdentifier(trigger.funcSchema)}.${quoteIdentifier(trigger.funcName)}`;
  const args = trigger.funcArgs.map((a) => `'${a.replaceAll("'", "''")}'`).join(", ");
  return `EXECUTE FUNCTION ${name}(${args})`;
}

/** A trigger's WHEN condition (parenthesized unless pretty), or null. */
export function triggerCondition(
  ctx: EngineCtx,
  table: TableData,
  trigger: TriggerMeta,
  pretty: boolean,
): string | null {
  if (!trigger.when) return null;
  return deparseRuleExpr({ ctx, table }, trigger.when, pretty);
}

/** pg_get_triggerdef(oid, pretty). */
export function triggerDefinition(ctx: EngineCtx, table: TableData, trigger: TriggerMeta, pretty: boolean): string {
  const timing = trigger.timing === "instead_of" ? "INSTEAD OF" : trigger.timing.toUpperCase();
  const events = triggerEvents(trigger)
    .map((e) => (e.columns && e.columns.length > 0 ? `${e.event} OF ${columnList(e.columns)}` : e.event))
    .join(" OR ");
  const on = pretty
    ? relationName(ctx.state, table.schema, table.name)
    : `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
  let out = `CREATE ${trigger.constraint ? "CONSTRAINT " : ""}TRIGGER ${quoteIdentifier(trigger.name)} ${timing} ${events} ON ${on}`;
  if (trigger.constraint) {
    out += trigger.deferrable
      ? trigger.initiallyDeferred
        ? " DEFERRABLE INITIALLY DEFERRED"
        : " DEFERRABLE INITIALLY IMMEDIATE"
      : " NOT DEFERRABLE INITIALLY IMMEDIATE";
  }
  if (trigger.oldTable !== undefined || trigger.newTable !== undefined) {
    out += " REFERENCING";
    if (trigger.oldTable !== undefined) out += ` OLD TABLE AS ${quoteIdentifier(trigger.oldTable)}`;
    if (trigger.newTable !== undefined) out += ` NEW TABLE AS ${quoteIdentifier(trigger.newTable)}`;
  }
  out += ` FOR EACH ${trigger.forEachRow ? "ROW" : "STATEMENT"}`;
  const condition = triggerCondition(ctx, table, trigger, pretty);
  if (condition !== null) out += ` WHEN (${condition})`;
  return `${out} ${triggerAction(ctx.state, trigger)}`;
}

/** tgtype: bit 0 row, 1 before, 2 insert, 3 delete, 4 update, 5 truncate, 6 instead. */
export function triggerType(trigger: TriggerMeta): number {
  let type = trigger.forEachRow ? 1 : 0;
  if (trigger.timing === "before") type |= 2;
  if (trigger.timing === "instead_of") type |= 64;
  for (const { event } of trigger.events) {
    type |= event === "insert" ? 4 : event === "delete" ? 8 : event === "update" ? 16 : 32;
  }
  return type;
}

// --- functions -----------------------------------------------------------------------------

function typeText(state: DatabaseState, t: TypeId): string {
  return regtypeName(state, typeIdOid(state, t)) ?? t;
}

/** pg_get_function_arguments: every argument, with names, modes and defaults. */
export function functionArguments(ctx: EngineCtx, f: FunctionData, withDefaults = true): string {
  const parts = f.argTypes.map((t, i) => {
    const name = f.argNames[i];
    // a procedure lists every parameter in place, with its mode
    // (IN too, once any parameter has another mode, as PostgreSQL marks proargmodes)
    const mode = f.argModes?.[i];
    const marked = f.argModes?.some((m) => m !== "in") === true;
    const prefix = mode === undefined || !marked ? "" : `${mode.toUpperCase()} `;
    let text = `${prefix}${name ? `${quoteIdentifier(name)} ` : ""}${typeText(ctx.state, t)}`;
    const dflt = f.argDefaults[i];
    if (withDefaults && dflt) text += ` DEFAULT ${deparseRuleExpr({ ctx, table: null }, dflt, true)}`;
    return text;
  });
  if (f.argModes) return parts.join(", ");
  for (const out of f.outArgs ?? []) parts.push(`OUT ${quoteIdentifier(out.name)} ${typeText(ctx.state, out.type)}`);
  return parts.join(", ");
}

/** pg_get_function_result: what RETURNS says. */
export function functionResult(state: DatabaseState, f: FunctionData): string {
  if (f.outArgs?.length) return f.returnsSet ? "SETOF record" : "record";
  if (f.returnsTable) {
    return `TABLE(${f.returnsTable.map((c) => `${quoteIdentifier(c.name)} ${typeText(state, c.type)}`).join(", ")})`;
  }
  const base = regtypeName(state, returnTypeOid(state, f)) ?? "record";
  return f.returnsSet ? `SETOF ${base}` : base;
}

/** pg_get_functiondef: the CREATE OR REPLACE FUNCTION command that recreates the function. */
export function functionDefinition(ctx: EngineCtx, f: FunctionData): string {
  const name = `${quoteIdentifier(f.schema)}.${quoteIdentifier(f.name)}`;
  const kind = f.kind === "p" ? "procedure" : "function";
  let out = `CREATE OR REPLACE ${kind.toUpperCase()} ${name}(${functionArguments(ctx, f)})\n`;
  if (f.kind !== "p") out += ` RETURNS ${functionResult(ctx.state, f)}\n`;
  out += ` LANGUAGE ${f.language}\n`;
  const attributes = [f.volatility?.toUpperCase(), f.strict ? "STRICT" : undefined].filter((a) => a !== undefined);
  if (attributes.length > 0) out += ` ${attributes.join(" ")}\n`;
  for (const [setting, value] of Object.entries(f.settings ?? {})) out += ` SET ${setting} TO '${value}'\n`;
  out += `AS $${kind}$${f.rawBody ?? ""}$${kind}$\n`;
  return out;
}
