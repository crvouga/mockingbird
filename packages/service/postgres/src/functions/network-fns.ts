import { castTo } from "../types/cast.ts";
import { networkBroadcast, networkNetmask, networkParts, networkToCidr } from "../types/network.ts";
import { tv } from "../types/value.ts";
import type { ScalarFn } from "./util.ts";
import { strict } from "./util.ts";

/** The functions that read an `inet` / `cidr` value (https://www.postgresql.org/docs/18/functions-net.html). */
export function getNetworkFunctions(): Map<string, ScalarFn> {
  const m = new Map<string, ScalarFn>();
  const inet = (ctx: Parameters<ScalarFn>[0], arg: Parameters<ScalarFn>[1][number]): string =>
    castTo(ctx, arg, "inet", { explicit: true }).v as string;
  const address = (text: string): string => (text.includes("/") ? text.slice(0, text.indexOf("/")) : text);
  m.set(
    "family",
    strict("int4", (ctx, args) => tv("int4", networkParts(inet(ctx, args[0]!)).bytes.length === 4 ? 4 : 6)),
  );
  m.set(
    "masklen",
    strict("int4", (ctx, args) => tv("int4", networkParts(inet(ctx, args[0]!)).bits)),
  );
  m.set(
    "host",
    strict("text", (ctx, args) => tv("text", address(inet(ctx, args[0]!)))),
  );
  m.set(
    "network",
    strict("cidr", (ctx, args) => tv("cidr", networkToCidr(inet(ctx, args[0]!)))),
  );
  m.set(
    "broadcast",
    strict("inet", (ctx, args) => tv("inet", networkBroadcast(inet(ctx, args[0]!)))),
  );
  m.set(
    "netmask",
    strict("inet", (ctx, args) => tv("inet", networkNetmask(inet(ctx, args[0]!)))),
  );
  return m;
}
