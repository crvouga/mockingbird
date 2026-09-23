import type { ChoiceSource } from "./choice.ts";
import type {
  ActionBuilder,
  ActionKind,
  ColumnModel,
  SqliteColType,
  TableModel,
  WalkModel,
  WalkStep,
} from "./model.ts";
import {
  pickInt,
  pickIntOrNull,
  pickRealOrNull,
  pickText,
  pickTextOrNull,
  quoteIdent,
  renderLiteral,
  type WalkSqlValue,
} from "./values.ts";

function pickTable(model: WalkModel, c: ChoiceSource): TableModel {
  return c.fromPool([...model.tables.values()]);
}

function pickTableWithRows(model: WalkModel, c: ChoiceSource): TableModel {
  return c.fromPool(model.tablesWithRows());
}

function pickId(table: TableModel, c: ChoiceSource): number {
  return c.fromPool(table.liveIds);
}

function nonPkColumns(table: TableModel): ColumnModel[] {
  return table.columns.filter((col) => !col.primaryKey);
}

function dataColumns(table: TableModel): ColumnModel[] {
  return nonPkColumns(table);
}

function valueForColumn(col: ColumnModel, c: ChoiceSource, allowNull: boolean): WalkSqlValue {
  if (col.notNull || !allowNull) {
    if (col.type === "INTEGER") {
      let v = pickInt(c);
      if (col.checkPositive && v <= 0) v = Math.abs(v) || 1;
      return v;
    }
    if (col.type === "REAL") return pickRealOrNull(c) ?? 0.5;
    if (col.type === "BLOB") return new Uint8Array([1, 2, 3]);
    return pickText(c);
  }
  if (col.type === "INTEGER") {
    const v = pickIntOrNull(c);
    if (v !== null && col.checkPositive && v <= 0) return Math.abs(v) || 1;
    return v;
  }
  if (col.type === "REAL") return pickRealOrNull(c);
  if (col.type === "BLOB") return c.chance(15) ? null : new Uint8Array([0]);
  return pickTextOrNull(c);
}

function insertValuesSql(table: TableModel, id: number, c: ChoiceSource): { cols: string; vals: string } {
  const cols = ["id", ...dataColumns(table).map((col) => col.name)];
  const vals: string[] = [String(id)];
  for (const col of dataColumns(table)) {
    vals.push(renderLiteral(valueForColumn(col, c, true)));
  }
  return { cols: cols.map(quoteIdent).join(", "), vals: vals.join(", ") };
}

function orderByPk(table: TableModel): string {
  return quoteIdent(table.columns.find((col) => col.primaryKey)?.name ?? "id");
}

function selectCols(table: TableModel): string {
  return table.columns.map((col) => quoteIdent(col.name)).join(", ");
}

export function bootstrapDdl(): string {
  return "CREATE TABLE t0(id INTEGER PRIMARY KEY, a INT, b TEXT)";
}

const COL_TYPES: SqliteColType[] = ["INTEGER", "TEXT", "REAL"];

function buildCreateTable(model: WalkModel, c: ChoiceSource): WalkStep {
  const name = `t${model.nextTableSuffix}`;
  const nCols = c.int(1, 3);
  const columns: ColumnModel[] = [
    { name: "id", type: "INTEGER", notNull: true, primaryKey: true, checkPositive: false },
  ];
  for (let i = 0; i < nCols; i++) {
    const type = c.fromPool(COL_TYPES);
    const notNull = c.chance(25);
    const checkPositive = type === "INTEGER" && c.chance(20);
    columns.push({ name: `c${i}`, type, notNull, primaryKey: false, checkPositive });
  }
  const strict = c.chance(20);
  const withoutRowid = !strict && c.chance(15);
  const parts: string[] = ["id INTEGER PRIMARY KEY"];
  for (const col of columns.slice(1)) {
    let def = `${quoteIdent(col.name)} ${col.type}`;
    if (col.notNull) def += " NOT NULL";
    if (col.checkPositive) def += ` CHECK (${quoteIdent(col.name)} > 0)`;
    if (col.notNull && col.type === "TEXT") def += " DEFAULT ''";
    if (col.notNull && col.type === "INTEGER") def += " DEFAULT 1";
    if (col.notNull && col.type === "REAL") def += " DEFAULT 0.5";
    parts.push(def);
  }
  let sql = `CREATE TABLE ${quoteIdent(name)}(${parts.join(", ")})`;
  if (strict) sql += " STRICT";
  if (withoutRowid) sql += " WITHOUT ROWID";
  return {
    kind: "create_table",
    sql,
    mode: "outcome",
    apply: (m) => {
      m.nextTableSuffix++;
      m.tables.set(name, { name, columns, strict, withoutRowid, liveIds: [], nextId: 1 });
    },
  };
}

