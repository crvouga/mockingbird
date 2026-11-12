import { pgError } from "../errors/error.ts";
import { type Datum, makeArray, type TypedValue, tv } from "../types/value.ts";
import type { Relation } from "./relation.ts";

/**
 * What the event trigger function running right now may ask about its command (issue #692):
 * `pg_event_trigger_ddl_commands()`, `pg_event_trigger_dropped_objects()` and the table_rewrite
 * inquiry functions. Kept apart from event-triggers.ts so the function registries can use it
 * without importing the executor.
 */

/** One row of pg_event_trigger_ddl_commands(). */
export interface DdlCommand {
  classid: number;
  objid: number;
  commandTag: string;
  objectType: string;
  schemaName: string | null;
  objectIdentity: string | null;
}

/** One row of pg_event_trigger_dropped_objects(). */
export interface DroppedObject {
  classid: number;
  objid: number;
  objsubid: number;
  original: boolean;
  normal: boolean;
  isTemporary: boolean;
  objectType: string;
  schemaName: string | null;
  objectName: string | null;
  objectIdentity: string;
}

export interface FiringContext {
  event: string;
  commands: DdlCommand[];
  dropped: DroppedObject[];
  rewrite: { oid: number; reason: number } | null;
}

/** The event trigger function running right now (what the inquiry functions report on). */
export const firing: FiringContext[] = [];

function current(fn: string, events: string[]): FiringContext {
  const context = firing[firing.length - 1];
  if (!context || !events.includes(context.event)) {
    throw pgError(
      "misuse",
      `${fn}() can only be called in ${events.includes("sql_drop") && events.length === 1 ? "a sql_drop event trigger function" : events.includes("table_rewrite") ? "a table_rewrite event trigger function" : "an event trigger function"}`,
      "39P03",
    );
  }
  return context;
}

/** `pg_event_trigger_ddl_commands()` */
export function ddlCommandsRelation(): Relation {
  const context = current("pg_event_trigger_ddl_commands", ["ddl_command_end"]);
  return {
    columns: [
      { name: "classid", type: "oid", table: null },
      { name: "objid", type: "oid", table: null },
      { name: "objsubid", type: "int4", table: null },
      { name: "command_tag", type: "text", table: null },
      { name: "object_type", type: "text", table: null },
      { name: "schema_name", type: "text", table: null },
      { name: "object_identity", type: "text", table: null },
      { name: "in_extension", type: "bool", table: null },
      { name: "command", type: "text", table: null },
    ],
    rows: context.commands.map((c): Datum[] => [
      c.classid,
      c.objid,
      0,
      c.commandTag,
      c.objectType,
      c.schemaName,
      c.objectIdentity,
      false,
      null,
    ]),
  };
}

/** `pg_event_trigger_dropped_objects()` */
export function droppedObjectsRelation(): Relation {
  const context = current("pg_event_trigger_dropped_objects", ["sql_drop"]);
  return {
    columns: [
      { name: "classid", type: "oid", table: null },
      { name: "objid", type: "oid", table: null },
      { name: "objsubid", type: "int4", table: null },
      { name: "original", type: "bool", table: null },
      { name: "normal", type: "bool", table: null },
      { name: "is_temporary", type: "bool", table: null },
      { name: "object_type", type: "text", table: null },
      { name: "schema_name", type: "text", table: null },
      { name: "object_name", type: "text", table: null },
      { name: "object_identity", type: "text", table: null },
      { name: "address_names", type: "text[]", table: null },
      { name: "address_args", type: "text[]", table: null },
    ],
    rows: context.dropped.map((d): Datum[] => [
      d.classid,
      d.objid,
      d.objsubid,
      d.original,
      d.normal,
      d.isTemporary,
      d.objectType,
      d.schemaName,
      d.objectName,
      d.objectIdentity,
      makeArray("text", d.schemaName && d.objectName ? [d.schemaName, d.objectName] : []),
      makeArray("text", []),
    ]),
  };
}

/** `pg_event_trigger_table_rewrite_oid()` / `_reason()` */
export function tableRewriteInfo(which: "oid" | "reason"): TypedValue {
  const context = current(`pg_event_trigger_table_rewrite_${which}`, ["table_rewrite"]);
  return which === "oid" ? tv("oid", context.rewrite?.oid ?? 0) : tv("int4", context.rewrite?.reason ?? 0);
}
