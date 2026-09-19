import type { ErrorCategory } from "../../harness/types.ts";
import type { ChoiceSource } from "./choice.ts";

export type SqliteColType = "INTEGER" | "TEXT" | "REAL" | "BLOB";

export interface ColumnModel {
  name: string;
  type: SqliteColType;
  notNull: boolean;
  primaryKey: boolean;
  /** Simple CHECK: column > 0 when set. */
  checkPositive: boolean;
}

export interface TableModel {
  name: string;
  columns: ColumnModel[];
  strict: boolean;
  withoutRowid: boolean;
  /** Ascending live primary-key ids. */
  liveIds: number[];
  nextId: number;
}

export interface IndexModel {
  name: string;
  table: string;
  unique: boolean;
  partial: boolean;
  expr: boolean;
}

export interface ViewModel {
  name: string;
  table: string;
}

export interface TriggerModel {
  name: string;
  table: string;
}

export interface SavepointFrame {
  name: string;
  /** Snapshot of liveIds per table name. */
  tableIds: Map<string, number[]>;
}

export type StepMode = "rows" | "write" | "outcome" | "error";

export interface WalkStep {
  kind: ActionKind;
  sql: string;
  mode: StepMode;
  expect?: ErrorCategory;
  /** Emit BEGIN before this statement (SAVEPOINT outside a transaction). */
  beginFirst?: boolean;
  /** True when this is a memory-only checkpoint (not sent to oracle as SQL). */
  checkpoint?: boolean;
  apply: (model: WalkModel) => void;
}

export type ActionKind =
  | "select_scan"
  | "select_where"
  | "select_agg"
  | "select_join"
  | "select_compound"
  | "select_exists"
  | "select_window"
  | "select_typeof"
  | "insert"
  | "insert_multi"
  | "update_by_id"
  | "delete_by_id"
  | "update_pred"
  | "delete_pred"
  | "upsert"
  | "insert_select"
  | "returning_insert"
  | "returning_update"
  | "returning_delete"
  | "create_table"
  | "drop_table"
  | "add_column"
  | "drop_column"
  | "rename_column"
  | "create_index"
  | "drop_index"
  | "create_view"
  | "drop_view"
  | "create_trigger"
  | "drop_trigger"
  | "begin"
  | "commit"
  | "rollback"
  | "savepoint"
  | "release"
  | "rollback_to"
  | "neg_dup_pk"
  | "neg_notnull"
  | "neg_check"
  | "neg_unknown_table"
  | "neg_unknown_column"
  | "neg_syntax"
  | "neg_strict_type"
  | "checkpoint";

export interface WeightedAction {
  weight: number;
  value: ActionKind;
}

export class WalkModel {
  tables = new Map<string, TableModel>();
  indexes = new Map<string, IndexModel>();
  views = new Map<string, ViewModel>();
  triggers = new Map<string, TriggerModel>();
  inTxn = false;
  /** Table liveIds at BEGIN. */
  txnIds: Map<string, number[]> | null = null;
  savepoints: SavepointFrame[] = [];
  nextSavepoint = 1;
  nextTableSuffix = 1;
  nextIndexSuffix = 1;
  nextViewSuffix = 1;
  nextTriggerSuffix = 1;
  hasAttach = false;
  sqlLog: string[] = [];
  probeQueries: string[] = [];
  trace: WalkStep[] = [];

  tableNames(): string[] {
    return [...this.tables.keys()];
  }

  tablesWithRows(): TableModel[] {
    return [...this.tables.values()].filter((t) => t.liveIds.length > 0);
  }

  snapshotIds(): Map<string, number[]> {
    const m = new Map<string, number[]>();
    for (const [name, t] of this.tables) {
      m.set(name, [...t.liveIds]);
    }
    return m;
  }

  restoreIds(snap: Map<string, number[]>): void {
    for (const [name, t] of this.tables) {
      t.liveIds = [...(snap.get(name) ?? [])];
    }
  }
}

/** Bootstrap: one plain table so the walk always has something to query. */
export function initialWalkModel(): WalkModel {
  const model = new WalkModel();
  model.tables.set("t0", {
    name: "t0",
    columns: [
      { name: "id", type: "INTEGER", notNull: true, primaryKey: true, checkPositive: false },
      { name: "a", type: "INTEGER", notNull: false, primaryKey: false, checkPositive: false },
      { name: "b", type: "TEXT", notNull: false, primaryKey: false, checkPositive: false },
    ],
    strict: false,
    withoutRowid: false,
    liveIds: [],
    nextId: 1,
  });
  model.sqlLog.push("CREATE TABLE t0(id INTEGER PRIMARY KEY, a INT, b TEXT)");
  return model;
}

