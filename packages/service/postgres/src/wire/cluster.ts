import { Database } from "../api/database.ts";
import type { Snapshot } from "../api/snapshot.ts";
import { PostgresError } from "../errors/error.ts";
import { type AdvisoryMode, advisoryKey, advisoryKeyText } from "../functions/advisory-fns.ts";
import {
  type AdvisoryLockEntry,
  type DatabaseCatalogContext,
  setDatabaseCatalogContext,
} from "../runtime/database-context.ts";
import type { AdvisoryLockKey } from "../storage/database-state.ts";
import type { Durability } from "./durable.ts";

/**
 * What every connection of one server shares: the engine, and the coordination the engine
 * (single-session, synchronous) does not do itself.
 *
 * - The **turn** serializes individual synchronous engine calls. Explicit transactions use
 *   per-session copy-on-write workspaces in the connection, so the turn is released after every
 *   statement and unrelated sessions keep progressing.
 * - **Locks** (advisory and row locks) per session, in exclusive or share mode (share is
 *   compatible with share), counted per session- and transaction-level hold, with waiters woken
 *   when what blocked them is released, and deadlock detection between a lock and the turn (`40P01`).
 * - **LISTEN / NOTIFY** fan-out, delivered when a listening connection is idle.
 * - Which session's statement is executing, so the SQL functions registered on the engine
 *   (`pg_backend_pid`, `pg_advisory_lock`, `pg_notify`, …) know whom they serve.
 */
export class Cluster {
  turnHolder: Session | null = null;
  private readonly turnQueue: Waiter[] = [];
  /** Every held lock by key: one hold per session and mode. */
  readonly locks = new Map<string, LockHold[]>();
  private readonly lockQueues = new Map<string, Waiter[]>();
  /** The mode of the lock request a session last found blocked (the one it then waits for). */
  private readonly requestedMode = new WeakMap<Session, AdvisoryMode>();
  readonly listeners = new Map<string, Set<Session>>();
  readonly sessions = new Map<number, Session>();
  current: Session | null = null;
  private nextPid = 1000;

  private readonly databases = new Map<string, Database>();
  /** Set in durable mode: commits are persisted through it before they are acknowledged. */
  durability: Durability | null = null;

  constructor(
    db: Database,
    readonly defaultDatabaseName = "postgres",
  ) {
    this.installDatabase(defaultDatabaseName, db);
  }

  /** The initial database, retained for the server's backwards-compatible public handle. */
  get db(): Database {
    return this.requireDatabase(this.defaultDatabaseName);
  }

  databaseNames(): string[] {
    return [...this.databases.keys()].sort();
  }
  snapshotAll(): Map<string, Snapshot> {
    return new Map([...this.databases].map(([name, db]) => [name, db.snapshot()]));
  }
  restoreAll(points: ReadonlyMap<string, Snapshot>): void {
    if (this.sessions.size > 0) throw new Error("cannot restore a catalog with active sessions");
    if (!points.has(this.defaultDatabaseName)) throw new Error("snapshot lacks default database");
    for (const db of this.databases.values()) db.close();
    this.databases.clear();
    for (const [name, point] of points) this.installDatabase(name, point.open());
  }

  getDatabase(name: string): Database | undefined {
    return this.databases.get(name);
  }

  /** Add a database that already exists (restored from durable storage) to the catalog. */
  attach(name: string, db: Database): void {
    this.installDatabase(name, db);
  }

  /** The catalog as it stands, to put back with {@link restoreCatalog} if a change cannot be persisted. */
  catalog(): Map<string, Database> {
    return new Map(this.databases);
  }

  restoreCatalog(entries: ReadonlyMap<string, Database>): void {
    this.databases.clear();
    for (const [name, db] of entries) {
      setDatabaseCatalogContext(db.state, this.catalogContext(name));
      this.databases.set(name, db);
    }
  }

  requireDatabase(name: string): Database {
    const db = this.databases.get(name);
    if (!db) throw new PostgresError("undefined_object", `database "${name}" does not exist`, "3D000");
    return db;
  }

