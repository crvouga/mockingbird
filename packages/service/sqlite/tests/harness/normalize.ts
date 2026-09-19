import type {
  ErrorCategory,
  ErrorPhase,
  NormalizedResult,
  NormalizedValue,
  QueryError,
  QueryResult,
  SqlValue,
} from "./types.ts";

export function normalizeValue(value: SqlValue): NormalizedValue {
  if (value === null) return { kind: "null" };
  if (value instanceof Uint8Array) return { kind: "blob", value: new Uint8Array(value) };
  if (typeof value === "string") return { kind: "text", value };
  if (typeof value === "bigint") return { kind: "integer", value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { kind: "integer", value } : { kind: "real", value };
  }
  // SqlReal / SqlJsonText and similar wrappers
  if (typeof value === "object" && value !== null && "value" in value) {
    const inner = (value as { value: unknown }).value;
    if (typeof inner === "number") {
      return Number.isInteger(inner) ? { kind: "integer", value: inner } : { kind: "real", value: inner };
    }
    if (typeof inner === "string") return { kind: "text", value: inner };
  }
  return { kind: "text", value: String(value) };
}

export function normalizeErrorMessage(message: string): string {
  return message
    .replace(/^(SQLiteError|SqliteError):\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalize error messages for differential comparison.
 * Keeps category-defining prefixes; strips engine-specific detail that SQLite
 * versions legitimately vary on (column lists after UNIQUE/CHECK, etc.).
 */
export function normalizeErrorMessageForCompare(message: string): string {
  const msg = normalizeErrorMessage(message);
  const lower = msg.toLowerCase();

  if (lower.startsWith("unique constraint failed")) {
    return "UNIQUE constraint failed";
  }
  if (lower.startsWith("primary key constraint failed")) {
    return "PRIMARY KEY constraint failed";
  }
  if (lower.startsWith("not null constraint failed")) {
    return "NOT NULL constraint failed";
  }
  if (lower.startsWith("check constraint failed")) {
    return "CHECK constraint failed";
  }
  if (lower.startsWith("foreign key constraint failed")) {
    return "FOREIGN KEY constraint failed";
  }
  if (lower.includes("cannot store") && lower.includes("column")) {
    return "cannot store value in STRICT column";
  }
  if (lower.startsWith("unknown datatype")) {
    return "unknown datatype";
  }
  if (/selects to the left and right of .+ do not have the same number of result columns/.test(lower)) {
    return "compound select column count mismatch";
  }
  if (lower.startsWith("cannot drop primary key") || lower.startsWith("cannot drop column")) {
    return "cannot drop column";
  }
  if (lower.startsWith("misuse of window function") || lower.includes("window expression requires window")) {
    return "misuse of window function";
  }
  if (lower.startsWith("no such column")) {
    return "no such column";
  }
  if (lower.startsWith("no such table")) {
    return "no such table";
  }
  if (/syntax error|unexpected token|near "/.test(lower)) {
    return "syntax error";
  }
  if (lower.startsWith("unrecognized token")) {
    return "unrecognized token";
  }
  if (lower.startsWith("datatype mismatch")) {
    return "datatype mismatch";
  }
  return msg;
}

export function categorizeErrorMessage(message: string): ErrorCategory {
  const msg = normalizeErrorMessage(message).toLowerCase();

  if (/syntax error|near "[^"]+"|incomplete input|unrecognized token|unterminated/.test(msg)) {
    return "syntax";
  }
  if (/no such table/.test(msg)) return "no_such_table";
  if (/no such column/.test(msg)) return "no_such_column";
  if (/unique constraint failed/.test(msg)) return "constraint_unique";
  if (/primary key constraint failed/.test(msg)) return "constraint_primary";
  if (/not null constraint failed/.test(msg)) return "constraint_notnull";
  if (/check constraint failed/.test(msg)) return "constraint_check";
  if (/foreign key constraint failed/.test(msg)) return "constraint_foreign";
  if (/constraint failed/.test(msg)) return "constraint";
  if (/cannot start a transaction|cannot commit|cannot rollback|no transaction is active/.test(msg)) {
    return "transaction";
  }
  if (/cannot store .+ value in .+ column/.test(msg)) return "datatype_mismatch";
  if (/unknown datatype/.test(msg)) return "other";
  if (/datatype mismatch|type mismatch/.test(msg)) return "datatype_mismatch";
  if (/unable to use function match/.test(msg)) return "unsupported";
  if (/cannot insert into generated column|cannot update generated column/.test(msg)) return "misuse";
  if (/misuse of window function|window expression requires window/.test(msg)) return "misuse";
  if (/unsupported|not supported|not yet implemented/.test(msg)) return "unsupported";
  if (/misuse|bad parameter|api misuse|expected \d+ values, received/.test(msg)) return "misuse";

  return "other";
}

export function sqliteCodeFromMessage(message: string, category?: ErrorCategory): string {
  const msg = normalizeErrorMessage(message).toLowerCase();
  if (/unique constraint failed/.test(msg)) return "SQLITE_CONSTRAINT_UNIQUE";
  if (/primary key constraint failed/.test(msg)) return "SQLITE_CONSTRAINT_PRIMARYKEY";
  if (/not null constraint failed/.test(msg)) return "SQLITE_CONSTRAINT_NOTNULL";
  if (/check constraint failed/.test(msg)) return "SQLITE_CONSTRAINT_CHECK";
  if (/foreign key constraint failed/.test(msg)) return "SQLITE_CONSTRAINT_FOREIGNKEY";
  if (/constraint failed/.test(msg)) return "SQLITE_CONSTRAINT";
  if (/no such table/.test(msg)) return "SQLITE_ERROR";
  if (/no such column/.test(msg)) return "SQLITE_ERROR";
  if (/datatype mismatch|type mismatch/.test(msg)) return "SQLITE_MISMATCH";
  if (/misuse|database is closed|empty statement|expected \d+ values/.test(msg)) return "SQLITE_MISUSE";
  if (category === "syntax" || /syntax error|near "|incomplete input/.test(msg)) return "SQLITE_ERROR";
  if (category === "transaction") return "SQLITE_ERROR";
  if (category === "unsupported") return "SQLITE_ERROR";
  if (category === "snapshot_version") return "SQLITE_FORMAT";
  return "SQLITE_ERROR";
}

export function numericSqliteCodeToName(code: number): string {
  switch (code) {
    case 1:
      return "SQLITE_ERROR";
    case 8:
      return "SQLITE_READONLY";
    case 11:
      return "SQLITE_CORRUPT";
    case 13:
      return "SQLITE_FULL";
    case 19:
      return "SQLITE_CONSTRAINT";
    case 20:
      return "SQLITE_MISMATCH";
    case 21:
      return "SQLITE_MISUSE";
    case 26:
      return "SQLITE_NOTADB";
    default:
      return `SQLITE_${code}`;
  }
}

export function normalizeError(
  message: string,
  category?: ErrorCategory,
  extras?: { sqliteCode?: string; phase?: ErrorPhase },
): QueryError {
  const normalizedMessage = normalizeErrorMessage(message);
  const resolvedCategory = category ?? categorizeErrorMessage(normalizedMessage);
  return {
    category: resolvedCategory,
    message: normalizedMessage,
    sqliteCode: extras?.sqliteCode ?? sqliteCodeFromMessage(normalizedMessage, resolvedCategory),
    ...(extras?.phase ? { phase: extras.phase } : {}),
  };
}

export function normalizeQueryResult(result: QueryResult): NormalizedResult {
  const valueRows = result.values;
  const columns = [...result.columns];
  const rows =
    valueRows && (valueRows.length > 0 || columns.length > 0)
      ? valueRows.map((row) => row.map((value) => normalizeValue(value)))
      : result.rows.map((row) => columns.map((column) => normalizeValue(row[column] ?? null)));

  const normalized: NormalizedResult = {
    ok: result.ok,
    columns,
    rows: result.ok ? rows : [],
    changes: result.changes,
    lastInsertRowid: result.lastInsertRowid,
    lastInsertRowidKind: result.lastInsertRowidKind,
    totalChanges: result.totalChanges,
    inTransaction: result.inTransaction,
  };

  if (result.error) {
    normalized.error = normalizeError(result.error.message, result.error.category, {
      sqliteCode: result.error.sqliteCode,
      phase: result.error.phase,
    });
  }

  return normalized;
}

export interface ValuesEqualOptions {
  /** When true, number and bigint representing the same integer are equal. */
  rowid?: boolean;
}

export function valuesEqual(a: SqlValue, b: SqlValue, options: ValuesEqualOptions = {}): boolean {
  if (a === null || b === null) return a === b;

  if (typeof a === "number" && typeof b === "number") {
    if (options.rowid && Number.isInteger(a) && Number.isInteger(b)) {
      return BigInt(a) === BigInt(b);
    }
    return Object.is(a, b);
  }

  if (a === b) return true;

  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
  if (a instanceof Uint8Array || b instanceof Uint8Array) return false;

  if (typeof a === "string" || typeof b === "string") {
    return typeof a === "string" && typeof b === "string" && a === b;
  }

  const aIsInt = typeof a === "bigint" || (typeof a === "number" && Number.isInteger(a));
  const bIsInt = typeof b === "bigint" || (typeof b === "number" && Number.isInteger(b));

  if (options.rowid && aIsInt && bIsInt) {
    try {
      return BigInt(a as number | bigint) === BigInt(b as number | bigint);
    } catch {
      return false;
    }
  }

  if (typeof a === "bigint" && typeof b === "bigint") {
    return a === b;
  }

  return false;
}

function normalizedValuesEqual(a: NormalizedValue, b: NormalizedValue, rowid = false, realEpsilon?: number): boolean {
  if (a.kind !== b.kind) {
    if (rowid && a.kind === "integer" && b.kind === "integer") {
      try {
        return BigInt(a.value) === BigInt(b.value);
      } catch {
        return false;
      }
    }
    return false;
  }

  switch (a.kind) {
    case "null":
      return true;
    case "integer":
      try {
        return BigInt(a.value) === BigInt((b as Extract<NormalizedValue, { kind: "integer" }>).value);
      } catch {
        return false;
      }
    case "real": {
      const av = a.value;
      const bv = (b as Extract<NormalizedValue, { kind: "real" }>).value;
      if (Object.is(av, bv)) return true;
      if (realEpsilon !== undefined && Number.isFinite(av) && Number.isFinite(bv)) {
        return Math.abs(av - bv) <= realEpsilon;
      }
      return false;
    }
    case "text":
      return a.value === (b as Extract<NormalizedValue, { kind: "text" }>).value;
    case "blob": {
      const bb = b as Extract<NormalizedValue, { kind: "blob" }>;
      if (a.value.length !== bb.value.length) return false;
      for (let i = 0; i < a.value.length; i++) {
        if (a.value[i] !== bb.value[i]) return false;
      }
      return true;
    }
  }
}

function positionalRowsEqual(a: NormalizedResult, b: NormalizedResult, realEpsilon?: number): boolean {
  if (a.rows.length !== b.rows.length) return false;
  for (let r = 0; r < a.rows.length; r++) {
    const rowA = a.rows[r]!;
    const rowB = b.rows[r]!;
    if (rowA.length !== rowB.length) return false;
    for (let c = 0; c < rowA.length; c++) {
      const colName = a.columns[c] ?? b.columns[c] ?? "";
      const isRowid = colName.toLowerCase().includes("rowid") || colName.toLowerCase() === "oid";
      if (!normalizedValuesEqual(rowA[c]!, rowB[c]!, isRowid, realEpsilon)) return false;
    }
  }
  return true;
}

export interface CompareOptions {
  /**
   * Absolute epsilon for REAL comparisons (FTS bm25/rank ULP noise only).
   * Default: exact Object.is. Do not enable for general SQL parity.
   */
  realEpsilon?: number;
  /** Compare cells positionally; ignore result-column header spelling. */
  ignoreColumnNames?: boolean;
  /**
   * Skip changes / lastInsertRowid / totalChanges comparison.
   * Query helpers set this so SELECT is not compared against leftover write counters.
   */
  ignoreWriteCounters?: boolean;
  /** Skip inTransaction comparison. */
  ignoreSession?: boolean;
  /**
   * Error message comparison: A = exact (after SqliteError prefix strip);
   * B = prefix-normalized (UNIQUE/CHECK/no such table, …).
   */
  messageTier?: "A" | "B";
  /** Skip sqliteCode comparison when either side is missing a code. */
  ignoreSqliteCode?: boolean;
  /** Skip prepare vs step phase comparison. */
  ignoreErrorPhase?: boolean;
}

export function deepCompareResults(
  a: QueryResult,
  b: QueryResult,
  options?: CompareOptions,
): { equal: boolean; reason?: string } {
  const na = normalizeQueryResult(a);
  const nb = normalizeQueryResult(b);
  const realEpsilon = options?.realEpsilon;

  if (na.ok !== nb.ok) {
    return { equal: false, reason: `ok mismatch: ${na.ok} vs ${nb.ok}` };
  }

  if (!na.ok || !nb.ok) {
    const ea = na.error;
    const eb = nb.error;
    if (!ea || !eb) {
      return { equal: false, reason: "error metadata mismatch" };
    }
    if (ea.category !== eb.category) {
      return {
        equal: false,
        reason: `error category mismatch: ${ea.category} vs ${eb.category}`,
      };
    }
    const ma =
      options?.messageTier === "A" ? normalizeErrorMessage(ea.message) : normalizeErrorMessageForCompare(ea.message);
    const mb =
      options?.messageTier === "A" ? normalizeErrorMessage(eb.message) : normalizeErrorMessageForCompare(eb.message);
    if (ma !== mb) {
      return {
        equal: false,
        reason: `error message mismatch:\n  a: ${ea.message}\n  b: ${eb.message}`,
      };
    }
    if (!options?.ignoreSqliteCode && ea.sqliteCode && eb.sqliteCode) {
      const ca = generalizeConstraintCode(ea.sqliteCode);
      const cb = generalizeConstraintCode(eb.sqliteCode);
      if (ca !== cb) {
        return { equal: false, reason: `sqliteCode mismatch: ${ea.sqliteCode} vs ${eb.sqliteCode}` };
      }
    }
    if (!options?.ignoreErrorPhase && ea.phase && eb.phase && ea.phase !== eb.phase) {
      return { equal: false, reason: `error phase mismatch: ${ea.phase} vs ${eb.phase}` };
    }
    return { equal: true };
  }

  if (na.columns.length !== nb.columns.length) {
    // bun:sqlite may collapse duplicate headers or keep stale prepared columnNames after
    // ALTER while values() still returns the full width. Prefer positional values.
    if (!positionalRowsEqual(na, nb, realEpsilon)) {
      return { equal: false, reason: "column count mismatch" };
    }
  } else if (!options?.ignoreColumnNames) {
    for (let i = 0; i < na.columns.length; i++) {
      if (na.columns[i] !== nb.columns[i]) {
        return {
          equal: false,
          reason: `column name mismatch at ${i}: ${na.columns[i]} vs ${nb.columns[i]}`,
        };
      }
    }
  }

  if (na.rows.length !== nb.rows.length) {
    return { equal: false, reason: `row count mismatch: ${na.rows.length} vs ${nb.rows.length}` };
  }

  for (let r = 0; r < na.rows.length; r++) {
    const rowA = na.rows[r]!;
    const rowB = nb.rows[r]!;
    const width = Math.max(rowA.length, rowB.length);
    if (rowA.length !== rowB.length) {
      return { equal: false, reason: `value width mismatch at row ${r}` };
    }
    for (let c = 0; c < width; c++) {
      const colName = na.columns[c] ?? nb.columns[c] ?? `column ${c}`;
      const isRowid = colName.toLowerCase().includes("rowid") || colName.toLowerCase() === "oid";
      if (!normalizedValuesEqual(rowA[c]!, rowB[c]!, isRowid, realEpsilon)) {
        return {
          equal: false,
          reason: `value mismatch at row ${r}, column ${colName}`,
        };
      }
    }
  }

  if (!options?.ignoreWriteCounters) {
    if (na.changes !== nb.changes) {
      return { equal: false, reason: `changes mismatch: ${na.changes} vs ${nb.changes}` };
    }

    if (
      !normalizedValuesEqual(
        { kind: "integer", value: na.lastInsertRowid },
        { kind: "integer", value: nb.lastInsertRowid },
        true,
      )
    ) {
      return {
        equal: false,
        reason: `lastInsertRowid mismatch: ${String(na.lastInsertRowid)} vs ${String(nb.lastInsertRowid)}`,
      };
    }

    if (na.totalChanges !== undefined && nb.totalChanges !== undefined && na.totalChanges !== nb.totalChanges) {
      return { equal: false, reason: `totalChanges mismatch: ${na.totalChanges} vs ${nb.totalChanges}` };
    }
  }

  if (
    !options?.ignoreSession &&
    na.inTransaction !== undefined &&
    nb.inTransaction !== undefined &&
    na.inTransaction !== nb.inTransaction
  ) {
    return { equal: false, reason: `inTransaction mismatch: ${na.inTransaction} vs ${nb.inTransaction}` };
  }

  return { equal: true };
}

function generalizeConstraintCode(code: string): string {
  if (code.startsWith("SQLITE_CONSTRAINT")) return "SQLITE_CONSTRAINT";
  return code;
}
