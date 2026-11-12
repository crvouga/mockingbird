import type { DatabaseState } from "../storage/database-state.ts";

/** A backend of the server, as pg_stat_activity lists it. */
export type BackendActivity = {
  pid: number;
  databaseName: string;
  applicationName: string;
  /** `active`, `idle`, `idle in transaction`, `idle in transaction (aborted)` */
  state: string;
  /** waiting on a lock another backend holds */
  waiting: boolean;
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