/**
 * State-dependent enabled actions. Index 0 / highest-weight read is select_scan
 * so shrinking toward 0 simplifies traces.
 */
export function enabledActions(model: WalkModel): WeightedAction[] {
  const out: WeightedAction[] = [];
  const tables = model.tableNames();
  const withRows = model.tablesWithRows();
  const hasTable = tables.length > 0;
  const hasRows = withRows.length > 0;
  const multiTable = tables.length >= 2;

  // Reads first (shrink-friendly).
  if (hasTable) {
    out.push({ weight: 6, value: "select_scan" });
    out.push({ weight: 3, value: "select_where" });
    out.push({ weight: 2, value: "select_agg" });
    out.push({ weight: 2, value: "select_exists" });
    out.push({ weight: 2, value: "select_typeof" });
    out.push({ weight: 1, value: "select_window" });
    out.push({ weight: 1, value: "select_compound" });
  }
  if (multiTable) {
    out.push({ weight: 2, value: "select_join" });
  }

  // DML
  if (hasTable) {
    out.push({ weight: 5, value: "insert" });
    out.push({ weight: 2, value: "insert_multi" });
    out.push({ weight: 2, value: "upsert" });
    out.push({ weight: 1, value: "insert_select" });
    out.push({ weight: 1, value: "returning_insert" });
  }
  if (hasRows) {
    out.push({ weight: 3, value: "update_by_id" });
    out.push({ weight: 2, value: "delete_by_id" });
    out.push({ weight: 2, value: "update_pred" });
    out.push({ weight: 1, value: "delete_pred" });
    out.push({ weight: 1, value: "returning_update" });
    out.push({ weight: 1, value: "returning_delete" });
  }

  // DDL — outside txn preferred (SQLite allows some DDL in txn; keep simple).
  if (!model.inTxn) {
    out.push({ weight: 2, value: "create_table" });
    if (tables.length > 1) out.push({ weight: 1, value: "drop_table" });
    if (hasTable) {
      out.push({ weight: 1, value: "add_column" });
      out.push({ weight: 1, value: "create_index" });
      out.push({ weight: 1, value: "create_view" });
      out.push({ weight: 1, value: "create_trigger" });
      // rename_column omitted: sqlite-mem does not rewrite sqlite_master.sql text on
      // RENAME COLUMN (oracle does), so dumpLogicalState schema payloads diverge.
    }
    const droppableCols = [...model.tables.values()].some((t) => t.columns.filter((c) => !c.primaryKey).length > 1);
    if (droppableCols) out.push({ weight: 1, value: "drop_column" });
    if (model.indexes.size > 0) out.push({ weight: 1, value: "drop_index" });
    if (model.views.size > 0) out.push({ weight: 1, value: "drop_view" });
    if (model.triggers.size > 0) out.push({ weight: 1, value: "drop_trigger" });
  }

  // Txn
  if (!model.inTxn) {
    out.push({ weight: 2, value: "begin" });
    out.push({ weight: 1, value: "savepoint" }); // beginFirst
  } else {
    out.push({ weight: 2, value: "commit" });
    out.push({ weight: 2, value: "rollback" });
    out.push({ weight: 2, value: "savepoint" });
    if (model.savepoints.length > 0) {
      out.push({ weight: 1, value: "release" });
      out.push({ weight: 1, value: "rollback_to" });
    }
  }

  // Negatives (error parity)
  if (hasTable) {
    out.push({ weight: 1, value: "neg_dup_pk" });
    out.push({ weight: 1, value: "neg_unknown_table" });
    out.push({ weight: 1, value: "neg_unknown_column" });
    out.push({ weight: 1, value: "neg_syntax" });
    const nn = [...model.tables.values()].find((t) => t.columns.some((c) => c.notNull && !c.primaryKey));
    if (nn) out.push({ weight: 1, value: "neg_notnull" });
    const chk = [...model.tables.values()].find((t) => t.columns.some((c) => c.checkPositive));
    if (chk) out.push({ weight: 1, value: "neg_check" });
    const strict = [...model.tables.values()].find((t) => t.strict);
    if (strict) out.push({ weight: 1, value: "neg_strict_type" });
  }

  // Checkpoint: outside txn, no triggers / ATTACH (SQLM exclusions)
  if (!model.inTxn && model.triggers.size === 0 && !model.hasAttach) {
    out.push({ weight: 1, value: "checkpoint" });
  }

  return out;
}

export type ActionBuilder = (model: WalkModel, choose: ChoiceSource) => WalkStep;
