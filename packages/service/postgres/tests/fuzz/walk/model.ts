import type { ErrorCategory } from "../../harness/types.ts";
import type { ChoiceSource } from "./choice.ts";

export type PgColType = "int" | "text" | "float8" | "numeric" | "jsonb" | "int[]";

export interface ColumnModel {
  name: string;
  type: PgColType;
  notNull: boolean;
  primaryKey: boolean;
  checkPositive: boolean;
}

export interface TableModel {
  name: string;
  columns: ColumnModel[];
  liveIds: number[];
  nextId: number;
}

export interface IndexModel {
  name: string;
  table: string;
  unique: boolean;
  partial: boolean;
}

export interface ViewModel {
  name: string;
  table: string;
}

export interface MatViewModel {
  name: string;
  table: string;
}

export interface SavepointFrame {
  name: string;
  tableIds: Map<string, number[]>;
}

export type StepMode = "rows" | "write" | "outcome" | "error";

export interface WalkStep {
  kind: ActionKind;
  sql: string;
  mode: StepMode;
  expect?: ErrorCategory;
  beginFirst?: boolean;
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
  | "insert"
  | "update_by_id"
  | "delete_by_id"
  | "upsert"
  | "returning_insert"
  | "returning_update"
  | "returning_delete"
  | "create_table"
  | "drop_table"
  | "add_column"
  | "drop_column"
  | "create_index"
  | "drop_index"
  | "create_view"
  | "drop_view"
  | "create_matview"
  | "refresh_matview"
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
  | "neg_bad_cast"
  | "neg_div_zero"
  | "checkpoint";

export interface WeightedAction {
  weight: number;
  value: ActionKind;
}

export class WalkModel {
  tables = new Map<string, TableModel>();
  indexes = new Map<string, IndexModel>();
  views = new Map<string, ViewModel>();
  matviews = new Map<string, MatViewModel>();
  inTxn = false;
  txnIds: Map<string, number[]> | null = null;
  savepoints: SavepointFrame[] = [];
  nextSavepoint = 1;
  nextTableSuffix = 1;
  nextIndexSuffix = 1;
  nextViewSuffix = 1;
  nextMatViewSuffix = 1;
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
    for (const [name, t] of this.tables) m.set(name, [...t.liveIds]);
    return m;
  }

  restoreIds(snap: Map<string, number[]>): void {
    for (const [name, t] of this.tables) {
      t.liveIds = [...(snap.get(name) ?? [])];
    }
  }
}

export function initialWalkModel(): WalkModel {
  const model = new WalkModel();
  model.tables.set("t0", {
    name: "t0",
    columns: [
      { name: "id", type: "int", notNull: true, primaryKey: true, checkPositive: false },
      { name: "a", type: "int", notNull: false, primaryKey: false, checkPositive: false },
      { name: "b", type: "text", notNull: false, primaryKey: false, checkPositive: false },
    ],
    liveIds: [],
    nextId: 1,
  });
  model.sqlLog.push("CREATE TABLE t0 (id int PRIMARY KEY, a int, b text)");
  return model;
}

/**
 * State-dependent enabled actions. Negatives and DDL only outside transactions
 * (postgres-mem has no aborted-txn state; DDL-in-txn kept simple).
 */
export function enabledActions(model: WalkModel): WeightedAction[] {
  const out: WeightedAction[] = [];
  const tables = model.tableNames();
  const withRows = model.tablesWithRows();
  const hasTable = tables.length > 0;
  const hasRows = withRows.length > 0;
  const multiTable = tables.length >= 2;

  if (hasTable) {
    out.push({ weight: 6, value: "select_scan" });
    out.push({ weight: 3, value: "select_where" });
    out.push({ weight: 2, value: "select_agg" });
    out.push({ weight: 2, value: "select_exists" });
    out.push({ weight: 1, value: "select_window" });
    out.push({ weight: 1, value: "select_compound" });
  }
  if (multiTable) out.push({ weight: 2, value: "select_join" });

  if (hasTable) {
    out.push({ weight: 5, value: "insert" });
    out.push({ weight: 2, value: "upsert" });
    out.push({ weight: 1, value: "returning_insert" });
  }
  if (hasRows) {
    out.push({ weight: 3, value: "update_by_id" });
    out.push({ weight: 2, value: "delete_by_id" });
    out.push({ weight: 1, value: "returning_update" });
    out.push({ weight: 1, value: "returning_delete" });
  }

  if (!model.inTxn) {
    out.push({ weight: 2, value: "create_table" });
    if (tables.length > 1) out.push({ weight: 1, value: "drop_table" });
    if (hasTable) {
      out.push({ weight: 1, value: "add_column" });
      out.push({ weight: 1, value: "create_index" });
      out.push({ weight: 1, value: "create_view" });
      out.push({ weight: 1, value: "create_matview" });
    }
    const droppableCols = [...model.tables.values()].some((t) => t.columns.filter((c) => !c.primaryKey).length > 1);
    if (droppableCols) out.push({ weight: 1, value: "drop_column" });
    if (model.indexes.size > 0) out.push({ weight: 1, value: "drop_index" });
    if (model.views.size > 0) out.push({ weight: 1, value: "drop_view" });
    if (model.matviews.size > 0) {
      out.push({ weight: 1, value: "refresh_matview" });
    }

    // Negatives only outside txn (no 25P02 aborted state in postgres-mem).
    if (hasTable) {
      out.push({ weight: 1, value: "neg_dup_pk" });
      out.push({ weight: 1, value: "neg_unknown_table" });
      out.push({ weight: 1, value: "neg_unknown_column" });
      out.push({ weight: 1, value: "neg_syntax" });
      out.push({ weight: 1, value: "neg_bad_cast" });
      out.push({ weight: 1, value: "neg_div_zero" });
      const nn = [...model.tables.values()].find((t) => t.columns.some((c) => c.notNull && !c.primaryKey));
      if (nn) out.push({ weight: 1, value: "neg_notnull" });
      const chk = [...model.tables.values()].find((t) => t.columns.some((c) => c.checkPositive));
      if (chk) out.push({ weight: 1, value: "neg_check" });
    }

    out.push({ weight: 1, value: "checkpoint" });
  }

  if (!model.inTxn) {
    out.push({ weight: 2, value: "begin" });
    out.push({ weight: 1, value: "savepoint" });
  } else {
    out.push({ weight: 2, value: "commit" });
    out.push({ weight: 2, value: "rollback" });
    out.push({ weight: 2, value: "savepoint" });
    if (model.savepoints.length > 0) {
      out.push({ weight: 1, value: "release" });
      // Each savepoint rolled back at most once (known divergence on second ROLLBACK TO).
      out.push({ weight: 1, value: "rollback_to" });
    }
  }

  return out;
}

export type ActionBuilder = (model: WalkModel, choose: ChoiceSource) => WalkStep;
