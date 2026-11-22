/**
 * Statement observers (#898). The engine runs every statement synchronously on the host's thread, so
 * one slow statement stalls everything else in the process. An observer is told about each
 * statement after it finishes: its text, how long it took, how many rows it returned or changed,
 * and the error it raised. A threshold keeps the reports to slow statements.
 *
 * @module
 */

/** One finished statement, as reported to {@link StatementObserver}. */
export interface StatementEvent {
  /** The statement text. A multi-statement `exec()` script is reported one statement at a time. */
  sql: string;
  /**
   * The bound parameter values. Present only when the host opted in with `includeParams`: they
   * may hold personal data or be large.
   */
  params?: readonly unknown[];
  /** Wall time the statement took, in milliseconds (`performance.now()` resolution). */
  durationMs: number;
  /** Rows returned (SELECT, RETURNING) or affected (INSERT / UPDATE / DELETE); 0 when it failed. */
  rows: number;
  /** The command tag, e.g. `"SELECT"`; absent when the statement failed. */
  command?: string;
  /** What the statement threw, when it failed. The error still reaches the caller unchanged. */
  error?: unknown;
  /** Wire server only: the backend process id of the connection that ran it. */
  pid?: number;
}

/** Called after a statement finishes. A throw from the observer is ignored, never seen by SQL. */
export type StatementObserver = (event: StatementEvent) => void;

/** How a host observes statements: on {@link DatabaseOptions}, `serve()` and `createWireServer()`. */
export interface StatementObserverOptions {
  /**
   * Called after each statement that took at least {@link slowStatementMs}. Unset (the default),
   * nothing is timed and statements cost what they did without an observer.
   */
  onStatement?: StatementObserver;
  /**
   * Report only statements that took at least this many milliseconds. `0` (the default) reports
   * every statement.
   */
  slowStatementMs?: number;
  /** Include bound parameter values in each {@link StatementEvent} (`params`). Off by default. */
  includeParams?: boolean;
}

/** A registered observer with its own threshold. */
export interface StatementObservation {
  readonly observer: StatementObserver;
  readonly thresholdMs: number;
  readonly includeParams: boolean;
}

export function observation(options: StatementObserverOptions): StatementObservation | null {
  if (!options.onStatement) return null;
  const threshold = options.slowStatementMs ?? 0;
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new RangeError("slowStatementMs must be a non-negative number of milliseconds");
  }
  return { observer: options.onStatement, thresholdMs: threshold, includeParams: options.includeParams === true };
}

/** Hand one finished statement to every observer whose threshold it reached. */
export function notifyStatement(
  observations: readonly StatementObservation[],
  event: Omit<StatementEvent, "params">,
  params: readonly unknown[],
): void {
  for (const o of observations) {
    if (event.durationMs < o.thresholdMs) continue;
    try {
      o.observer(o.includeParams ? { ...event, params: params.slice() } : { ...event });
    } catch {
      // an observer is a diagnostic tap: it must not turn a finished statement into a failure
    }
  }
}

/** A slow statement as the admin surface lists it: never with parameter values. */
export interface SlowStatement {
  sql: string;
  durationMs: number;
  rows: number;
  /** Unix milliseconds when the statement finished. */
  at: number;
  /** The SQLSTATE and message, when the statement failed. */
  error?: { code: string; message: string };
}

/** The most recent slow statements, newest first, bounded to `limit` entries. */
export class SlowStatementLog {
  private readonly entries: SlowStatement[] = [];
  constructor(readonly limit = 50) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError("slow statement limit must be a positive integer");
  }

  record(event: StatementEvent, at = Date.now()): void {
    const error =
      event.error === undefined
        ? undefined
        : {
            code: (event.error as { sqlState?: unknown })?.sqlState?.toString() ?? "XX000",
            message: event.error instanceof Error ? event.error.message : String(event.error),
          };
    this.entries.unshift({
      sql: event.sql,
      durationMs: Math.round(event.durationMs * 1000) / 1000,
      rows: event.rows,
      at,
      ...(error ? { error } : {}),
    });
    if (this.entries.length > this.limit) this.entries.length = this.limit;
  }

  list(): SlowStatement[] {
    return this.entries.map((entry) => ({ ...entry, ...(entry.error ? { error: { ...entry.error } } : {}) }));
  }

  clear(): void {
    this.entries.length = 0;
  }
}