function buildDropTable(model: WalkModel, c: ChoiceSource): WalkStep {
  const droppable = model.tableNames().filter(() => model.tables.size > 1);
  const name = c.fromPool(droppable);
  return {
    kind: "drop_table",
    sql: `DROP TABLE ${quoteIdent(name)}`,
    mode: "outcome",
    apply: (m) => {
      m.tables.delete(name);
      for (const [idx, meta] of [...m.indexes]) if (meta.table === name) m.indexes.delete(idx);
      for (const [vn, meta] of [...m.views]) if (meta.table === name) m.views.delete(vn);
      for (const [tn, meta] of [...m.triggers]) if (meta.table === name) m.triggers.delete(tn);
    },
  };
}

function buildAddColumn(model: WalkModel, c: ChoiceSource): WalkStep {
  const tables = [...model.tables.values()].filter((t) => !t.withoutRowid);
  const table = c.fromPool(tables.length > 0 ? tables : [...model.tables.values()]);
  const colName = `note${c.int(0, 9)}`;
  const finalName = table.columns.some((col) => col.name === colName) ? `extra${model.nextIndexSuffix}` : colName;
  const type = c.fromPool(COL_TYPES);
  const def = type === "TEXT" ? "''" : type === "INTEGER" ? "0" : "0.5";
  return {
    kind: "add_column",
    sql: `ALTER TABLE ${quoteIdent(table.name)} ADD COLUMN ${quoteIdent(finalName)} ${type} DEFAULT ${def}`,
    mode: "outcome",
    apply: (m) => {
      const t = m.tables.get(table.name);
      if (!t) return;
      t.columns.push({ name: finalName, type, notNull: false, primaryKey: false, checkPositive: false });
    },
  };
}

function buildDropColumn(model: WalkModel, c: ChoiceSource): WalkStep {
  const candidates = [...model.tables.values()].filter((t) => nonPkColumns(t).length > 1);
  const table = c.fromPool(candidates);
  const col = c.fromPool(nonPkColumns(table));
  return {
    kind: "drop_column",
    sql: `ALTER TABLE ${quoteIdent(table.name)} DROP COLUMN ${quoteIdent(col.name)}`,
    mode: "outcome",
    apply: (m) => {
      const t = m.tables.get(table.name);
      if (!t) return;
      t.columns = t.columns.filter((x) => x.name !== col.name);
    },
  };
}

function buildRenameColumn(model: WalkModel, c: ChoiceSource): WalkStep {
  const table = pickTable(model, c);
  const candidates = nonPkColumns(table).length > 0 ? nonPkColumns(table) : table.columns;
  const col = c.fromPool(candidates);
  const newName = `${col.name}_r${c.int(0, 9)}`;
  return {
    kind: "rename_column",
    sql: `ALTER TABLE ${quoteIdent(table.name)} RENAME COLUMN ${quoteIdent(col.name)} TO ${quoteIdent(newName)}`,
    mode: "outcome",
    apply: (m) => {
      const t = m.tables.get(table.name);
      const target = t?.columns.find((x) => x.name === col.name);
      if (target) target.name = newName;
    },
  };
}

