import type {
  CreateIndexStmt,
  CreateTableStmt,
  CreateViewStmt,
  CreateVirtualTableStmt,
  Expr,
  IndexedColumn,
  SelectStmt,
} from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import { IndexStore } from "../indexes/index.ts";
import { isStrictTypeName, unknownStrictType } from "../types/strict.ts";
import { affinityFromTypeName } from "../types/value.ts";
import { Fts5VirtualTable } from "../vtable/fts5.ts";
import {
  BytecodeVirtualTable,
  DbStatVirtualTable,
  FtsVocabVirtualTable,
  RTreeVirtualTable,
  TablesUsedVirtualTable,
} from "../vtable/modules.ts";
import type { Rowid } from "./row.ts";
import type { ColumnInfo } from "./table.ts";
import { Table } from "./table.ts";

export type AnyVirtualTable =
  | Fts5VirtualTable
  | RTreeVirtualTable
  | DbStatVirtualTable
  | BytecodeVirtualTable
  | TablesUsedVirtualTable
  | FtsVocabVirtualTable;

export interface ViewInfo {
  name: string;
  columns: string[] | null;
  select: SelectStmt;
  originalSql: string | null;
}

export interface IndexInfo {
  name: string;
  tableName: string;
  unique: boolean;
  columns: IndexedColumn[];
  where: Expr | null;
  originalSql: string | null;
  store: IndexStore;
}

export interface TriggerInfo {
  name: string;
  tableName: string;
  timing: "BEFORE" | "AFTER" | "INSTEAD";
  event: "INSERT" | "UPDATE" | "DELETE";
  when: Expr | null;
  forEachRow: boolean;
  /** Statements in the trigger body (already parsed). */
  body: import("../ast/nodes.ts").Statement[];
  updateColumns: string[] | null;
  originalSql: string | null;
}

/** In-memory catalog: tables, indexes, views, triggers, and mutation counters. */
export class DatabaseState {
  tables = new Map<string, Table>();
  virtualTables = new Map<string, AnyVirtualTable>();
  views = new Map<string, ViewInfo>();
  indexes = new Map<string, IndexInfo>();
  triggers = new Map<string, TriggerInfo>();
  /** Attached databases: schema name → state + filename label. */
  attached = new Map<string, { state: DatabaseState; filename: string }>();
  lastInsertRowid: Rowid = 0;
  changes = 0;
  totalChanges = 0;
  foreignKeysEnabled = false;
  /** When true, LIKE / like() are case-sensitive (SQLite `PRAGMA case_sensitive_like`). */
  caseSensitiveLike = false;
  schemaVersion = 0;
  userVersion = 0;

  databaseForSchema(schema: string | null, qualifiedForError?: string): DatabaseState {
    if (schema === null || schema.toLowerCase() === "main" || schema.toLowerCase() === "temp") return this;
    const entry = this.attached.get(schema.toLowerCase());
    if (!entry) {
      throw new SqliteError(`no such table: ${qualifiedForError ?? schema}`, "no_such_table");
    }
    return entry.state;
  }

  databaseForTable(table: Table): DatabaseState {
    if (this.tables.get(keyOf(table.name)) === table) return this;
    for (const { state } of this.attached.values()) {
      if (state.tables.get(keyOf(table.name)) === table) return state;
    }
    return this;
  }

  getTable(name: string): Table {
    const { schema, bare } = splitQualifiedName(name);
    if (schema !== null) {
      return this.databaseForSchema(schema, name).getTable(bare);
    }
    const key = keyOf(bare);
    if (this.virtualTables.has(key)) {
      throw new SqliteError(`no such table: ${name}`, "no_such_table");
    }
    const table = this.tables.get(key);
    if (!table) throw new SqliteError(`no such table: ${name}`, "no_such_table");
    return table;
  }

  getVirtualTable(name: string): Fts5VirtualTable {
    const { schema, bare } = splitQualifiedName(name);
    if (schema !== null) {
      return this.databaseForSchema(schema, name).getVirtualTable(bare);
    }
    const key = keyOf(bare);
    const table = this.virtualTables.get(key);
    if (!table || (table.kind !== "fts5" && table.kind !== "fts3" && table.kind !== "fts4")) {
      throw new SqliteError(`no such table: ${name}`, "no_such_table");
    }
    return table;
  }

