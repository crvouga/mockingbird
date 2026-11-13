import { isPostgresError } from "../errors/error.ts";
import { castTo } from "../types/cast.ts";
import { tv } from "../types/value.ts";
import { argText, type ScalarFn, strict } from "./util.ts";

/**
 * What a session knows about itself: its connection's socket (`inet_server_addr()` and friends),
 * the statement text it is running (`current_query()`), its transaction id, and `to_regrole`.
 */
export function getSessionFunctions(): Map<string, ScalarFn> {
  const m = new Map<string, ScalarFn>();

  // The engine on its own has no socket, like a backend reached over a Unix socket: all four are
  // NULL. The wire server answers them from each connection's TCP socket (src/wire/cluster.ts).
  m.set("inet_server_addr", () => tv("inet", null));
  m.set("inet_server_port", () => tv("int4", null));
  m.set("inet_client_addr", () => tv("inet", null));
  m.set("inet_client_port", () => tv("int4", null));

  // the text the client sent, all of it for a multi-statement string (NULL when there is none)
  m.set("current_query", (ctx) => tv("text", ctx.state.currentQuery));

  // pg_current_xact_id assigns the transaction an id if it has none; the _if_assigned form only
  // reports one a write (or that call) already assigned, NULL otherwise
  m.set("pg_current_xact_id", (ctx) => tv("xid8", BigInt(ctx.rowVersionXid())));
  m.set("txid_current", (ctx) => tv("int8", BigInt(ctx.rowVersionXid())));
  m.set("pg_current_xact_id_if_assigned", (ctx) => {
    const xid = ctx.assignedXid();
    return tv("xid8", xid === null ? null : BigInt(xid));
  });
  m.set("txid_current_if_assigned", (ctx) => {
    const xid = ctx.assignedXid();
    return tv("int8", xid === null ? null : BigInt(xid));
  });

  // regrolein with soft errors: an unknown role or a malformed name is NULL
  m.set(
    "to_regrole",
    strict("regrole", (ctx, args) => {
      try {
        return castTo(ctx, tv("unknown", argText(ctx, args[0]!)), "regrole", { explicit: true });
      } catch (error) {
        if (isPostgresError(error) && (error.sqlState === "42704" || error.sqlState === "42602")) {
          return tv("regrole", null);
        }
        throw error;
      }
    }),
  );
  return m;
}
