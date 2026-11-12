import { pgError } from "../errors/error.ts";
import type { EngineCtx } from "../expressions/context.ts";
import { databaseCatalogContext } from "../runtime/database-context.ts";
import { CLASS_OIDS, constraintEntries, descriptions, triggerEntries } from "../schema/catalog-entries.ts";
import {
  constraintDefinition,
  functionArguments,
  functionDefinition,
  functionResult,
  triggerDefinition,
} from "../schema/catalog-defs.ts";
import { currentBackendPid } from "../schema/catalog-system.ts";
import { findFunctionByOid, formatType } from "../schema/reg-types.ts";
import { viewDefinition } from "../sql/viewdef.ts";
import { castTo } from "../types/cast.ts";
import { makeArray, type TypedValue, tv } from "../types/value.ts";
import { argInt, argText, type ScalarFn } from "./util.ts";

/**
 * Catalog information functions: object definitions (`pg_get_constraintdef`, `pg_get_triggerdef`,
 * `pg_get_functiondef`, `pg_get_viewdef`), comments (`obj_description`, `col_description`),
 * `format_type`, and the server-activity functions (`pg_blocking_pids`, `pg_cancel_backend`,
 * `pg_terminate_backend`, `pg_current_wal_lsn`).
 */

/** The oid an argument names: an oid or integer, a regclass, or a regproc / regtype name. */
function argOid(ctx: EngineCtx, arg: TypedValue): number {
  return castTo(ctx, arg, "oid", { explicit: true }).v as number;
}

const isNull = (arg: TypedValue | undefined): boolean => arg === undefined || arg.v === null;

const CATALOG_OIDS: Record<string, number> = CLASS_OIDS;

function description(ctx: EngineCtx, objoid: number, classoid: number | null, objsubid: number): string | null {
  for (const row of descriptions(ctx.state)) {
    if (row.objoid === objoid && row.objsubid === objsubid && (classoid === null || row.classoid === classoid)) {
      return row.description;
    }
  }
  return null;
}

/** Oid of the current WAL position: it moves on with every transaction that writes. */
function walLsn(ctx: EngineCtx): string {
  const position = 0x1000000 + ctx.state.xidCounter * 0x100;
  return `0/${position.toString(16).toUpperCase()}`;
}