  getAnyVirtualTable(name: string): AnyVirtualTable {
    const { schema, bare } = splitQualifiedName(name);
    if (schema !== null) {
      return this.databaseForSchema(schema, name).getAnyVirtualTable(bare);
    }
    const key = keyOf(bare);
    const table = this.virtualTables.get(key);
    if (!table) throw new SqliteError(`no such table: ${name}`, "no_such_table");
    return table;
  }

  isVirtualTable(name: string): boolean {
    const { schema, bare } = splitQualifiedName(name);
    if (schema !== null) {
      return this.databaseForSchema(schema, name).isVirtualTable(bare);
    }
    return this.virtualTables.has(keyOf(bare));
  }

  isFtsTable(name: string): boolean {
    const table = this.virtualTables.get(keyOf(splitQualifiedName(name).bare));
    return !!table && (table.kind === "fts5" || table.kind === "fts3" || table.kind === "fts4");
  }

  createVirtualTable(stmt: CreateVirtualTableStmt, originalSql: string | null = null): AnyVirtualTable {
    const { schema, bare } = splitQualifiedName(stmt.name);
    // temp schema is the same DatabaseState (in-memory); not an ATTACH slot.
    if (schema !== null && schema.toLowerCase() !== "temp" && schema.toLowerCase() !== "main") {
      return this.databaseForSchema(schema, stmt.name).createVirtualTable({ ...stmt, name: bare }, originalSql);
    }
    const key = keyOf(bare);
    const existing = this.virtualTables.get(key);
    if (existing && stmt.ifNotExists) return existing;
    this.assertSchemaNameAvailable(bare);
    const module = stmt.module.toLowerCase();
    let table: AnyVirtualTable;
    if (module === "fts5" || module === "fts3" || module === "fts4") {
      table = new Fts5VirtualTable(bare, stmt.moduleArgs, originalSql, module);
    } else if (module === "fts5vocab") {
      table = new FtsVocabVirtualTable(bare, stmt.moduleArgs, originalSql);
    } else if (module === "fts3tokenize" || module === "fts4aux") {
      // Tokenize/aux modules: expose as empty FTS-like single-column tables for CREATE success.
      table = new Fts5VirtualTable(bare, stmt.moduleArgs.length ? stmt.moduleArgs : ["token"], originalSql, "fts3");
    } else if (module === "rtree" || module === "rtree_i32") {
      table = new RTreeVirtualTable(bare, stmt.moduleArgs, module === "rtree_i32", originalSql);
    } else if (module === "dbstat") {
      table = new DbStatVirtualTable(bare, stmt.moduleArgs[0] ?? null, originalSql);
    } else if (module === "bytecode") {
      table = new BytecodeVirtualTable(bare, originalSql);
    } else if (module === "tables_used") {
      table = new TablesUsedVirtualTable(bare, originalSql);
    } else {
      throw new SqliteError(`unknown module: ${stmt.module}`, "unsupported");
    }
    this.virtualTables.set(key, table);
    this.schemaVersion++;
    return table;
  }