  createDatabase(name: string, template?: string): void {
    if (this.databases.has(name)) {
      throw new PostgresError("duplicate_object", `database "${name}" already exists`, "42P04");
    }
    const db =
      template === undefined
        ? new Database({ now: this.db.now, seed: this.db.seed })
        : this.requireTemplate(template).snapshot().open();
    this.installDatabase(name, db);
  }

  dropDatabase(name: string, requester: Session): void {
    if (name === requester.databaseName || this.activeConnections(name) > 0) {
      throw new PostgresError(
        "object_not_in_prerequisite_state",
        `database "${name}" is being accessed by other users`,
        "55006",
      );
    }
    if (!this.databases.delete(name)) {
      throw new PostgresError("undefined_object", `database "${name}" does not exist`, "3D000");
    }
  }

  renameDatabase(from: string, to: string, requester: Session): void {
    if (this.databases.has(to)) {
      throw new PostgresError("duplicate_object", `database "${to}" already exists`, "42P04");
    }
    const db = this.requireDatabase(from);
    if (from === requester.databaseName || this.activeConnections(from) > 0) {
      throw new PostgresError(
        "object_not_in_prerequisite_state",
        `database "${from}" is being accessed by other users`,
        "55006",
      );
    }
    this.databases.delete(from);
    this.installDatabase(to, db);
  }

  private requireTemplate(name: string): Database {
    if (this.activeConnections(name) > 0) {
      throw new PostgresError(
        "object_not_in_prerequisite_state",
        `source database "${name}" is being accessed by other users`,
        "55006",
      );
    }
    return this.requireDatabase(name);
  }

  private activeConnections(name: string): number {
    let count = 0;
    for (const session of this.sessions.values()) if (session.databaseName === name) count++;
    return count;
  }

  /**
   * What the engine's catalogs and server-activity functions see of the server: its databases and
   * sessions (pg_stat_activity, pg_stat_database), lock waits (pg_blocking_pids), and the signals
   * pg_cancel_backend / pg_terminate_backend send.
   */
  catalogContext(name: string): DatabaseCatalogContext {
    return {
      name,
      names: () => this.databaseNames(),
      currentPid: () => this.current?.pid ?? 0,
      backends: () =>
        [...this.sessions.values()].map((session) => ({
          pid: session.pid,
          databaseName: session.databaseName,
          applicationName: session.applicationName?.() ?? "",
          state: session.activityState?.() ?? "idle",
          waiting: session.waitingForLock !== null,
          ...clientEnd(session),
        })),
      blockingPids: (pid) => {
        const session = this.sessions.get(pid);
        const key = session?.waitingForLock;
        if (!session || key == null) return [];
        return this.blockers(key, session).map((holder) => holder.pid);
      },
      advisoryLocks: () => this.advisoryLocks(),
      signalBackend: (pid, signal) => {
        const target = this.sessions.get(pid);
        if (!target) return false;
        if (signal === "cancel" && target === this.current) {
          throw new PostgresError("internal", "canceling statement due to user request", "57014");
        }
        if (signal === "cancel") target.cancel?.();
        else target.terminate?.();
        return true;
      },
    };
  }

  private installDatabase(name: string, db: Database): void {
    const context = this.catalogContext(name);
    setDatabaseCatalogContext(db.state, context);
    this.databases.set(name, db);
    registerSessionFunctions(this, db);
  }

  newPid(): number {
    return this.nextPid++;
  }

