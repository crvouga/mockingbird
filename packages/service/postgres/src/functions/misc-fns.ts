import { pgError } from "../errors/error.ts";
import type { EngineCtx } from "../expressions/context.ts";
import type { SequenceData } from "../storage/database-state.ts";
import { castTo } from "../types/cast.ts";
import { makeArray, tv, typeDisplayName } from "../types/value.ts";
import { argBigInt, argInt, argText, type ScalarFn, strict } from "./util.ts";

export const PG_VERSION_TEXT = "PostgreSQL 18.3 (postgres-mem) on TypeScript, in-memory engine";
export const PG_SERVER_VERSION = "18.3";
export const PG_SERVER_VERSION_NUM = "180003";

function findSequenceForCall(ctx: EngineCtx, name: string): SequenceData {
  const parts = parseQualifiedName(name);
  const seq = ctx.state.findSequence(parts);
  if (!seq) {
    throw pgError("undefined_table", `relation "${name}" does not exist`, "42P01");
  }
  return seq;
}

function parseQualifiedName(name: string): string[] {
  // supports schema.name and quoted parts
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < name.length; i++) {
    const c = name[i]!;
    if (inQuote) {
      if (c === '"') {
        if (name[i + 1] === '"') {
          current += '"';
          i++;
        } else inQuote = false;
      } else current += c;
    } else if (c === '"') {
      inQuote = true;
    } else if (c === ".") {
      parts.push(current);
      current = "";
    } else {
      current += c.toLowerCase();
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function sequenceSessionKey(seq: SequenceData): string {
  return `${seq.schema}\0${seq.name}`;
}

function markSessionCurrval(ctx: EngineCtx, seq: SequenceData, value: bigint): void {
  ctx.state.sequenceCurrval.set(sequenceSessionKey(seq), value);
}

function sessionCurrvalDefined(ctx: EngineCtx, seq: SequenceData): boolean {
  return ctx.state.sequenceCurrval.has(sequenceSessionKey(seq));
}

function readSessionCurrval(ctx: EngineCtx, seq: SequenceData): bigint {
  return ctx.state.sequenceCurrval.get(sequenceSessionKey(seq))!;
}

export function sequenceNextval(ctx: EngineCtx, seq: SequenceData): bigint {
  seq = ctx.state.ensureWritableSequence(seq);
  let next: bigint;
  if (!seq.isCalled) {
    next = seq.lastValue;
  } else {
    next = seq.lastValue + seq.increment;
    if (seq.increment > 0n && next > seq.maxValue) {
      if (!seq.cycle) {
        throw pgError(
          "sequence_generator_limit_exceeded",
          `nextval: reached maximum value of sequence "${seq.name}" (${seq.maxValue})`,
          "2200H",
        );
      }
      next = seq.minValue;
    } else if (seq.increment < 0n && next < seq.minValue) {
      if (!seq.cycle) {
        throw pgError(
          "sequence_generator_limit_exceeded",
          `nextval: reached minimum value of sequence "${seq.name}" (${seq.minValue})`,
          "2200H",
        );
      }
      next = seq.maxValue;
    }
  }
  seq.lastValue = next;
  seq.isCalled = true;
  markSessionCurrval(ctx, seq, next);
  ctx.state.lastSequence = { schema: seq.schema, name: seq.name };
  return next;
}

export function getMiscFunctions(): Map<string, ScalarFn> {
  const m = new Map<string, ScalarFn>();

  m.set("version", () => tv("text", PG_VERSION_TEXT));
  m.set("current_database", () => tv("name", "postgres"));
  m.set("current_catalog", () => tv("name", "postgres"));
  m.set("current_schema", (ctx) => {
    const path = ctx.state.effectiveSearchPath();
    const first = path.find((s) => ctx.state.schemas.has(s));
    return tv("name", first ?? null);
  });
  m.set("current_schemas", (ctx, args) => {
    const includeImplicit = args.length > 0 ? args[0]!.v === true : false;
    const path = ctx.state.effectiveSearchPath().filter((s) => ctx.state.schemas.has(s));
    const schemas = includeImplicit ? ["pg_catalog", ...path] : path;
    return tv("name[]", makeArray("name", schemas));
  });
  m.set("current_user", () => tv("name", "postgres"));
  m.set("session_user", () => tv("name", "postgres"));
  m.set("current_role", () => tv("name", "postgres"));
  m.set("user", () => tv("name", "postgres"));
  m.set("pg_backend_pid", () => tv("int4", 1));
  m.set("txid_current", () => tv("int8", 1n));
  m.set("pg_current_xact_id", () => tv("int8", 1n));
  m.set("pg_sleep", () => tv("void", null));
  m.set("pg_typeof", (_ctx, args) => tv("regtype", typeDisplayName(args[0]!.t === "unknown" ? "unknown" : args[0]!.t)));
  m.set(
    "pg_column_size",
    strict("int4", (ctx, args) => {
      const text = castTo(ctx, args[0]!, "text", { explicit: true }).v as string;
      return tv("int4", new TextEncoder().encode(text).length + 4);
    }),
  );
  m.set("gen_random_uuid", (ctx) => tv("uuid", ctx.state.prng.nextUuid4()));
  m.set("uuidv4", (ctx) => tv("uuid", ctx.state.prng.nextUuid4()));
  m.set(
    "uuid_extract_version",
    strict("int2", (ctx, args) => {
      const u = castTo(ctx, args[0]!, "uuid", { explicit: true }).v as string;
      return tv("int2", Number.parseInt(u[14]!, 16));
    }),
  );

  m.set("current_setting", (ctx, args) => {
    if (args[0]!.v === null) return tv("text", null);
    const name = argText(ctx, args[0]!).toLowerCase();
    const missingOk = args.length > 1 && args[1]!.v === true;
    const value = ctx.state.getSetting(name);
    if (value === undefined) {
      if (missingOk) return tv("text", null);
      throw pgError("undefined_object", `unrecognized configuration parameter "${name}"`, "42704");
    }
    return tv("text", value);
  });
  m.set("set_config", (ctx, args) => {
    if (args[0]!.v === null) {
      throw pgError("null_value_not_allowed", "NULL value not allowed for parameter name", "22004");
    }
    const name = argText(ctx, args[0]!).toLowerCase();
    const value = args[1]!.v === null ? "" : argText(ctx, args[1]!);
    ctx.state.settings.set(name, value);
    return tv("text", value);
  });

  // --- sequences -------------------------------------------------------------
  m.set(
    "nextval",
    strict("int8", (ctx, args) => {
      const seq = findSequenceForCall(ctx, argText(ctx, args[0]!));
      return tv("int8", sequenceNextval(ctx, seq));
    }),
  );
  m.set(
    "currval",
    strict("int8", (ctx, args) => {
      const seq = findSequenceForCall(ctx, argText(ctx, args[0]!));
      if (!sessionCurrvalDefined(ctx, seq)) {
        throw pgError(
          "object_not_in_prerequisite_state",
          `currval of sequence "${seq.name}" is not yet defined in this session`,
          "55000",
        );
      }
      return tv("int8", readSessionCurrval(ctx, seq));
    }),
  );
  m.set("lastval", (ctx) => {
    const last = ctx.state.lastSequence;
    if (!last) {
      throw pgError("object_not_in_prerequisite_state", "lastval is not yet defined in this session", "55000");
    }
    const seq = ctx.state.findSequence([last.schema, last.name]);
    if (!seq || !sessionCurrvalDefined(ctx, seq)) {
      throw pgError("object_not_in_prerequisite_state", "lastval is not yet defined in this session", "55000");
    }
    return tv("int8", readSessionCurrval(ctx, seq));
  });
  m.set(
    "setval",
    strict("int8", (ctx, args) => {
      const seq = ctx.state.ensureWritableSequence(findSequenceForCall(ctx, argText(ctx, args[0]!)));
      const value = argBigInt(ctx, args[1]!);
      const isCalled = args.length > 2 ? args[2]!.v === true : true;
      if (value < seq.minValue || value > seq.maxValue) {
        throw pgError(
          "numeric_value_out_of_range",
          `setval: value ${value} is out of bounds for sequence "${seq.name}" (${seq.minValue}..${seq.maxValue})`,
          "22003",
        );
      }
      seq.lastValue = value;
      seq.isCalled = isCalled;
      if (isCalled) markSessionCurrval(ctx, seq, value);
      ctx.state.lastSequence = { schema: seq.schema, name: seq.name };
      return tv("int8", value);
    }),
  );
  m.set(
    "pg_get_serial_sequence",
    strict("text", (ctx, args) => {
      const tableName = argText(ctx, args[0]!);
      const column = argText(ctx, args[1]!).toLowerCase();
      const table = ctx.state.findTable(parseQualifiedName(tableName));
      if (!table) throw pgError("undefined_table", `relation "${tableName}" does not exist`, "42P01");
      const col = table.columns.find((c) => c.name === column);
      if (!col)
        throw pgError("undefined_column", `column "${column}" of relation "${table.name}" does not exist`, "42703");
      if (!col.identity) return tv("text", null);
      return tv(
        "text",
        col.identity.sequence
          .split(".")
          .map((p) => p)
          .join("."),
      );
    }),
  );

  m.set("format_type", (ctx, args) => {
    if (args[0]!.v === null) return tv("text", null);
    const oid = argInt(ctx, args[0]!);
    const name = ctx.state.typeNameForOid(oid);
    return tv("text", name ?? "???");
  });
  m.set("pg_get_expr", () => tv("text", null));
  m.set("obj_description", () => tv("text", null));
  m.set("col_description", () => tv("text", null));
  m.set("shobj_description", () => tv("text", null));
  m.set("pg_get_userbyid", () => tv("name", "postgres"));
  m.set("pg_table_is_visible", (_ctx, args) => tv("bool", args[0]!.v !== null));
  m.set("pg_function_is_visible", (_ctx, args) => tv("bool", args[0]!.v !== null));
  m.set("pg_type_is_visible", (_ctx, args) => tv("bool", args[0]!.v !== null));
  m.set("has_table_privilege", () => tv("bool", true));
  m.set("has_schema_privilege", () => tv("bool", true));
  m.set("has_column_privilege", () => tv("bool", true));
  m.set("pg_encoding_to_char", (_ctx, args) => tv("name", args[0]!.v === null ? null : "UTF8"));
  m.set("pg_postmaster_start_time", (ctx) => tv("timestamptz", ctx.txNow));
  m.set("pg_conf_load_time", (ctx) => tv("timestamptz", ctx.txNow));
  m.set("inet_client_addr", () => tv("text", null));
  m.set("inet_server_addr", () => tv("text", null));
  m.set(
    "pg_size_pretty",
    strict("text", (ctx, args) => {
      let size = Number(argBigInt(ctx, args[0]!));
      const units = ["bytes", "kB", "MB", "GB", "TB", "PB"];
      let u = 0;
      while (Math.abs(size) >= 10240 && u < units.length - 1) {
        size /= 1024;
        u++;
      }
      return tv("text", `${Math.round(size)} ${units[u]}`);
    }),
  );
  m.set("pg_total_relation_size", () => tv("int8", 8192n));
  m.set("pg_relation_size", () => tv("int8", 8192n));
  m.set("pg_table_size", () => tv("int8", 8192n));
  m.set("pg_indexes_size", () => tv("int8", 0n));
  m.set("pg_database_size", () => tv("int8", 8192n));

  m.set("pg_advisory_lock", () => tv("void", null));
  m.set("pg_advisory_unlock", () => tv("bool", true));
  m.set("pg_advisory_unlock_all", () => tv("void", null));
  m.set("pg_try_advisory_lock", () => tv("bool", true));

  m.set("pg_notification_queue_usage", () => tv("float8", 0));
  m.set("pg_listening_channels_check", () => tv("bool", true));
  m.set("pg_is_in_recovery", () => tv("bool", false));
  m.set("txid_current_if_assigned", () => tv("int8", null));

  return m;
}