  createTable(stmt: CreateTableStmt, originalSql: string | null = null): Table {
    const { schema, bare } = splitQualifiedName(stmt.name);
    if (schema !== null) {
      return this.databaseForSchema(schema, stmt.name).createTable({ ...stmt, name: bare }, originalSql);
    }
    const key = keyOf(bare);
    const existing = this.tables.get(key);
    if (existing && stmt.ifNotExists) return existing;
    this.assertSchemaNameAvailable(bare);

    const seenColumns = new Set<string>();
    const tablePrimaryNames = new Set(
      stmt.constraints
        .filter((constraint) => constraint.type === "primary_key")
        .flatMap((constraint) => constraint.columns.map((column) => keyOf(column.name))),
    );
    if (stmt.constraints.filter((constraint) => constraint.type === "primary_key").length > 1) {
      throw new SqliteError("table has more than one primary key", "constraint_primary");
    }
    const columnPrimaryCount = stmt.columns.filter((column) =>
      column.constraints.some((constraint) => constraint.type === "primary_key"),
    ).length;
    if (columnPrimaryCount > 1) {
      throw new SqliteError("table has more than one primary key", "constraint_primary");
    }

    const columns: ColumnInfo[] = stmt.columns.map((definition) => {
      const columnKey = keyOf(definition.name);
      if (seenColumns.has(columnKey)) throw new SqliteError(`duplicate column name: ${definition.name}`, "other");
      seenColumns.add(columnKey);

      const primary = definition.constraints.find((constraint) => constraint.type === "primary_key");
      const primaryKey = primary !== undefined || tablePrimaryNames.has(columnKey);
      const autoincrement = primary?.type === "primary_key" && primary.autoincrement;
      if (autoincrement && definition.typeName?.trim().toUpperCase() !== "INTEGER") {
        throw new SqliteError("AUTOINCREMENT is only allowed on an INTEGER PRIMARY KEY", "unsupported");
      }
      const collateConstraint = definition.constraints.find((constraint) => constraint.type === "collate");
      const generatedConstraint = definition.constraints.find((constraint) => constraint.type === "generated");

      return {
        name: definition.name,
        typeName: definition.typeName,
        affinity: affinityFromTypeName(definition.typeName),
        notNull: definition.constraints.some((constraint) => constraint.type === "not_null"),
        primaryKey,
        autoincrement,
        defaultExpr: definition.constraints.find((constraint) => constraint.type === "default")?.expr ?? null,
        unique: definition.constraints.some((constraint) => constraint.type === "unique"),
        collate: collateConstraint?.type === "collate" ? collateConstraint.name : null,
        generated:
          generatedConstraint?.type === "generated"
            ? { expr: generatedConstraint.expr, stored: generatedConstraint.stored }
            : null,
      };
    });

    for (const constraint of stmt.constraints) {
      const localNames =
        constraint.type === "primary_key" || constraint.type === "unique"
          ? constraint.columns.map((column) => column.name)
          : constraint.type === "foreign_key"
            ? constraint.columns
            : [];
      for (const name of localNames) {
        if (!seenColumns.has(keyOf(name))) throw new SqliteError(`no such column: ${name}`, "no_such_column");
      }
    }
    const hasColumnPrimary = stmt.columns.some((column) =>
      column.constraints.some((constraint) => constraint.type === "primary_key"),
    );
    if (hasColumnPrimary && tablePrimaryNames.size > 0) {
      throw new SqliteError("table has more than one primary key", "constraint_primary");
    }
    if (stmt.columns.length === 0) {
      throw new SqliteError("table must have at least one column", "syntax");
    }
    if (stmt.strict) {
      for (const definition of stmt.columns) {
        const typeName = definition.typeName?.trim() ?? "";
        if (!isStrictTypeName(typeName)) unknownStrictType(bare, definition.name, typeName || "null");
      }
    }

    const normalizedConstraints = [...stmt.constraints];
    for (const definition of stmt.columns) {
      for (const constraint of definition.constraints) {
        if (constraint.type === "check") {
          normalizedConstraints.push({ type: "check", expr: constraint.expr, name: null });
        } else if (constraint.type === "references") {
          normalizedConstraints.push({
            type: "foreign_key",
            columns: [definition.name],
            refTable: constraint.table,
            refColumns: constraint.columns,
            onDelete: constraint.onDelete,
            onUpdate: constraint.onUpdate,
            match: constraint.match,
            name: null,
            deferrable: constraint.deferrable,
            initiallyDeferred: constraint.initiallyDeferred,
          });
        }
      }
    }
    const table = new Table(bare, columns, {
      constraints: normalizedConstraints,
      originalSql,
      withoutRowid: stmt.withoutRowid,
      strict: stmt.strict,
    });
    if (stmt.withoutRowid) {
      const pk = columns.filter((column) => column.primaryKey);
      if (pk.length === 0) {
        throw new SqliteError("PRIMARY KEY missing on table " + bare, "other");
      }
    }
    this.tables.set(key, table);
    this.createAutoIndexesForTable(table);
    this.schemaVersion++;
    return table;
  }

  /**
   * SQLite-like autoindexes for PRIMARY KEY / UNIQUE so lookups and uniqueness
   * checks can use IndexStore. Skips single-column INTEGER PRIMARY KEY (rowid alias).
   */
  private createAutoIndexesForTable(table: Table): void {
    let seq = 1;
    const add = (columns: IndexedColumn[], unique: boolean): void => {
      if (columns.length === 0) return;
      // INTEGER PRIMARY KEY is the rowid map — no secondary autoindex.
      if (
        unique &&
        columns.length === 1 &&
        !table.withoutRowid &&
        table.integerPkColumn()?.name.toLowerCase() === columns[0]!.name.toLowerCase()
      ) {
        return;
      }
      const name = `sqlite_autoindex_${table.name}_${seq++}`;
      const index: IndexInfo = {
        name,
        tableName: table.name,
        unique,
        columns: structuredClone(columns),
        where: null,
        originalSql: null,
        store: new IndexStore(name),
      };
      this.indexes.set(keyOf(name), index);
      table.indexes.push(index.name);
    };

    const hasTablePrimary = table.constraints.some((constraint) => constraint.type === "primary_key");
    for (const column of table.columns) {
      if (column.unique) {
        add([{ name: column.name, collate: column.collate, order: null }], true);
      }
      if (column.primaryKey && !hasTablePrimary) {
        add([{ name: column.name, collate: column.collate, order: null }], true);
      }
    }
    for (const constraint of table.constraints) {
      if (constraint.type === "primary_key" || constraint.type === "unique") {
        add(constraint.columns, true);
      }
    }
  }