function buildCreateIndex(model: WalkModel, c: ChoiceSource): WalkStep {
  const table = pickTable(model, c);
  const cols = dataColumns(table);
  const col = cols.length > 0 ? c.fromPool(cols) : table.columns[0]!;
  const name = `idx_${table.name}_${model.nextIndexSuffix}`;
  const unique = c.chance(25);
  const partial = c.chance(25) && col.type === "INTEGER";
  const expr = !partial && c.chance(20) && col.type === "INTEGER";
  let sql: string;
  if (expr) {
    sql = `CREATE ${unique ? "UNIQUE " : ""}INDEX ${quoteIdent(name)} ON ${quoteIdent(table.name)}(${quoteIdent(col.name)} + 1)`;
  } else if (partial) {
    sql = `CREATE ${unique ? "UNIQUE " : ""}INDEX ${quoteIdent(name)} ON ${quoteIdent(table.name)}(${quoteIdent(col.name)}) WHERE ${quoteIdent(col.name)} > 0`;
  } else {
    sql = `CREATE ${unique ? "UNIQUE " : ""}INDEX ${quoteIdent(name)} ON ${quoteIdent(table.name)}(${quoteIdent(col.name)})`;
  }
  return {
    kind: "create_index",
    sql,
    mode: "outcome",
    apply: (m) => {
      m.nextIndexSuffix++;
      m.indexes.set(name, { name, table: table.name, unique, partial, expr });
    },
  };
}

function buildDropIndex(model: WalkModel, c: ChoiceSource): WalkStep {
  const idx = c.fromPool([...model.indexes.values()]);
  return {
    kind: "drop_index",
    sql: `DROP INDEX ${quoteIdent(idx.name)}`,
    mode: "outcome",
    apply: (m) => {
      m.indexes.delete(idx.name);
    },
  };
}

function buildCreateView(model: WalkModel, c: ChoiceSource): WalkStep {
  const table = pickTable(model, c);
  const name = `v_${table.name}_${model.nextViewSuffix}`;
  return {
    kind: "create_view",
    sql: `CREATE VIEW ${quoteIdent(name)} AS SELECT ${selectCols(table)} FROM ${quoteIdent(table.name)}`,
    mode: "outcome",
    apply: (m) => {
      m.nextViewSuffix++;
      m.views.set(name, { name, table: table.name });
    },
  };
}

function buildDropView(model: WalkModel, c: ChoiceSource): WalkStep {
  const view = c.fromPool([...model.views.values()]);
  return {
    kind: "drop_view",
    sql: `DROP VIEW ${quoteIdent(view.name)}`,
    mode: "outcome",
    apply: (m) => {
      m.views.delete(view.name);
    },
  };
}

function buildCreateTrigger(model: WalkModel, c: ChoiceSource): WalkStep {
  const table = pickTable(model, c);
  const name = `trg_${table.name}_${model.nextTriggerSuffix}`;
  return {
    kind: "create_trigger",
    sql: `CREATE TRIGGER ${quoteIdent(name)} AFTER INSERT ON ${quoteIdent(table.name)} BEGIN SELECT 1; END`,
    mode: "outcome",
    apply: (m) => {
      m.nextTriggerSuffix++;
      m.triggers.set(name, { name, table: table.name });
    },
  };
}

function buildDropTrigger(model: WalkModel, c: ChoiceSource): WalkStep {
  const trg = c.fromPool([...model.triggers.values()]);
  return {
    kind: "drop_trigger",
    sql: `DROP TRIGGER ${quoteIdent(trg.name)}`,
    mode: "outcome",
    apply: (m) => {
      m.triggers.delete(trg.name);
    },
  };
}

function buildInsert(model: WalkModel, c: ChoiceSource): WalkStep {
  const table = pickTable(model, c);
  const id = table.nextId;
  const { cols, vals } = insertValuesSql(table, id, c);
  return {
    kind: "insert",
    sql: `INSERT INTO ${quoteIdent(table.name)}(${cols}) VALUES (${vals})`,
    mode: "write",
    apply: (m) => {
      const t = m.tables.get(table.name);
      if (!t) return;
      t.liveIds.push(id);
      t.liveIds.sort((a, b) => a - b);
      t.nextId = Math.max(t.nextId, id + 1);
    },
  };
}

