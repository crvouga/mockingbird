import type { EngineCtx } from "../expressions/context.ts";
import type { AdvisoryLockHold, AdvisoryLockKey, DatabaseState } from "../storage/database-state.ts";
import { type TypedValue, tv } from "../types/value.ts";
import type { ScalarFn } from "./util.ts";

/**
 * Advisory locks (https://www.postgresql.org/docs/18/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS)
 * for the engine on its own: one session, so every request is granted, but the locks are counted
 * per mode and level the way PostgreSQL's lock table counts them, so `pg_advisory_unlock` of a lock
 * not held is `false` and `pg_locks` lists what the session holds. The wire server replaces these
 * with its cluster's session-aware versions (src/wire/cluster.ts), which block and conflict.
 */

export type AdvisoryMode = "exclusive" | "share";

/** pg_locks.mode of an advisory lock. */
export const ADVISORY_MODE_NAME: Record<AdvisoryMode, string> = { exclusive: "ExclusiveLock", share: "ShareLock" };

/**
 * The lock tag of a key: a bigint key's high and low 32 bits are classid and objid (objsubid 1);
 * the (int4, int4) form puts its two keys there unchanged (objsubid 2). Null for a NULL key.
 */
export function advisoryKey(values: readonly unknown[]): AdvisoryLockKey | null {
  if (values.some((v) => v === null || v === undefined)) return null;
  if (values.length === 1) {
    const unsigned = BigInt.asUintN(64, BigInt(String(values[0])));
    return { classid: Number(unsigned >> 32n), objid: Number(unsigned & 0xffffffffn), objsubid: 1 };
  }
  return { classid: Number(values[0]) >>> 0, objid: Number(values[1]) >>> 0, objsubid: 2 };
}

export function advisoryKeyText(key: AdvisoryLockKey): string {
  return `${key.objsubid}:${key.classid}:${key.objid}`;
}

const keyOf = (args: readonly TypedValue[]): AdvisoryLockKey | null => advisoryKey(args.map((a) => a.v));

function hold(state: DatabaseState, key: AdvisoryLockKey): AdvisoryLockHold {
  const text = advisoryKeyText(key);
  let held = state.advisoryLocks.get(text);
  if (!held) {
    held = { key, exclusive: { session: 0, xact: 0 }, share: { session: 0, xact: 0 } };
    state.advisoryLocks.set(text, held);
  }
  return held;
}

function forgetIfFree(state: DatabaseState, held: AdvisoryLockHold): void {
  const counts = [held.exclusive, held.share];
  if (counts.every((c) => c.session === 0 && c.xact === 0)) state.advisoryLocks.delete(advisoryKeyText(held.key));
}

function take(ctx: EngineCtx, key: AdvisoryLockKey, mode: AdvisoryMode, xact: boolean): void {
  // a transaction-level lock outside a block lasts only for the statement's own transaction
  if (xact && !ctx.state.inTransaction) return;
  const counts = hold(ctx.state, key)[mode];
  if (xact) counts.xact++;
  else counts.session++;
}

const lock =
  (mode: AdvisoryMode, xact: boolean): ScalarFn =>
  (ctx, args) => {
    const key = keyOf(args);
    if (!key) return tv("void", null);
    take(ctx, key, mode, xact);
    return tv("void", "");
  };

const tryLock =
  (mode: AdvisoryMode, xact: boolean): ScalarFn =>
  (ctx, args) => {
    const key = keyOf(args);
    if (!key) return tv("bool", null);
    take(ctx, key, mode, xact);
    return tv("bool", true);
  };

/** Release one session-level hold; false (PostgreSQL also warns) when the session holds none in that mode. */
const unlock =
  (mode: AdvisoryMode): ScalarFn =>
  (ctx, args) => {
    const key = keyOf(args);
    if (!key) return tv("bool", null);
    const held = ctx.state.advisoryLocks.get(advisoryKeyText(key));
    if (!held || held[mode].session === 0) return tv("bool", false);
    held[mode].session--;
    forgetIfFree(ctx.state, held);
    return tv("bool", true);
  };

/** Drop the session-level holds (pg_advisory_unlock_all), or the transaction-level ones at COMMIT / ROLLBACK. */
export function releaseAdvisoryLocks(state: DatabaseState, level: "session" | "xact"): void {
  for (const held of [...state.advisoryLocks.values()]) {
    held.exclusive[level] = 0;
    held.share[level] = 0;
    forgetIfFree(state, held);
  }
}

/** pg_locks rows of the engine's own advisory locks: one per key and mode held. */
export function engineAdvisoryLocks(state: DatabaseState): Array<{ key: AdvisoryLockKey; mode: AdvisoryMode }> {
  const out: Array<{ key: AdvisoryLockKey; mode: AdvisoryMode }> = [];
  for (const held of state.advisoryLocks.values()) {
    for (const mode of ["exclusive", "share"] as const) {
      if (held[mode].session + held[mode].xact > 0) out.push({ key: held.key, mode });
    }
  }
  return out;
}

export function getAdvisoryFunctions(): Map<string, ScalarFn> {
  const m = new Map<string, ScalarFn>();
  for (const [suffix, mode] of [
    ["", "exclusive"],
    ["_shared", "share"],
  ] as const) {
    m.set(`pg_advisory_lock${suffix}`, lock(mode, false));
    m.set(`pg_advisory_xact_lock${suffix}`, lock(mode, true));
    m.set(`pg_try_advisory_lock${suffix}`, tryLock(mode, false));
    m.set(`pg_try_advisory_xact_lock${suffix}`, tryLock(mode, true));
    m.set(`pg_advisory_unlock${suffix}`, unlock(mode));
  }
  m.set("pg_advisory_unlock_all", (ctx) => {
    releaseAdvisoryLocks(ctx.state, "session");
    return tv("void", "");
  });
  return m;
}
