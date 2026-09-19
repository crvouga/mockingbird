import { categoryFromSqlstate } from "./classify.ts";
import type { CellValue, ErrorPhase, QueryError, QueryResult } from "./types.ts";

export function normalizeErrorMessage(message: string): string {
  return message
    .replace(/^(PostgresError|error):\s*/i, "")
    .split("\n")[0]!
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tier-B message normalization for cross-engine compare: keep the shape of the
 * message but strip detail PostgreSQL legitimately varies on (positions,
 * quoted object names inside standard templates, hint text).
 */
export function normalizeErrorMessageForCompare(message: string): string {
  let msg = normalizeErrorMessage(message)
    .replace(/ at character \d+$/i, "")
    .replace(/ at or near ".*"$/i, ' at or near "?"')
    .replace(/LINE \d+:.*$/i, "")
    .trim();
  // constraint names are engine-generated and may differ in casing/underscore detail
  msg = msg.replace(/constraint "[^"]+"/g, 'constraint "?"');
  return msg;
}

export function normalizeError(message: string, sqlstate?: string, extras?: { phase?: ErrorPhase }): QueryError {
  const normalizedMessage = normalizeErrorMessage(message);
  return {
    category: categoryFromSqlstate(sqlstate),
    message: normalizedMessage,
    ...(sqlstate ? { sqlstate } : {}),
    ...(extras?.phase ? { phase: extras.phase } : {}),
  };
}

function cellsEqual(a: CellValue, b: CellValue, realEpsilon?: number): boolean {
  if (a === null || b === null) return a === b;
  if (a === b) return true;
  if (realEpsilon !== undefined) {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      return Math.abs(na - nb) <= realEpsilon;
    }
  }
  return false;
}

export interface CompareOptions {
  /** Absolute epsilon applied when both cells parse as finite numbers (ts_rank noise only). */
  realEpsilon?: number;
  /** Compare cells positionally; ignore result-column header spelling. */
  ignoreColumnNames?: boolean;
  /** Skip changes / command-tag comparison (SELECT leftovers). */
  ignoreWriteCounters?: boolean;
  /** Skip inTransaction comparison. */
  ignoreSession?: boolean;
  /** A = exact message; B = template-normalized (default for error parity). */
  messageTier?: "A" | "B";
  /** Skip SQLSTATE comparison. */
  ignoreSqlstate?: boolean;
  /** Skip prepare vs step phase comparison. */
  ignoreErrorPhase?: boolean;
  /** Sort both row sets textually before comparing (unordered queries). */
  unordered?: boolean;
}

export function deepCompareResults(
  a: QueryResult,
  b: QueryResult,
  options?: CompareOptions,
): { equal: boolean; reason?: string } {
  if (a.ok !== b.ok) {
    const detail = (r: QueryResult) => (r.ok ? "ok" : `error: ${r.error?.message ?? "?"}`);
    return { equal: false, reason: `ok mismatch: ${detail(a)} vs ${detail(b)}` };
  }

  if (!a.ok) {
    const ea = a.error;
    const eb = b.error;
    if (!ea || !eb) return { equal: false, reason: "error metadata mismatch" };
    if (ea.category !== eb.category) {
      return {
        equal: false,
        reason: `error category mismatch: ${ea.category} (${ea.sqlstate ?? "?"}: ${ea.message}) vs ${eb.category} (${eb.sqlstate ?? "?"}: ${eb.message})`,
      };
    }
    if (!options?.ignoreSqlstate && ea.sqlstate && eb.sqlstate && ea.sqlstate !== eb.sqlstate) {
      return { equal: false, reason: `sqlstate mismatch: ${ea.sqlstate} vs ${eb.sqlstate}` };
    }
    const tier = options?.messageTier ?? "B";
    const ma = tier === "A" ? normalizeErrorMessage(ea.message) : normalizeErrorMessageForCompare(ea.message);
    const mb = tier === "A" ? normalizeErrorMessage(eb.message) : normalizeErrorMessageForCompare(eb.message);
    if (ma !== mb) {
      return { equal: false, reason: `error message mismatch:\n  a: ${ea.message}\n  b: ${eb.message}` };
    }
    if (!options?.ignoreErrorPhase && ea.phase && eb.phase && ea.phase !== eb.phase) {
      return { equal: false, reason: `error phase mismatch: ${ea.phase} vs ${eb.phase}` };
    }
    return { equal: true };
  }

  if (!options?.ignoreColumnNames) {
    if (a.columns.length !== b.columns.length) {
      return { equal: false, reason: `column count mismatch: ${a.columns.length} vs ${b.columns.length}` };
    }
    for (let i = 0; i < a.columns.length; i++) {
      if (a.columns[i] !== b.columns[i]) {
        return { equal: false, reason: `column name mismatch at ${i}: ${a.columns[i]} vs ${b.columns[i]}` };
      }
    }
  }

  let rowsA = a.values;
  let rowsB = b.values;
  if (options?.unordered) {
    const key = (row: CellValue[]) => row.map((c) => (c === null ? "\u0000NULL" : c)).join("\u0001");
    rowsA = [...rowsA].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
    rowsB = [...rowsB].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
  }

  if (rowsA.length !== rowsB.length) {
    return { equal: false, reason: `row count mismatch: ${rowsA.length} vs ${rowsB.length}` };
  }
  for (let r = 0; r < rowsA.length; r++) {
    const rowA = rowsA[r]!;
    const rowB = rowsB[r]!;
    if (rowA.length !== rowB.length) {
      return { equal: false, reason: `value width mismatch at row ${r}: ${rowA.length} vs ${rowB.length}` };
    }
    for (let c = 0; c < rowA.length; c++) {
      if (!cellsEqual(rowA[c]!, rowB[c]!, options?.realEpsilon)) {
        const colName = a.columns[c] ?? b.columns[c] ?? `column ${c}`;
        return {
          equal: false,
          reason: `value mismatch at row ${r}, column ${colName}: ${JSON.stringify(rowA[c])} vs ${JSON.stringify(rowB[c])}`,
        };
      }
    }
  }

  if (!options?.ignoreWriteCounters) {
    if (a.changes !== b.changes) {
      return { equal: false, reason: `changes mismatch: ${a.changes} vs ${b.changes}` };
    }
    if (a.command && b.command && a.command !== b.command) {
      return { equal: false, reason: `command tag mismatch: ${a.command} vs ${b.command}` };
    }
  }

  if (
    !options?.ignoreSession &&
    a.inTransaction !== undefined &&
    b.inTransaction !== undefined &&
    a.inTransaction !== b.inTransaction
  ) {
    return { equal: false, reason: `inTransaction mismatch: ${a.inTransaction} vs ${b.inTransaction}` };
  }

  return { equal: true };
}