function buildInsertMulti(model: WalkModel, c: ChoiceSource): WalkStep {
  const table = pickTable(model, c);
  const n = c.int(2, 3);
  const ids: number[] = [];
  const valueRows: string[] = [];
  let next = table.nextId;
  for (let i = 0; i < n; i++) {
    const id = next++;
    ids.push(id);
    valueRows.push(`(${insertValuesSql(table, id, c).vals})`);
  }
  const cols = ["id", ...dataColumns(table).map((col) => col.name)].map(quoteIdent).join(", ");
  return {
    kind: "insert_multi",
    sql: `INSERT INTO ${quoteIdent(table.name)}(${cols}) VALUES ${valueRows.join(", ")}`,
    mode: "write",
    apply: (m) => {
      const t = m.tables.get(table.name);
      if (!t) return;
      for (const id of ids) t.liveIds.push(id);
      t.liveIds.sort((a, b) => a - b);
      t.nextId = Math.max(t.nextId, next);
    },
  };
}

function buildUpdateById(model: WalkModel, c: ChoiceSource): WalkStep {
  const table = pickTableWithRows(model, c);
  const id = pickId(table, c);
  const cols = dataColumns(table);
  if (cols.length === 0) {
    return {
      kind: "update_by_id",
      sql: `UPDATE ${quoteIdent(table.name)} SET id = id WHERE id = ${id}`,
      mode: "write",
      apply: () => {},
    };
  }
  const col = c.fromPool(cols);
  const val = valueForColumn(col, c, !col.notNull);
  return {
    kind: "update_by_id",
    sql: `UPDATE ${quoteIdent(table.name)} SET ${quoteIdent(col.name)} = ${renderLiteral(val)} WHERE id = ${id}`,
    mode: "write",
    apply: () => {},
  };
}

function buildDeleteById(model: WalkModel, c: ChoiceSource): WalkStep {
  const table = pickTableWithRows(model, c);
  const id = pickId(table, c);
  return {
    kind: "delete_by_id",
    sql: `DELETE FROM ${quoteIdent(table.name)} WHERE id = ${id}`,
    mode: "write",
    apply: (m) => {
      const t = m.tables.get(table.name);
      if (!t) return;
      t.liveIds = t.liveIds.filter((x) => x !== id);
    },
  };
}

function buildUpdatePred(model: WalkModel, c: ChoiceSource): WalkStep {
  const table = pickTableWithRows(model, c);
  const cols = dataColumns(table).filter((col) => col.type === "INTEGER" || col.type === "TEXT");
  const col = cols.length > 0 ? c.fromPool(cols) : table.columns[0]!;
  const bound = col.type === "INTEGER" ? pickInt(c) : pickText(c);
  const setCol = dataColumns(table)[0] ?? table.columns[0]!;
  const setVal = valueForColumn(setCol, c, !setCol.notNull);
  return {
    kind: "update_pred",
    sql:
      `UPDATE ${quoteIdent(table.name)} SET ${quoteIdent(setCol.name)} = ${renderLiteral(setVal)} ` +
      `WHERE ${quoteIdent(col.name)} = ${renderLiteral(bound)}`,
    mode: "write",
    apply: () => {},
  };
}

function buildDeletePred(model: WalkModel, c: ChoiceSource): WalkStep {
  const table = pickTableWithRows(model, c);
  const id = pickId(table, c);
  return {
    kind: "delete_pred",
    sql: `DELETE FROM ${quoteIdent(table.name)} WHERE id = ${id} AND id IS NOT NULL`,
    mode: "write",
    apply: (m) => {
      const t = m.tables.get(table.name);
      if (!t) return;
      t.liveIds = t.liveIds.filter((x) => x !== id);
    },
  };
}

function buildUpsert(model: WalkModel, c: ChoiceSource): WalkStep {
  const table = pickTable(model, c);
  const conflictId = table.liveIds.length > 0 ? c.fromPool(table.liveIds) : table.nextId;
  const mode = c.chance(50) ? "nothing" : "update";
  const { cols, vals } = insertValuesSql(table, conflictId, c);
  const isNew = !table.liveIds.includes(conflictId);
  const setCols = dataColumns(table);
  const sets =
    setCols.length > 0
      ? setCols.map((col) => `${quoteIdent(col.name)} = excluded.${quoteIdent(col.name)}`).join(", ")
      : "id = excluded.id";
  const sql =
    mode === "nothing"
      ? `INSERT INTO ${quoteIdent(table.name)}(${cols}) VALUES (${vals}) ON CONFLICT(id) DO NOTHING`
      : `INSERT INTO ${quoteIdent(table.name)}(${cols}) VALUES (${vals}) ON CONFLICT(id) DO UPDATE SET ${sets}`;
  return {
    kind: "upsert",
    sql,
    // Outcome-only: DO NOTHING may diverge on totalChanges vs bun:sqlite (same as dst/ops).
    mode: "outcome",
    apply: (m) => {
      const t = m.tables.get(table.name);
      if (!t) return;
      if (isNew) {
        t.liveIds.push(conflictId);
        t.liveIds.sort((a, b) => a - b);
        t.nextId = Math.max(t.nextId, conflictId + 1);
      }
    },
  };
}