  dropTable(name: string, ifExists = false): boolean {
    const { schema, bare } = splitQualifiedName(name);
    if (schema !== null) {
      return this.databaseForSchema(schema, name).dropTable(bare, ifExists);
    }
    const key = keyOf(bare);
    const table = this.tables.get(key);
    const virtual = this.virtualTables.get(key);
    if (!table && !virtual) {
      if (ifExists) return false;
      throw new SqliteError(`no such table: ${name}`, "no_such_table");
    }
    if (virtual) {
      this.virtualTables.delete(key);
      this.schemaVersion++;
      return true;
    }
    for (const [indexKey, index] of this.indexes) {
      if (keyOf(index.tableName) === key) this.indexes.delete(indexKey);
    }
    this.dropTriggersForTable(bare);
    this.tables.delete(key);
    this.schemaVersion++;
    return true;
  }

  renameTable(oldName: string, newName: string): Table {
    const { schema: oldSchema, bare: oldBare } = splitQualifiedName(oldName);
    if (oldSchema !== null) {
      return this.databaseForSchema(oldSchema, oldName).renameTable(oldBare, splitQualifiedName(newName).bare);
    }
    const oldKey = keyOf(oldBare);
    const table = this.getWritableTable(oldName);
    const { schema: newSchema, bare: newBare } = splitQualifiedName(newName);
    if (newSchema !== null) {
      throw new SqliteError(`no such table: ${newName}`, "no_such_table");
    }
    this.assertSchemaNameAvailable(newBare);
    this.tables.delete(oldKey);
    table.name = newBare;
    this.tables.set(keyOf(newBare), table);
    for (const index of [...this.indexes.values()]) {
      if (keyOf(index.tableName) !== oldKey) continue;
      this.ensureWritableIndex(index).tableName = newBare;
    }
    for (const [key, trigger] of this.triggers) {
      if (keyOf(trigger.tableName) !== oldKey) continue;
      this.triggers.set(key, { ...trigger, tableName: newBare });
    }
    this.schemaVersion++;
    return table;
  }

  createView(stmt: CreateViewStmt, originalSql: string | null = null): ViewInfo {
    const { schema, bare } = splitQualifiedName(stmt.name);
    if (schema !== null) {
      return this.databaseForSchema(schema, stmt.name).createView({ ...stmt, name: bare }, originalSql);
    }
    const key = keyOf(bare);
    const existing = this.views.get(key);
    if (existing && stmt.ifNotExists) return existing;
    this.assertSchemaNameAvailable(bare);
    const view: ViewInfo = {
      name: bare,
      columns: stmt.columns ? [...stmt.columns] : null,
      select: structuredClone(stmt.select),
      originalSql,
    };
    this.views.set(key, view);
    this.schemaVersion++;
    return view;
  }

  dropView(name: string, ifExists = false): boolean {
    const { schema, bare } = splitQualifiedName(name);
    if (schema !== null) {
      return this.databaseForSchema(schema, name).dropView(bare, ifExists);
    }
    const deleted = this.views.delete(keyOf(bare));
    if (!deleted && !ifExists) throw new SqliteError(`no such view: ${name}`, "other");
    if (deleted) this.schemaVersion++;
    return deleted;
  }