  /** Wait until this session may execute: at once when nobody holds the turn, or it does. */
  acquireTurn(session: Session): Promise<void> {
    if (this.turnHolder === null || this.turnHolder === session) {
      this.turnHolder = session;
      return Promise.resolve();
    }
    // The holder is waiting for a lock this session holds: neither can proceed.
    const holder = this.turnHolder;
    if (holder.waitingForLock !== null && this.blockers(holder.waitingForLock, holder).includes(session)) {
      return Promise.reject(deadlock());
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { session, resolve, reject };
      session.waitingForTurn = waiter;
      this.turnQueue.push(waiter);
    });
  }

  releaseTurn(session: Session): void {
    if (this.turnHolder !== session) return;
    this.turnHolder = null;
    const next = this.turnQueue.shift();
    if (next) {
      next.session.waitingForTurn = null;
      this.turnHolder = next.session;
      next.resolve();
    }
  }

  /** The sessions holding `key` in a mode that conflicts with `session`'s request (share is compatible with share). */
  blockers(
    key: string,
    session: Session,
    mode: AdvisoryMode = this.requestedMode.get(session) ?? "exclusive",
  ): Session[] {
    const out: Session[] = [];
    for (const hold of this.locks.get(key) ?? []) {
      if (hold.session === session || (mode === "share" && hold.mode === "share")) continue;
      if (!out.includes(hold.session)) out.push(hold.session);
    }
    return out;
  }

  /** Take `key` for `session` now, or report that another session holds it in a conflicting mode. */
  tryLock(session: Session, key: string, xact: boolean, mode: AdvisoryMode = "exclusive"): boolean {
    if (this.blockers(key, session, mode).length > 0) {
      this.requestedMode.set(session, mode);
      return false;
    }
    const holds = this.locks.get(key) ?? [];
    let hold = holds.find((h) => h.session === session && h.mode === mode);
    if (!hold) {
      hold = { session, mode, count: 0, xactCount: 0 };
      holds.push(hold);
      this.locks.set(key, holds);
    }
    if (xact) hold.xactCount++;
    else hold.count++;
    return true;
  }

  /** Wait until `key` is free for `session`; rejects with `40P01` when that can never happen. */
  waitLock(session: Session, key: string): Promise<void> {
    const blockers = this.blockers(key, session);
    if (blockers.length === 0) return Promise.resolve();
    // A holder of the lock waits for the turn this session holds inside its transaction block.
    if (this.turnHolder === session && blockers.some((holder) => holder.waitingForTurn !== null)) {
      return Promise.reject(deadlock());
    }
    if (
      blockers.some(
        (holder) => holder.waitingForLock !== null && this.blockers(holder.waitingForLock, holder).includes(session),
      )
    ) {
      return Promise.reject(deadlock());
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { session, resolve, reject };
      session.waitingForLock = key;
      const queue = this.lockQueues.get(key) ?? [];
      queue.push(waiter);
      this.lockQueues.set(key, queue);
    });
  }

  /** Release one session-level hold of `key` in `mode`; false when `session` holds none. */
  unlock(session: Session, key: string, mode: AdvisoryMode = "exclusive"): boolean {
    const hold = this.locks.get(key)?.find((h) => h.session === session && h.mode === mode);
    if (!hold || hold.count === 0) return false;
    hold.count--;
    this.settle(key);
    return true;
  }

  /** Release every lock `session` holds, or only its transaction-scoped ones. */
  unlockAll(session: Session, xactOnly = false): void {
    for (const [key, holds] of [...this.locks]) {
      let changed = false;
      for (const hold of holds) {
        if (hold.session !== session) continue;
        if (hold.xactCount > 0 || (!xactOnly && hold.count > 0)) changed = true;
        hold.xactCount = 0;
        if (!xactOnly) hold.count = 0;
      }
      if (changed) this.settle(key);
    }
  }

  /** Drop holds that reached zero, and wake the waiters for `key` that no longer conflict. */
  settle(key: string): void {
    const holds = (this.locks.get(key) ?? []).filter((h) => h.count + h.xactCount > 0);
    if (holds.length > 0) this.locks.set(key, holds);
    else this.locks.delete(key);
    const queue = this.lockQueues.get(key);
    if (!queue) return;
    const ready = queue.filter((waiter) => this.blockers(key, waiter.session).length === 0);
    const waiting = queue.filter((waiter) => !ready.includes(waiter));
    if (waiting.length > 0) this.lockQueues.set(key, waiting);
    else this.lockQueues.delete(key);
    for (const waiter of ready) {
      waiter.session.waitingForLock = null;
      waiter.resolve();
    }
  }

  /** pg_locks: the advisory locks held, one row per session and mode, and the requests waiting. */
  private advisoryLocks(): AdvisoryLockEntry[] {
    const out: AdvisoryLockEntry[] = [];
    const entry = (key: string, session: Session, mode: AdvisoryMode, granted: boolean) => {
      const tag = parseAdvisoryKey(key);
      if (tag) out.push({ pid: session.pid, databaseName: tag.databaseName, key: tag.key, mode, granted });
    };
    for (const [key, holds] of this.locks) for (const hold of holds) entry(key, hold.session, hold.mode, true);
    for (const [key, queue] of this.lockQueues) {
      for (const waiter of queue)
        entry(key, waiter.session, this.requestedMode.get(waiter.session) ?? "exclusive", false);
    }
    return out;
  }

  /** Forget a session: its transaction, turn, locks, waits and subscriptions. */
  drop(session: Session): void {
    this.sessions.delete(session.pid);
    for (const set of this.listeners.values()) set.delete(session);
    if (session.waitingForTurn) {
      const at = this.turnQueue.indexOf(session.waitingForTurn);
      if (at !== -1) this.turnQueue.splice(at, 1);
      session.waitingForTurn = null;
    }
    if (session.waitingForLock !== null) {
      const queue = this.lockQueues.get(session.waitingForLock) ?? [];
      const at = queue.findIndex((w) => w.session === session);
      if (at !== -1) queue.splice(at, 1);
      session.waitingForLock = null;
    }
    this.unlockAll(session);
    if (this.turnHolder === session) {
      if (session.database.transactions.inTransaction) session.database.transactions.rollback();
      this.releaseTurn(session);
    }
  }

  /** Run `fn` as `session`'s statement, so registered functions can tell who is calling. */
  as<T>(session: Session, fn: () => T): T {
    const previous = this.current;
    this.current = session;
    try {
      return fn();
    } finally {
      this.current = previous;
    }
  }

  notify(from: Session, channel: string, payload: string): void {
    for (const listener of this.listeners.get(channel) ?? []) listener.queueNotification(from.pid, channel, payload);
  }
}