function buildInsertSelect(model: WalkModel, c: ChoiceSource): WalkStep {
  const table = pickTable(model, c);
  const id = table.nextId;
  const cols = ["id", ...dataColumns(table).map((col) => col.name)].map(quoteIdent).join(", ");
  const srcCols = [String(id), ...dataColumns(table).map((col) => quoteIdent(col.name))].join(", ");
  return {
    kind: "insert_select",
    sql:
      `INSERT INTO ${quoteIdent(table.name)}(${cols}) ` +
      `SELECT ${srcCols} FROM ${quoteIdent(table.name)} WHERE id = (SELECT max(id) FROM ${quoteIdent(table.name)})`,
    mode: "write",
    apply: (m) => {
      const t = m.tables.get(table.name);
      if (!t || t.liveIds.length === 0) return;
      t.liveIds.push(id);
      t.liveIds.sort((a, b) => a - b);
      t.nextId = Math.max(t.nextId, id + 1);
    },
  };
}

function buildReturningInsert(model: WalkModel, c: ChoiceSource): WalkStep {
  const table = pickTable(model, c);
  const id = table.nextId;
  const { cols, vals } = insertValuesSql(table, id, c);
  return {
    kind: "returning_insert",
    sql: `INSERT INTO ${quoteIdent(table.name)}(${cols}) VALUES (${vals}) RETURNING ${selectCols(table)}`,
    mode: "rows",
    apply: (m) => {
      const t = m.tables.get(table.name);
      if (!t) return;
      t.liveIds.push(id);
      t.liveIds.sort((a, b) => a - b);
      t.nextId = Math.max(t.nextId, id + 1);
    },
  };
}

function buildReturningUpdate(model: WalkModel, c: ChoiceSource): WalkStep {
  const table = pickTableWithRows(model, c);
  const id = pickId(table, c);
  const cols = dataColumns(table);
  const col = cols.length > 0 ? c.fromPool(cols) : table.columns[0]!;
  const val = valueForColumn(col, c, !col.notNull);
  return {
    kind: "returning_update",
    sql:
      `UPDATE ${quoteIdent(table.name)} SET ${quoteIdent(col.name)} = ${renderLiteral(val)} ` +
      `WHERE id = ${id} RETURNING ${selectCols(table)}`,
    mode: "rows",
    apply: () => {},
  };
}

function buildReturningDelete(model: WalkModel, c: ChoiceSource): WalkStep {
  const table = pickTableWithRows(model, c);
  const id = pickId(table, c);
  return {
    kind: "returning_delete",
    sql: `DELETE FROM ${quoteIdent(table.name)} WHERE id = ${id} RETURNING ${selectCols(table)}`,
    mode: "rows",
    apply: (m) => {
      const t = m.tables.get(table.name);
      if (!t) return;
      t.liveIds = t.liveIds.filter((x) => x !== id);
    },
  };
}

function buildSelectScan(model: WalkModel, c: ChoiceSource): WalkStep {
  const table = pickTable(model, c);
  return {
    kind: "select_scan",
    sql: `SELECT ${selectCols(table)} FROM ${quoteIdent(table.name)} ORDER BY ${orderByPk(table)}`,
    mode: "rows",
    apply: () => {},
  };
}