export function getCatalogFunctions(): Map<string, ScalarFn> {
  const m = new Map<string, ScalarFn>();

  m.set("format_type", (ctx, args) => {
    if (isNull(args[0])) return tv("text", null);
    const typmod = isNull(args[1]) ? null : argInt(ctx, args[1]!);
    return tv("text", formatType(ctx.state, argOid(ctx, args[0]!), typmod));
  });

  // --- comments --------------------------------------------------------------------------
  m.set("obj_description", (ctx, args) => {
    if (isNull(args[0]) || (args.length > 1 && isNull(args[1]))) return tv("text", null);
    const classoid = args.length > 1 ? (CATALOG_OIDS[argText(ctx, args[1]!)] ?? -1) : null;
    return tv("text", description(ctx, argOid(ctx, args[0]!), classoid, 0));
  });
  m.set("col_description", (ctx, args) => {
    if (isNull(args[0]) || isNull(args[1])) return tv("text", null);
    return tv("text", description(ctx, argOid(ctx, args[0]!), CLASS_OIDS.pg_class, argInt(ctx, args[1]!)));
  });
  // shared objects (databases, roles, tablespaces) take no comments here
  m.set("shobj_description", () => tv("text", null));

  // --- definitions -----------------------------------------------------------------------
  m.set("pg_get_constraintdef", (ctx, args) => {
    if (isNull(args[0])) return tv("text", null);
    const oid = argOid(ctx, args[0]!);
    const pretty = args[1]?.v === true;
    const entry = constraintEntries(ctx.state).find((e) => e.oid === oid);
    return tv("text", entry ? constraintDefinition(ctx, entry, pretty) : null);
  });
  m.set("pg_get_triggerdef", (ctx, args) => {
    if (isNull(args[0])) return tv("text", null);
    const oid = argOid(ctx, args[0]!);
    const pretty = args[1]?.v === true;
    const entry = triggerEntries(ctx.state).find((e) => e.oid === oid);
    return tv("text", entry ? triggerDefinition(ctx, entry.table, entry.trigger, pretty) : null);
  });
  const userFunction = (ctx: EngineCtx, arg: TypedValue | undefined) => {
    if (isNull(arg)) return null;
    const oid = argOid(ctx, arg!);
    const f = findFunctionByOid(ctx.state, oid);
    if (!f && oid >= 1000 && oid < 16384) {
      // one of the engine's own functions: their signatures are not modelled
      throw pgError("feature_not_supported", "the definition of a built-in function is not available", "0A000");
    }
    return f;
  };
  m.set("pg_get_functiondef", (ctx, args) => {
    const f = userFunction(ctx, args[0]);
    return tv("text", f ? functionDefinition(ctx, f) : null);
  });
  m.set("pg_get_function_arguments", (ctx, args) => {
    const f = userFunction(ctx, args[0]);
    return tv("text", f ? functionArguments(ctx, f) : null);
  });
  m.set("pg_get_function_identity_arguments", (ctx, args) => {
    const f = userFunction(ctx, args[0]);
    return tv("text", f ? functionArguments(ctx, f, false) : null);
  });
  m.set("pg_get_function_result", (ctx, args) => {
    const f = userFunction(ctx, args[0]);
    return tv("text", f ? functionResult(ctx.state, f) : null);
  });
  m.set("pg_get_viewdef", (ctx, args) => {
    if (isNull(args[0])) return tv("text", null);
    const arg = args[0]!;
    let oid: number;
    if (arg.t === "text" || arg.t === "unknown" || arg.t === "varchar") {
      // the deprecated text form names the view
      oid = castTo(ctx, tv("unknown", argText(ctx, arg)), "regclass", { explicit: true }).v as number;
    } else oid = argOid(ctx, arg);
    const pretty = args[1]?.v === true || (typeof args[1]?.v === "number" && args[1].v > 0);
    for (const schema of ctx.state.schemas.values()) {
      for (const view of schema.views.values()) {
        if (view.oid === oid) return tv("text", viewDefinition(ctx, view, pretty));
      }
    }
    return tv("text", null);
  });

  // --- server activity -------------------------------------------------------------------
  m.set("pg_blocking_pids", (ctx, args) => {
    if (isNull(args[0])) return tv("int4[]", null);
    const pid = argInt(ctx, args[0]!);
    const pids = databaseCatalogContext(ctx.state).blockingPids?.(pid) ?? [];
    return tv("int4[]", makeArray("int4", [...pids]));
  });
  const signal = (kind: "cancel" | "terminate"): ScalarFn => {
    return (ctx, args) => {
      if (isNull(args[0])) return tv("bool", null);
      const pid = argInt(ctx, args[0]!);
      // a wire server signals its own sessions, this one included
      const signalBackend = databaseCatalogContext(ctx.state).signalBackend;
      if (signalBackend) return tv("bool", signalBackend(pid, kind));
      if (pid === currentBackendPid(ctx)) {
        // the signal reaches this very statement
        if (kind === "cancel") throw pgError("internal", "canceling statement due to user request", "57014");
        throw pgError("internal", "terminating connection due to administrator command", "57P01");
      }
      // PostgreSQL warns that the pid is not a PostgreSQL backend process
      return tv("bool", false);
    };
  };
  m.set("pg_cancel_backend", signal("cancel"));
  m.set("pg_terminate_backend", signal("terminate"));
  m.set("pg_current_wal_lsn", (ctx) => tv("text", walLsn(ctx)));
  m.set("pg_current_wal_insert_lsn", (ctx) => tv("text", walLsn(ctx)));
  m.set("pg_current_wal_flush_lsn", (ctx) => tv("text", walLsn(ctx)));
  return m;
}
