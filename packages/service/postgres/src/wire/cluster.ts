import { Database } from "../api/database.ts";
import type { Snapshot } from "../api/snapshot.ts";
import { PostgresError } from "../errors/error.ts";
import { type DatabaseCatalogContext, setDatabaseCatalogContext } from "../runtime/database-context.ts";
import type { Durability } from "./durable.ts";

/**
 * What every connection of one server shares: the engine, and the coordination the engine
 * (single-session, synchronous) does not do itself.
 *
 * - The **turn** serializes individual synchronous engine calls. Explicit transactions use
 *   per-session copy-on-write workspaces in the connection, so the turn is released after every
 *   statement and unrelated sessions keep progressing.
 * - **Advisory locks** per session, with waiters woken in order, and deadlock detection
 *   between a lock and the turn (`40P01`).
 * - **LISTEN / NOTIFY** fan-out, delivered when a listening connection is idle.
 * - Which session's statement is executing, so the SQL functions registered on the engine
 *   (`pg_backend_pid`, `pg_advisory_lock`, `pg_notify`, …) know whom they serve.
 */
export class Cluster {
  turnHolder: Session | null = null;
  private readonly turnQueue: Waiter[] = [];
  readonly locks = new Map<string, { holder: Session; count: number; xact: boolean }>();
  private readonly lockQueues = new Map<string, Waiter[]>();
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
        })),
      blockingPids: (pid) => {
        const key = this.sessions.get(pid)?.waitingForLock;
        const holder = key == null ? undefined : this.locks.get(key)?.holder;
        return holder && holder.pid !== pid ? [holder.pid] : [];
      },
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
    if (holder.waitingForLock !== null && this.locks.get(holder.waitingForLock)?.holder === session) {
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

  /** Take `key` for `session` now, or report that another session holds it. */
  tryLock(session: Session, key: string, xact: boolean): boolean {
    const held = this.locks.get(key);
    if (held && held.holder !== session) return false;
    if (held) held.count++;
    else this.locks.set(key, { holder: session, count: 1, xact });
    return true;
  }

  /** Wait until `key` is free for `session`; rejects with `40P01` when that can never happen. */
  waitLock(session: Session, key: string): Promise<void> {
    const holder = this.locks.get(key)?.holder;
    if (!holder) return Promise.resolve();
    // The lock's holder waits for the turn this session holds inside its transaction block.
    if (this.turnHolder === session && holder.waitingForTurn !== null) return Promise.reject(deadlock());
    if (holder.waitingForLock !== null && this.locks.get(holder.waitingForLock)?.holder === session) {
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

  unlock(session: Session, key: string): boolean {
    const held = this.locks.get(key);
    if (!held || held.holder !== session) return false;
    held.count--;
    if (held.count > 0) return true;
    this.locks.delete(key);
    const next = this.lockQueues.get(key)?.shift();
    if (next) {
      next.session.waitingForLock = null;
      next.resolve();
    }
    return true;
  }

  /** Release every lock `session` holds, or only its transaction-scoped ones. */
  unlockAll(session: Session, xactOnly = false): void {
    for (const [key, held] of [...this.locks]) {
      if (held.holder !== session || (xactOnly && !held.xact)) continue;
      held.count = 1;
      this.unlock(session, key);
    }
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
}

const lockKey = (args: unknown[]): string => args.map((a) => String(a)).join(":");

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
  const lock =
    (xact: boolean) =>
    (...args: unknown[]) => {
      const key = lockKey(args);
      if (!cluster.tryLock(me(), key, xact)) throw new LockWait(key);
      return null;
    };
  const tryLock =
    (xact: boolean) =>
    (...args: unknown[]) =>
      cluster.tryLock(me(), lockKey(args), xact);
  const unlock = (...args: unknown[]) => cluster.unlock(me(), lockKey(args));
  for (const args of [["int8"], ["int4", "int4"]]) {
    db.registerFunction({ name: "pg_catalog.pg_advisory_lock", args, returns: "void", fn: lock(false) });
    db.registerFunction({ name: "pg_catalog.pg_advisory_xact_lock", args, returns: "void", fn: lock(true) });
    db.registerFunction({ name: "pg_catalog.pg_try_advisory_lock", args, returns: "bool", fn: tryLock(false) });
    db.registerFunction({ name: "pg_catalog.pg_try_advisory_xact_lock", args, returns: "bool", fn: tryLock(true) });
    db.registerFunction({ name: "pg_catalog.pg_advisory_unlock", args, returns: "bool", fn: unlock });
  }
  db.registerFunction({
    name: "pg_catalog.pg_advisory_unlock_all",
    args: [],
    returns: "void",
    fn: () => {
      cluster.unlockAll(me());
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