function buildSelectWhere(model: WalkModel, c: ChoiceSource): WalkStep {
  const table = pickTable(model, c);
  const cols = dataColumns(table);
  const col = cols.length > 0 ? c.fromPool(cols) : table.columns[0]!;
  const lit = valueForColumn(col, c, true);
  const pred =
    lit === null
      ? `${quoteIdent(col.name)} IS NULL`
      : `${quoteIdent(col.name)} IS NOT NULL AND ${quoteIdent(col.name)} = ${renderLiteral(lit)}`;
  return {
    kind: "select_where",
    sql: `SELECT ${selectCols(table)} FROM ${quoteIdent(table.name)} WHERE ${pred} ORDER BY ${orderByPk(table)}`,
    mode: "rows",
    apply: () => {},
  };
}

function buildSelectAgg(model: WalkModel, c: ChoiceSource): WalkStep {
  const table = pickTable(model, c);
  const intCols = dataColumns(table).filter((col) => col.type === "INTEGER");
  const col = intCols.length > 0 ? c.fromPool(intCols) : null;
  const sql = col
    ? `SELECT count(*) AS n, sum(${quoteIdent(col.name)}) AS s, min(${quoteIdent(col.name)}) AS mn, max(${quoteIdent(col.name)}) AS mx FROM ${quoteIdent(table.name)}`
    : `SELECT count(*) AS n FROM ${quoteIdent(table.name)}`;
  return { kind: "select_agg", sql, mode: "rows", apply: () => {} };
}

function buildSelectJoin(model: WalkModel, c: ChoiceSource): WalkStep {
  const names = model.tableNames();
  const a = c.fromPool(names);
  const bCandidates = names.filter((n) => n !== a);
  const b = c.fromPool(bCandidates.length > 0 ? bCandidates : names);
  return {
    kind: "select_join",
    sql:
      `SELECT ${quoteIdent(a)}.id AS a_id, ${quoteIdent(b)}.id AS b_id ` +
      `FROM ${quoteIdent(a)} INNER JOIN ${quoteIdent(b)} ON ${quoteIdent(a)}.id = ${quoteIdent(b)}.id ` +
      `ORDER BY a_id, b_id`,
    mode: "rows",
    apply: () => {},
  };
}

function buildSelectCompound(model: WalkModel, c: ChoiceSource): WalkStep {
  const table = pickTable(model, c);
  const op = c.fromPool(["UNION", "UNION ALL", "INTERSECT", "EXCEPT"] as const);
  return {
    kind: "select_compound",
    sql:
      `SELECT id FROM ${quoteIdent(table.name)} ${op} ` +
      `SELECT id FROM ${quoteIdent(table.name)} WHERE id IS NOT NULL ORDER BY 1`,
    mode: "rows",
    apply: () => {},
  };
}

function buildSelectExists(model: WalkModel, c: ChoiceSource): WalkStep {
  const table = pickTable(model, c);
  return {
    kind: "select_exists",
    sql:
      `SELECT ${selectCols(table)} FROM ${quoteIdent(table.name)} t ` +
      `WHERE EXISTS (SELECT 1 FROM ${quoteIdent(table.name)} t2 WHERE t2.id = t.id) ` +
      `ORDER BY ${orderByPk(table)}`,
    mode: "rows",
    apply: () => {},
  };
}

function buildSelectWindow(model: WalkModel, c: ChoiceSource): WalkStep {
  const table = pickTable(model, c);
  return {
    kind: "select_window",
    sql: `SELECT id, row_number() OVER (ORDER BY id) AS rn FROM ${quoteIdent(table.name)} ORDER BY id`,
    mode: "rows",
    apply: () => {},
  };
}

function buildSelectTypeof(model: WalkModel, c: ChoiceSource): WalkStep {
  const table = pickTable(model, c);
  const cols = table.columns.map((col) => `typeof(${quoteIdent(col.name)}) AS t_${col.name}`);
  return {
    kind: "select_typeof",
    sql: `SELECT id, ${cols.join(", ")} FROM ${quoteIdent(table.name)} ORDER BY id`,
    mode: "rows",
    apply: () => {},
  };
}

function buildBegin(_model: WalkModel, _c: ChoiceSource): WalkStep {
  return {
    kind: "begin",
    sql: "BEGIN",
    mode: "outcome",
    apply: (m) => {
      m.inTxn = true;
      m.txnIds = m.snapshotIds();
    },
  };
}

