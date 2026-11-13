import { pgError } from "../errors/error.ts";

/** The part of the database state `statement_timeout` uses. */
export interface StatementTimeoutState {
  statementDeadline: number | null;
  deadlineTicks: number;
  getSetting(name: string): string | undefined;
}

/** How many {@link checkStatementTimeout} calls pass between clock reads (a power of two). */
const TICKS_PER_CHECK = 512;

const UNIT_MS: Record<string, number> = { us: 0.001, ms: 1, s: 1000, min: 60_000, h: 3_600_000, d: 86_400_000 };

const monotonicMs = (): number => globalThis.performance?.now() ?? Date.now();

/** A canonical `statement_timeout` value (`0`, `5ms`, `1s`, `2min`, ...) in milliseconds; 0 disables it. */
export function timeoutSettingMs(value: string | undefined): number {
  if (value === undefined) return 0;
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*(us|ms|s|min|h|d)?\s*$/i.exec(value);
  if (!match) return 0;
  const ms = Number(match[1]) * (UNIT_MS[(match[2] ?? "ms").toLowerCase()] ?? 1);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/** SQLSTATE 57014, as PostgreSQL reports a statement it cancelled for running past `statement_timeout`. */
export function statementTimeoutError(): Error {
  return pgError("internal", "canceling statement due to statement timeout", "57014");
}

/**
 * Run one top-level statement under the session's `statement_timeout` (wall time, whatever the
 * clock mode, as PostgreSQL enforces it). A statement nested in another keeps the outer deadline.
 */
export function withStatementTimeout<T>(state: StatementTimeoutState, fn: () => T): T {
  if (state.statementDeadline !== null) return fn();
  const ms = timeoutSettingMs(state.getSetting("statement_timeout"));
  if (ms === 0) return fn();
  state.statementDeadline = monotonicMs() + ms;
  state.deadlineTicks = 0;
  try {
    return fn();
  } finally {
    state.statementDeadline = null;
  }
}

/** Run `fn` with no `statement_timeout` (the wire server replaying a transaction's earlier statements). */
export function withoutStatementTimeout<T>(state: StatementTimeoutState, fn: () => T): T {
  const saved = state.statementDeadline;
  state.statementDeadline = Number.POSITIVE_INFINITY;
  try {
    return fn();
  } finally {
    state.statementDeadline = saved;
  }
}

/**
 * Cooperative cancellation point for hot executor loops: cheap when no timeout is set (one null
 * check), and reads the clock only every {@link TICKS_PER_CHECK} calls otherwise.
 */
export function checkStatementTimeout(state: StatementTimeoutState): void {
  const deadline = state.statementDeadline;
  if (deadline === null) return;
  if ((++state.deadlineTicks & (TICKS_PER_CHECK - 1)) !== 0) return;
  if (monotonicMs() >= deadline) throw statementTimeoutError();
}

/** Milliseconds left before the running statement's deadline, or null when none applies. */
export function statementTimeLeftMs(state: StatementTimeoutState): number | null {
  const deadline = state.statementDeadline;
  if (deadline === null || deadline === Number.POSITIVE_INFINITY) return null;
  return deadline - monotonicMs();
}

let sleepCell: Int32Array | null | undefined;

/**
 * Block the thread for `ms` milliseconds: `Atomics.wait` where the platform allows it (Node, Bun,
 * workers), a spin on the monotonic clock otherwise (a browser's main thread).
 */
export function blockingSleep(ms: number): void {
  if (!(ms > 0)) return;
  const end = monotonicMs() + ms;
  if (sleepCell === undefined) {
    try {
      sleepCell = typeof SharedArrayBuffer === "function" ? new Int32Array(new SharedArrayBuffer(4)) : null;
    } catch {
      sleepCell = null;
    }
  }
  for (;;) {
    const left = end - monotonicMs();
    if (left <= 0) return;
    if (sleepCell) {
      try {
        Atomics.wait(sleepCell, 0, 0, left);
      } catch {
        sleepCell = null;
      }
    }
  }
}
