import type { AdvisoryLockKey, DatabaseState } from "../storage/database-state.ts";

/** A backend of the server, as pg_stat_activity lists it. */
export type BackendActivity = {
  pid: number;
  databaseName: string;
  applicationName: string;
  /** `active`, `idle`, `idle in transaction`, `idle in transaction (aborted)` */
  state: string;
  /** waiting on a lock another backend holds */
  waiting: boolean;
  /** the client end of its TCP socket; absent for a connection without one (web streams) */
  clientAddr?: string;
  clientPort?: number;
};

/** An advisory lock a wire session holds or waits for, as pg_locks lists it. */
export type AdvisoryLockEntry = {
  pid: number;
  databaseName: string;
  key: AdvisoryLockKey;
  mode: "exclusive" | "share";
  granted: boolean;
};

export type DatabaseCatalogContext = {
  name: string;
  names: () => readonly string[];
  /** The wire server's sessions; absent for an engine used on its own (one backend). */
  backends?: () => readonly BackendActivity[];
  /** pid of the session running the current statement */
  currentPid?: () => number;
  /** pg_blocking_pids: the sessions holding a lock `pid` waits for */
  blockingPids?: (pid: number) => readonly number[];
  /** pg_locks: the advisory locks of every session (the engine on its own lists its own instead) */
  advisoryLocks?: () => readonly AdvisoryLockEntry[];
  /** pg_cancel_backend / pg_terminate_backend for another session: false when there is no such session */
  signalBackend?: (pid: number, signal: "cancel" | "terminate") => boolean;
};

const contexts = new WeakMap<DatabaseState, DatabaseCatalogContext>();
const fallback: DatabaseCatalogContext = { name: "postgres", names: () => ["postgres"] };

/** @internal Wire-cluster catalog metadata used by SQL functions and catalog views. */
export function databaseCatalogContext(state: DatabaseState): DatabaseCatalogContext {
  return contexts.get(state) ?? fallback;
}

/** @internal Attach an engine to its owning wire cluster. */
export function setDatabaseCatalogContext(state: DatabaseState, context: DatabaseCatalogContext): void {
  contexts.set(state, context);
}