function buildCommit(_model: WalkModel, _c: ChoiceSource): WalkStep {
  return {
    kind: "commit",
    sql: "COMMIT",
    mode: "outcome",
    apply: (m) => {
      m.inTxn = false;
      m.txnIds = null;
      m.savepoints = [];
    },
  };
}

function buildRollback(_model: WalkModel, _c: ChoiceSource): WalkStep {
  return {
    kind: "rollback",
    sql: "ROLLBACK",
    mode: "outcome",
    apply: (m) => {
      if (m.txnIds) m.restoreIds(m.txnIds);
      m.inTxn = false;
      m.txnIds = null;
      m.savepoints = [];
    },
  };
}

function buildSavepoint(model: WalkModel, _c: ChoiceSource): WalkStep {
  const name = `sp${model.nextSavepoint}`;
  const beginFirst = !model.inTxn;
  return {
    kind: "savepoint",
    sql: `SAVEPOINT ${name}`,
    mode: "outcome",
    beginFirst,
    apply: (m) => {
      if (!m.inTxn) {
        m.inTxn = true;
        m.txnIds = m.snapshotIds();
      }
      m.nextSavepoint++;
      m.savepoints.push({ name, tableIds: m.snapshotIds() });
    },
  };
}

function buildRelease(model: WalkModel, _c: ChoiceSource): WalkStep {
  const frame = model.savepoints[model.savepoints.length - 1]!;
  return {
    kind: "release",
    sql: `RELEASE ${frame.name}`,
    mode: "outcome",
    apply: (m) => {
      m.savepoints.pop();
    },
  };
}

function buildRollbackTo(model: WalkModel, _c: ChoiceSource): WalkStep {
  const frame = model.savepoints[model.savepoints.length - 1]!;
  return {
    kind: "rollback_to",
    sql: `ROLLBACK TO ${frame.name}`,
    mode: "outcome",
    apply: (m) => {
      const sp = m.savepoints[m.savepoints.length - 1];
      if (!sp) return;
      m.restoreIds(sp.tableIds);
    },
  };
}

function buildNegDupPk(model: WalkModel, c: ChoiceSource): WalkStep {
  const tables = model.tablesWithRows();
  const table = tables.length > 0 ? c.fromPool(tables) : pickTable(model, c);
  if (table.liveIds.length === 0) {
    return {
      kind: "neg_dup_pk",
      sql: `INSERT INTO ${quoteIdent(table.name)}(id) VALUES (1), (1)`,
      mode: "error",
      expect: "constraint_primary",
      apply: () => {},
    };
  }
  const id = c.fromPool(table.liveIds);
  const { cols, vals } = insertValuesSql(table, id, c);
  return {
    kind: "neg_dup_pk",
    sql: `INSERT INTO ${quoteIdent(table.name)}(${cols}) VALUES (${vals})`,
    mode: "error",
    expect: "constraint_primary",
    apply: () => {},
  };
}

function buildNegNotNull(model: WalkModel, c: ChoiceSource): WalkStep {
  const candidates = [...model.tables.values()].filter((t) => t.columns.some((col) => col.notNull && !col.primaryKey));
  const table = c.fromPool(candidates);
  const nn = table.columns.find((col) => col.notNull && !col.primaryKey)!;
  const id = table.nextId;
  return {
    kind: "neg_notnull",
    sql: `INSERT INTO ${quoteIdent(table.name)}(${quoteIdent("id")}, ${quoteIdent(nn.name)}) VALUES (${id}, NULL)`,
    mode: "error",
    expect: "constraint_notnull",
    apply: () => {},
  };
}

function buildNegCheck(model: WalkModel, c: ChoiceSource): WalkStep {
  const candidates = [...model.tables.values()].filter((t) => t.columns.some((col) => col.checkPositive));
  const table = c.fromPool(candidates);
  const col = table.columns.find((x) => x.checkPositive)!;
  const id = table.nextId;
  return {
    kind: "neg_check",
    sql: `INSERT INTO ${quoteIdent(table.name)}(${quoteIdent("id")}, ${quoteIdent(col.name)}) VALUES (${id}, -1)`,
    mode: "error",
    expect: "constraint_check",
    apply: () => {},
  };
}