type Waiter = { session: Session; resolve: () => void; reject: (error: Error) => void };

/** One session's hold of a lock in one mode: its session-level and transaction-level counts. */
type LockHold = { session: Session; mode: AdvisoryMode; count: number; xactCount: number };

/** Advisory lock keys are per database, like PostgreSQL's lock tag. */
const advisoryLockKey = (databaseName: string, key: AdvisoryLockKey): string =>
  `advisory:${JSON.stringify([databaseName, advisoryKeyText(key)])}`;

const parseAdvisoryKey = (text: string): { databaseName: string; key: AdvisoryLockKey } | null => {
  if (!text.startsWith("advisory:")) return null;
  const [databaseName, tag] = JSON.parse(text.slice("advisory:".length)) as [string, string];
  const [objsubid, classid, objid] = tag.split(":").map(Number) as [number, number, number];
  return { databaseName, key: { classid, objid, objsubid: objsubid === 2 ? 2 : 1 } };
};

const clientEnd = (session: Session): { clientAddr?: string; clientPort?: number } => {
  const addresses = session.socketAddresses?.();
  return addresses ? { clientAddr: addresses.clientAddr, clientPort: addresses.clientPort } : {};
};

/** The two ends of a connection's TCP socket (inet_server_addr() and friends). */
export type SocketAddresses = { serverAddr: string; serverPort: number; clientAddr: string; clientPort: number };

const deadlock = () =>
  new PostgresError(
    "internal",
    "deadlock detected: a transaction block is waiting for an advisory lock held by a session waiting for it",
    "40P01",
  );

/** A statement stopped by a lock another session holds; the session waits, then runs it again. */
export class LockWait extends Error {
  constructor(readonly key: string) {
    super(`waiting for advisory lock ${key}`);
    this.name = "LockWait";
  }
}

/** What the cluster needs from a connection. */
export interface Session {
  readonly pid: number;
  database: Database;
  databaseName: string;
  waitingForTurn: Waiter | null;
  waitingForLock: string | null;
  /** NOTIFYs issued inside the current transaction block, sent at commit. */
  pendingNotifies: { channel: string; payload: string }[];
  queueNotification(pid: number, channel: string, payload: string): void;
  /** pg_stat_activity's state: active, idle, idle in transaction, ... */
  activityState?(): string;
  applicationName?(): string;
  /** pg_cancel_backend: the statement in flight fails with 57014 */
  cancel?(): void;
  /** pg_terminate_backend: the connection ends with FATAL 57P01 */
  terminate?(): void;
  /** Both ends of its TCP socket; null for a connection without one (web streams, like a Unix socket). */
  socketAddresses?(): SocketAddresses | null;
}