  createIndex(stmt: CreateIndexStmt, originalSql: string | null = null): IndexInfo {
    const table = this.getWritableTable(stmt.table);
    const { schema, bare } = splitQualifiedName(stmt.name);
    const target = schema !== null ? this.databaseForSchema(schema, stmt.name) : this.databaseForTable(table);
    const key = keyOf(bare);
    const existing = target.indexes.get(key);
    if (existing && stmt.ifNotExists) return existing;
    target.assertSchemaNameAvailable(bare);
    for (const indexed of stmt.columns) {
      if (indexed.expr) continue;
      if (!table.columns.some((column) => keyOf(column.name) === keyOf(indexed.name))) {
        throw new SqliteError(`no such column: ${indexed.name}`, "no_such_column");
      }
    }
    const index: IndexInfo = {
      name: bare,
      tableName: table.name,
      unique: stmt.unique,
      columns: structuredClone(stmt.columns),
      where: stmt.where ? structuredClone(stmt.where) : null,
      originalSql,
      store: new IndexStore(bare),
    };
    target.indexes.set(key, index);
    table.indexes.push(index.name);
    target.schemaVersion++;
    return index;
  }

  dropIndex(name: string, ifExists = false): boolean {
    const { schema, bare } = splitQualifiedName(name);
    const target = schema !== null ? this.databaseForSchema(schema, name) : this;
    const key = keyOf(bare);
    const index = target.indexes.get(key);
    if (!index) {
      if (ifExists) return false;
      throw new SqliteError(`no such index: ${name}`, "other");
    }
    target.indexes.delete(key);
    const table = target.tables.get(keyOf(index.tableName));
    if (table) {
      const writable = target.ensureWritableTable(table);
      writable.indexes = writable.indexes.filter((item) => keyOf(item) !== key);
    }
    target.schemaVersion++;
    return true;
  }

  createTrigger(info: TriggerInfo): TriggerInfo {
    const { schema, bare } = splitQualifiedName(info.name);
    const target = schema !== null ? this.databaseForSchema(schema, info.name) : this;
    const key = keyOf(bare);
    target.assertSchemaNameAvailable(bare);
    const trigger: TriggerInfo = {
      ...info,
      name: bare,
      body: structuredClone(info.body),
      when: info.when ? structuredClone(info.when) : null,
      updateColumns: info.updateColumns ? [...info.updateColumns] : null,
    };
    target.triggers.set(key, trigger);
    target.schemaVersion++;
    return trigger;
  }

  dropTrigger(name: string, ifExists = false): boolean {
    const { schema, bare } = splitQualifiedName(name);
    const target = schema !== null ? this.databaseForSchema(schema, name) : this;
    const key = keyOf(bare);
    const deleted = target.triggers.delete(key);
    if (!deleted && !ifExists) throw new SqliteError(`no such trigger: ${name}`, "other");
    if (deleted) target.schemaVersion++;
    return deleted;
  }

  dropTriggersForTable(tableName: string): void {
    const key = keyOf(tableName);
    for (const [triggerKey, trigger] of this.triggers) {
      if (keyOf(trigger.tableName) === key) this.triggers.delete(triggerKey);
    }
  }

  recordChange(count: number, lastInsertRowid?: Rowid): void {
    this.changes = count;
    this.totalChanges += count;
    if (lastInsertRowid !== undefined) this.lastInsertRowid = lastInsertRowid;
  }

  clone(): DatabaseState {
    const copy = new DatabaseState();
    for (const [key, table] of this.tables) copy.tables.set(key, table.clone());
    for (const [key, table] of this.virtualTables) copy.virtualTables.set(key, table.clone());
    for (const [key, view] of this.views) {
      copy.views.set(key, {
        name: view.name,
        columns: view.columns ? [...view.columns] : null,
        select: structuredClone(view.select),
        originalSql: view.originalSql,
      });
    }
    for (const [key, index] of this.indexes) {
      copy.indexes.set(key, {
        name: index.name,
        tableName: index.tableName,
        unique: index.unique,
        columns: structuredClone(index.columns),
        where: index.where ? structuredClone(index.where) : null,
        originalSql: index.originalSql,
        store: index.store.clone(),
      });
    }
    for (const [key, trigger] of this.triggers) {
      copy.triggers.set(key, {
        name: trigger.name,
        tableName: trigger.tableName,
        timing: trigger.timing,
        event: trigger.event,
        when: trigger.when ? structuredClone(trigger.when) : null,
        forEachRow: trigger.forEachRow,
        body: structuredClone(trigger.body),
        updateColumns: trigger.updateColumns ? [...trigger.updateColumns] : null,
        originalSql: trigger.originalSql,
      });
    }
    for (const [name, attached] of this.attached) {
      copy.attached.set(name, { state: attached.state.clone(), filename: attached.filename });
    }
    copy.lastInsertRowid = this.lastInsertRowid;
    copy.changes = this.changes;
    copy.totalChanges = this.totalChanges;
    copy.foreignKeysEnabled = this.foreignKeysEnabled;
    copy.caseSensitiveLike = this.caseSensitiveLike;
    copy.schemaVersion = this.schemaVersion;
    copy.userVersion = this.userVersion;
    return copy;
  }