function buildNegUnknownTable(_model: WalkModel, _c: ChoiceSource): WalkStep {
  return {
    kind: "neg_unknown_table",
    sql: "SELECT * FROM __no_such_walk_table__",
    mode: "error",
    expect: "no_such_table",
    apply: () => {},
  };
}

function buildNegUnknownColumn(model: WalkModel, c: ChoiceSource): WalkStep {
  const table = pickTable(model, c);
  return {
    kind: "neg_unknown_column",
    sql: `SELECT __no_such_col__ FROM ${quoteIdent(table.name)}`,
    mode: "error",
    expect: "no_such_column",
    apply: () => {},
  };
}

function buildNegSyntax(_model: WalkModel, _c: ChoiceSource): WalkStep {
  return {
    kind: "neg_syntax",
    sql: "SELLECT 1",
    mode: "error",
    expect: "syntax",
    apply: () => {},
  };
}

function buildNegStrictType(model: WalkModel, c: ChoiceSource): WalkStep {
  const candidates = [...model.tables.values()].filter((t) => t.strict);
  const table = c.fromPool(candidates);
  const intCol = table.columns.find((col) => col.type === "INTEGER" && !col.primaryKey);
  const id = table.nextId;
  if (!intCol) {
    return {
      kind: "neg_strict_type",
      sql: `INSERT INTO ${quoteIdent(table.name)}(id) VALUES ('not-an-int')`,
      mode: "error",
      expect: "datatype_mismatch",
      apply: () => {},
    };
  }
  return {
    kind: "neg_strict_type",
    sql: `INSERT INTO ${quoteIdent(table.name)}(${quoteIdent("id")}, ${quoteIdent(intCol.name)}) VALUES (${id}, 'not-an-int')`,
    mode: "error",
    expect: "datatype_mismatch",
    apply: () => {},
  };
}

function buildCheckpoint(_model: WalkModel, _c: ChoiceSource): WalkStep {
  return {
    kind: "checkpoint",
    sql: "<checkpoint>",
    mode: "outcome",
    checkpoint: true,
    apply: () => {},
  };
}

const BUILDERS: Record<ActionKind, ActionBuilder> = {
  select_scan: buildSelectScan,
  select_where: buildSelectWhere,
  select_agg: buildSelectAgg,
  select_join: buildSelectJoin,
  select_compound: buildSelectCompound,
  select_exists: buildSelectExists,
  select_window: buildSelectWindow,
  select_typeof: buildSelectTypeof,
  insert: buildInsert,
  insert_multi: buildInsertMulti,
  update_by_id: buildUpdateById,
  delete_by_id: buildDeleteById,
  update_pred: buildUpdatePred,
  delete_pred: buildDeletePred,
  upsert: buildUpsert,
  insert_select: buildInsertSelect,
  returning_insert: buildReturningInsert,
  returning_update: buildReturningUpdate,
  returning_delete: buildReturningDelete,
  create_table: buildCreateTable,
  drop_table: buildDropTable,
  add_column: buildAddColumn,
  drop_column: buildDropColumn,
  rename_column: buildRenameColumn,
  create_index: buildCreateIndex,
  drop_index: buildDropIndex,
  create_view: buildCreateView,
  drop_view: buildDropView,
  create_trigger: buildCreateTrigger,
  drop_trigger: buildDropTrigger,
  begin: buildBegin,
  commit: buildCommit,
  rollback: buildRollback,
  savepoint: buildSavepoint,
  release: buildRelease,
  rollback_to: buildRollbackTo,
  neg_dup_pk: buildNegDupPk,
  neg_notnull: buildNegNotNull,
  neg_check: buildNegCheck,
  neg_unknown_table: buildNegUnknownTable,
  neg_unknown_column: buildNegUnknownColumn,
  neg_syntax: buildNegSyntax,
  neg_strict_type: buildNegStrictType,
  checkpoint: buildCheckpoint,
};

export function buildStep(kind: ActionKind, model: WalkModel, choose: ChoiceSource): WalkStep {
  return BUILDERS[kind](model, choose);
}