/**
 * The session-aware SQL functions, replacing the engine's single-session stubs. They live in
 * `pg_catalog`, so a session whose `search_path` leaves out `public` still reaches them.
 */
const registerSessionFunctions = (cluster: Cluster, db: Database): void => {
  const me = (): Session => {
    if (!cluster.current) throw new PostgresError("internal", "no session is executing", "XX000");
    return cluster.current;
  };
  db.registerFunction({ name: "pg_catalog.pg_backend_pid", args: [], returns: "int4", fn: () => me().pid });
  // the host calling its own engine handle has no socket either
  const address =
    <K extends keyof SocketAddresses>(field: K) =>
    () =>
      cluster.current?.socketAddresses?.()?.[field] ?? null;
  db.registerFunction({
    name: "pg_catalog.inet_server_addr",
    args: [],
    returns: "inet",
    strict: false,
    fn: address("serverAddr"),
  });
  db.registerFunction({
    name: "pg_catalog.inet_server_port",
    args: [],
    returns: "int4",
    strict: false,
    fn: address("serverPort"),
  });
  db.registerFunction({
    name: "pg_catalog.inet_client_addr",
    args: [],
    returns: "inet",
    strict: false,
    fn: address("clientAddr"),
  });
  db.registerFunction({
    name: "pg_catalog.inet_client_port",
    args: [],
    returns: "int4",
    strict: false,
    fn: address("clientPort"),
  });
  const keyOf = (args: unknown[]): string => advisoryLockKey(me().databaseName, advisoryKey(args)!);
  const lock =
    (mode: AdvisoryMode, xact: boolean) =>
    (...args: unknown[]) => {
      const key = keyOf(args);
      if (!cluster.tryLock(me(), key, xact, mode)) throw new LockWait(key);
      return null;
    };
  const tryLock =
    (mode: AdvisoryMode, xact: boolean) =>
    (...args: unknown[]) =>
      cluster.tryLock(me(), keyOf(args), xact, mode);
  // PostgreSQL also warns "you don't own a lock of type ..." when this returns false
  const unlock =
    (mode: AdvisoryMode) =>
    (...args: unknown[]) =>
      cluster.unlock(me(), keyOf(args), mode);
  for (const args of [["int8"], ["int4", "int4"]]) {
    for (const [suffix, mode] of [
      ["", "exclusive"],
      ["_shared", "share"],
    ] as const) {
      const fn = (name: string, returns: string, impl: Parameters<Database["registerFunction"]>[0]["fn"]) =>
        db.registerFunction({ name: `pg_catalog.${name}${suffix}`, args, returns, fn: impl });
      fn("pg_advisory_lock", "void", lock(mode, false));
      fn("pg_advisory_xact_lock", "void", lock(mode, true));
      fn("pg_try_advisory_lock", "bool", tryLock(mode, false));
      fn("pg_try_advisory_xact_lock", "bool", tryLock(mode, true));
      fn("pg_advisory_unlock", "bool", unlock(mode));
    }
  }
  db.registerFunction({
    name: "pg_catalog.pg_advisory_unlock_all",
    args: [],
    returns: "void",
    fn: () => {
      // session-level advisory locks only: row locks and transaction-level locks stay
      const session = me();
      for (const [key, holds] of [...cluster.locks]) {
        if (!key.startsWith("advisory:")) continue;
        for (const hold of holds) if (hold.session === session) hold.count = 0;
        cluster.settle(key);
      }
      return null;
    },
  });
  const notify = (channel: unknown, payload: unknown) => {
    me().pendingNotifies.push({ channel: String(channel), payload: payload === null ? "" : String(payload) });
    return null;
  };
  db.registerFunction({
    name: "pg_catalog.pg_notify",
    args: ["text", "text"],
    returns: "void",
    strict: false,
    fn: notify,
  });
  db.registerFunction({
    name: "pg_catalog.pg_listening_channels",
    args: [],
    returns: "text",
    fn: () => [...cluster.listeners].find(([, set]) => set.has(me()))?.[0] ?? null,
  });
};