  /** Share table/index objects with the live state. Callers must freeze first. */
  cloneShallow(): DatabaseState {
    const copy = new DatabaseState();
    copy.tables = new Map(this.tables);
    for (const [key, table] of this.virtualTables) copy.virtualTables.set(key, table.clone());
    copy.views = new Map(this.views);
    copy.indexes = new Map(this.indexes);
    copy.triggers = new Map(this.triggers);
    for (const [name, attached] of this.attached) {
      copy.attached.set(name, { state: attached.state.cloneShallow(), filename: attached.filename });
    }
    copy.lastInsertRowid = this.lastInsertRowid;
    copy.changes = this.changes;
    copy.totalChanges = this.totalChanges;
    copy.foreignKeysEnabled = this.foreignKeysEnabled;
    copy.caseSensitiveLike = this.caseSensitiveLike;
    copy.schemaVersion = this.schemaVersion;
    copy.userVersion = this.userVersion;
    return copy;
  }

  freezeShared(): void {
    for (const table of this.tables.values()) table.freeze();
    for (const index of this.indexes.values()) index.store.freeze();
    for (const attached of this.attached.values()) attached.state.freezeShared();
  }

  thawShared(): void {
    for (const table of this.tables.values()) table.frozen = false;
    for (const index of this.indexes.values()) index.store.frozen = false;
    for (const attached of this.attached.values()) attached.state.thawShared();
  }

  getWritableTable(name: string): Table {
    const { schema, bare } = splitQualifiedName(name);
    if (schema !== null) {
      return this.databaseForSchema(schema, name).getWritableTable(bare);
    }
    const table = this.getTable(bare);
    return this.ensureWritableTable(table);
  }

  ensureWritableTable(table: Table): Table {
    if (!table.frozen) return table;
    const key = keyOf(table.name);
    const copy = table.clone();
    this.tables.set(key, copy);
    return copy;
  }

  getWritableIndex(name: string): IndexInfo {
    const key = keyOf(name);
    const index = this.indexes.get(key);
    if (!index) throw new SqliteError(`no such index: ${name}`, "other");
    return this.ensureWritableIndex(index);
  }

  ensureWritableIndex(index: IndexInfo): IndexInfo {
    if (!index.store.frozen) return index;
    const copy: IndexInfo = {
      name: index.name,
      tableName: index.tableName,
      unique: index.unique,
      columns: structuredClone(index.columns),
      where: index.where ? structuredClone(index.where) : null,
      originalSql: index.originalSql,
      store: index.store.clone(),
    };
    this.indexes.set(keyOf(index.name), copy);
    return copy;
  }

  replaceWith(state: DatabaseState, options?: { adopt?: boolean }): void {
    const copy = options?.adopt ? state : state.clone();
    this.tables = copy.tables;
    this.virtualTables = copy.virtualTables;
    this.views = copy.views;
    this.indexes = copy.indexes;
    this.triggers = copy.triggers;
    this.attached = copy.attached;
    this.lastInsertRowid = copy.lastInsertRowid;
    this.changes = copy.changes;
    this.totalChanges = copy.totalChanges;
    this.foreignKeysEnabled = copy.foreignKeysEnabled;
    this.caseSensitiveLike = copy.caseSensitiveLike;
    this.schemaVersion = copy.schemaVersion;
    this.userVersion = copy.userVersion;
  }

  private assertSchemaNameAvailable(name: string): void {
    const key = keyOf(name);
    if (
      this.tables.has(key) ||
      this.views.has(key) ||
      this.indexes.has(key) ||
      this.virtualTables.has(key) ||
      this.triggers.has(key)
    ) {
      throw new SqliteError(`object already exists: ${name}`, "other");
    }
  }
}

export function splitQualifiedName(name: string): { schema: string | null; bare: string } {
  const dot = name.indexOf(".");
  if (dot < 0) return { schema: null, bare: name };
  return { schema: name.slice(0, dot), bare: name.slice(dot + 1) };
}

function keyOf(name: string): string {
  return name.toLowerCase();
}
