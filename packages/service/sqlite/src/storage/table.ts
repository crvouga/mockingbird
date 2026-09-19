import type { Expr, TableConstraint } from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import { assertRowShape } from "../runtime/assert.ts";
import { serializeIndexKey } from "../indexes/index.ts";
import { compareWithCollation, normalizeForCollation } from "../types/collation.ts";
import { applyStrictValue } from "../types/strict.ts";
import type { Affinity, SqlValue } from "../types/value.ts";
import { affinityFromTypeName, applyAffinity, cloneSqlValue, compareSql } from "../types/value.ts";
import type { NamedRowValues, Row, Rowid, RowValues } from "./row.ts";
import { isValueArray, normalizeColumnName, rowValues } from "./row.ts";
import type { ColumnarSlab } from "./columnar-slab.ts";

/** Build a covering equality hash once a table is large enough that scans dominate. */
const EQUALITY_HASH_MIN_ROWS = 16;

export interface ColumnInfo {
  name: string;
  /** Cached `name.toLowerCase()` for hot-path lookups. */
  nameLower?: string;
  typeName: string | null;
  affinity: Affinity;
  notNull: boolean;
  primaryKey: boolean;
  autoincrement: boolean;
  defaultExpr: Expr | null;
  unique: boolean;
  /** Declared column collation (BINARY/NOCASE/RTRIM); null means BINARY. */
  collate: string | null;
  /** GENERATED ALWAYS AS (...) — VIRTUAL computed on read, STORED materialized. */
  generated: { expr: Expr; stored: boolean } | null;
}

export interface InsertOptions {
  /** Values are already affinity-applied Maps with lowercase keys; skip prepareValues. */
  prepared?: boolean;
  /** Skip NOT NULL / UNIQUE / PK scans (caller already enforced, or table is unconstrained). */
  skipValidate?: boolean;
}

export interface InsertRow {
  rowid?: Rowid;
  values: RowValues;
}

export interface TableOptions {
  constraints?: TableConstraint[];
  indexes?: string[];
  originalSql?: string | null;
  withoutRowid?: boolean;
  strict?: boolean;
}

export class Table {
  name: string;
  columns: ColumnInfo[];
  rows: Map<Rowid, Row>;
  nextRowid: Rowid;
  constraints: TableConstraint[];
  indexes: string[];
  originalSql: string | null;
  withoutRowid: boolean;
  strict: boolean;
  /** Clustered PK key string → row for WITHOUT ROWID tables. */
  clusteredRows: Map<string, Row>;
  /** Frozen columnar storage after snapshot hydrate; `rows` stays empty until materialized. */
  slab: ColumnarSlab | null = null;
  private scanCache: Row[] | null = null;
  /** Lazy covering hashes: column nameLower → serializeIndexKey → rowids. */
  private equalityHashes: Map<string, Map<string, Rowid[]>> | null = null;
  /** Cached maximum rowid. `undefined` means recompute after deleting the maximum. */
  private maximumRowid: Rowid | null | undefined = null;
  frozen = false;
  /** nameLower → column index; rebuilt after ALTER. */
  private colIndex = new Map<string, number>();

  constructor(name: string, columns: ColumnInfo[], options: TableOptions = {}) {
    this.name = name;
    this.columns = columns.map(cloneColumn);
    this.rows = new Map();
    this.nextRowid = 1;
    this.constraints = cloneAst(options.constraints ?? []);
    this.indexes = [...(options.indexes ?? [])];
    this.originalSql = options.originalSql ?? null;
    this.withoutRowid = options.withoutRowid ?? false;
    this.strict = options.strict ?? false;
    this.clusteredRows = new Map();
    this.scanCache = null;
    this.rebuildColIndex();
  }

  rebuildColIndex(): void {
    this.colIndex = new Map();
    for (let i = 0; i < this.columns.length; i++) {
      const column = this.columns[i]!;
      this.colIndex.set(column.nameLower ?? column.name.toLowerCase(), i);
    }
  }

  columnOffset(nameLower: string): number | undefined {
    return this.colIndex.get(nameLower);
  }

  hasColumn(nameLower: string): boolean {
    return this.colIndex.has(nameLower);
  }

  cell(row: Row, nameLower: string): SqlValue {
    const i = this.colIndex.get(nameLower);
    return i === undefined ? null : (row.values[i] ?? null);
  }

  setCell(row: Row, nameLower: string, value: SqlValue): void {
    const i = this.colIndex.get(nameLower);
    if (i === undefined) throw new SqliteError(`no such column: ${nameLower}`, "no_such_column");
    row.values[i] = value;
  }

  namedValues(row: Row): Map<string, SqlValue> {
    const map = new Map<string, SqlValue>();
    for (let i = 0; i < this.columns.length; i++) {
      const column = this.columns[i]!;
      map.set(column.nameLower ?? column.name.toLowerCase(), row.values[i] ?? null);
    }
    return map;
  }

  rowFromNamed(values: Map<string, SqlValue>, rowid: Rowid = 0): Row {
    const cells: SqlValue[] = [];
    for (const column of this.columns) {
      cells.push(values.get(normalizeColumnName(column.name)) ?? null);
    }
    return { rowid, values: cells };
  }

  integerPkColumn(): ColumnInfo | undefined {
    return this.integerPrimaryKeyAlias();
  }

  get(rowid: Rowid): Row | undefined {
    if (this.slab) {
      const hit = this.slab.get(rowid);
      return hit ?? undefined;
    }
    try {
      return this.rows.get(canonicalRowid(rowid));
    } catch {
      return undefined;
    }
  }

  /** Row count (slab-backed or map-backed). */
  rowCount(): number {
    return this.slab ? this.slab.rowCount : this.rows.size;
  }

  /** Rows sorted by rowid for snapshot encode. */
  sortedRows(): Row[] {
    if (this.slab) return [...this.slab.scan()].map((r) => ({ rowid: r.rowid, values: [...r.values] }));
    return [...this.rows.values()].sort((a, b) => compareRowids(a.rowid, b.rowid));
  }

  /** Attach decoded columnar slab (hydrate path). */
  attachSlab(slab: ColumnarSlab): void {
    this.slab = slab;
    this.invalidateScan();
  }

  /** Materialize slab into `rows` Map for mutation. */
  materializeSlab(): void {
    if (!this.slab) return;
    for (const row of this.slab.scan()) this.rows.set(row.rowid, { rowid: row.rowid, values: [...row.values] });
    this.slab = null;
    if (this.withoutRowid) this.rebuildClusteredRows();
    else this.invalidateScan();
  }

  private hasRow(rowid: Rowid): boolean {
    if (this.slab) return this.slab.get(rowid) !== undefined;
    try {
      return this.rows.has(canonicalRowid(rowid));
    } catch {
      return false;
    }
  }

  private allRowids(): Iterable<Rowid> {
    if (this.slab) return this.slab.rowids;
    return this.rows.keys();
  }

  getByKey(value: SqlValue): Row | undefined {
    if (value === null || this.withoutRowid) return undefined;
    try {
      return this.get(asRowid(value, "rowid"));
    } catch {
      return undefined;
    }
  }

  private invalidateScan(): void {
    this.scanCache = null;
  }

  private commitRow(row: Row): void {
    assertRowShape(this, row);
    this.indexEquality(row);
    this.invalidateScan();
  }

  private reindexEquality(before: Row, after: Row): void {
    this.unindexEquality(before);
    this.indexEquality(after);
    this.invalidateScan();
  }

  /** True when the table has no user constraints that DML must enforce beyond hidden rowid. */
  isUnconstrained(): boolean {
    if (this.withoutRowid || this.strict || this.indexes.length > 0 || this.constraints.length > 0) return false;
    for (const column of this.columns) {
      if (column.notNull || column.primaryKey || column.unique || column.generated || column.defaultExpr) return false;
    }
    return true;
  }

  /**
   * Point lookup via a write-maintained covering hash (not a schema index).
   * Returns null when the table is too small or the column does not exist.
   */
  lookupEquality(columnLower: string, value: SqlValue): Row[] | null {
    if (!this.ensureEqualityHash(columnLower)) return null;
    const map = this.equalityHashes!.get(columnLower);
    if (!map) return null;
    const column = this.columns.find((item) => item.nameLower === columnLower);
    const key = serializeIndexKey([normalizeForCollation(value, column?.collate ?? "BINARY")]);
    if (key === null) return [];
    const rowids = map.get(key);
    if (!rowids || rowids.length === 0) return [];
    const rows: Row[] = [];
    for (const rowid of rowids) {
      const row = this.get(rowid);
      if (row) rows.push(row);
    }
    return rows;
  }

  ensureEqualityHash(columnLower: string): boolean {
    if (this.frozen || this.rowCount() < EQUALITY_HASH_MIN_ROWS) return false;
    const column = this.columns.find((item) => item.nameLower === columnLower);
    if (!column) return false;
    this.equalityHashes ??= new Map();
    if (this.equalityHashes.has(columnLower)) return true;
    const map = new Map<string, Rowid[]>();
    const collate = column.collate ?? "BINARY";
    const iter = this.slab ? this.slab.scan() : this.rows.values();
    for (const row of iter) {
      const key = serializeIndexKey([normalizeForCollation(this.cell(row, columnLower), collate)]);
      if (key === null) continue;
      const bucket = map.get(key);
      if (bucket) bucket.push(row.rowid);
      else map.set(key, [row.rowid]);
    }
    this.equalityHashes.set(columnLower, map);
    return true;
  }

  clearEqualityHashes(): void {
    this.equalityHashes = null;
  }

  private indexEquality(row: Row): void {
    if (!this.equalityHashes) return;
    for (const [columnLower, map] of this.equalityHashes) {
      const column = this.columns.find((item) => item.nameLower === columnLower);
      const key = serializeIndexKey([normalizeForCollation(this.cell(row, columnLower), column?.collate ?? "BINARY")]);
      if (key === null) continue;
      const bucket = map.get(key);
      if (bucket) {
        if (!bucket.some((id) => sameRowid(id, row.rowid))) bucket.push(row.rowid);
      } else map.set(key, [row.rowid]);
    }
  }

  private unindexEquality(row: Row): void {
    if (!this.equalityHashes) return;
    for (const [columnLower, map] of this.equalityHashes) {
      const column = this.columns.find((item) => item.nameLower === columnLower);
      const key = serializeIndexKey([normalizeForCollation(this.cell(row, columnLower), column?.collate ?? "BINARY")]);
      if (key === null) continue;
      const bucket = map.get(key);
      if (!bucket) continue;
      const index = bucket.findIndex((id) => sameRowid(id, row.rowid));
      if (index >= 0) bucket.splice(index, 1);
      if (bucket.length === 0) map.delete(key);
    }
  }

  insert(input: InsertRow | RowValues, options?: InsertOptions): Rowid {
    this.assertMutable();
    const supplied = isInsertRow(input) ? input : { values: input };
    const values = this.cellsFromInput(supplied.values, options?.prepared === true);

    if (this.withoutRowid) {
      if (supplied.rowid !== undefined) {
        throw new SqliteError(`table ${this.name} has no column named rowid`, "other");
      }
      const rowid = canonicalRowid(this.allocateRowid());
      const candidate: Row = { rowid, values };
      if (!options?.skipValidate) this.validate(candidate);
      const clusterKey = this.makeClusterKey(values);
      if (this.clusteredRows.has(clusterKey)) {
        throw primaryKeyConflict(this.name, this.primaryKeyColumns());
      }
      this.clusteredRows.set(clusterKey, candidate);
      this.rows.set(rowid, candidate);
      this.advanceNextRowid(rowid);
      this.commitRow(candidate);
      return rowid;
    }

    const alias = this.integerPrimaryKeyAlias();
    let rowid = supplied.rowid;

    if (alias) {
      const value = this.cell({ rowid: 0, values }, normalizeColumnName(alias.name));
      if (rowid === undefined && value !== null) rowid = asRowid(value, alias.name);
    }
    rowid = canonicalRowid(rowid ?? this.allocateRowid());

    if (this.hasRow(rowid)) {
      throw new SqliteError(
        `UNIQUE constraint failed: ${this.name}.rowid`,
        "constraint_primary",
        "SQLITE_CONSTRAINT_PRIMARYKEY",
      );
    }
    if (alias) this.setCell({ rowid, values }, normalizeColumnName(alias.name), rowid);

    const candidate: Row = { rowid, values };
    if (!options?.skipValidate) this.validate(candidate);
    this.rows.set(rowid, candidate);
    this.advanceNextRowid(rowid);
    this.commitRow(candidate);
    return rowid;
  }

  update(rowid: Rowid, updates: RowValues): Row | undefined {
    this.assertMutable();
    const key = canonicalRowid(rowid);
    const existing = this.rows.get(key);
    if (!existing) return undefined;

    const values = existing.values.slice();
    const incoming = isValueArray(updates) ? updates : rowValues(updates);
    if (isValueArray(updates)) {
      for (let i = 0; i < updates.length && i < this.columns.length; i++) {
        const column = this.columns[i]!;
        values[i] = applyAffinity(cloneSqlValue(updates[i] ?? null), column.affinity);
      }
    } else {
      for (const [name, value] of incoming as Map<string, SqlValue>) {
        const column = this.column(name);
        const offset = this.columnOffset(normalizeColumnName(column.name));
        if (offset === undefined) continue;
        values[offset] = applyAffinity(cloneSqlValue(value), column.affinity);
      }
    }

    if (this.withoutRowid) {
      const oldClusterKey = this.makeClusterKey(existing.values);
      const newClusterKey = this.makeClusterKey(values);
      if (newClusterKey !== oldClusterKey && this.clusteredRows.has(newClusterKey)) {
        throw primaryKeyConflict(this.name, this.primaryKeyColumns());
      }
      const candidate: Row = { rowid: key, values };
      this.validate(candidate, key);
      if (newClusterKey !== oldClusterKey) this.clusteredRows.delete(oldClusterKey);
      this.clusteredRows.set(newClusterKey, candidate);
      this.rows.set(key, candidate);
      this.reindexEquality(existing, candidate);
      return candidate;
    }

    const alias = this.integerPrimaryKeyAlias();
    const aliasRow: Row = { rowid: key, values };
    const targetKey = alias ? asRowid(this.cell(aliasRow, normalizeColumnName(alias.name)), alias.name) : key;
    if (targetKey !== key && this.hasRow(targetKey)) {
      throw new SqliteError(
        `UNIQUE constraint failed: ${this.name}.${alias?.name ?? "rowid"}`,
        "constraint_unique",
        "SQLITE_CONSTRAINT_UNIQUE",
      );
    }
    if (alias) this.setCell(aliasRow, normalizeColumnName(alias.name), targetKey);
    const candidate: Row = { rowid: targetKey, values };
    this.validate(candidate, key);
    if (targetKey !== key) {
      this.rows.delete(key);
      if (this.maximumRowid !== null && this.maximumRowid !== undefined && sameRowid(key, this.maximumRowid)) {
        this.maximumRowid = undefined;
      }
    }
    this.rows.set(targetKey, candidate);
    this.advanceNextRowid(targetKey);
    this.reindexEquality(existing, candidate);
    return candidate;
  }

  delete(rowid: Rowid): boolean {
    this.assertMutable();
    const key = canonicalRowid(rowid);
    const existing = this.rows.get(key);
    if (!existing) return false;
    if (this.withoutRowid) this.clusteredRows.delete(this.makeClusterKey(existing.values));
    this.unindexEquality(existing);
    this.invalidateScan();
    if (this.maximumRowid !== null && this.maximumRowid !== undefined && sameRowid(key, this.maximumRowid)) {
      this.maximumRowid = undefined;
    }
    return this.rows.delete(key);
  }

  *scan(): Iterable<Row> {
    if (this.slab) {
      yield* this.slab.scan();
      return;
    }
    if (!this.scanCache) {
      if (this.withoutRowid) {
        this.scanCache = [...this.clusteredRows.values()].sort((a, b) => this.comparePrimaryKeys(a, b));
      } else {
        this.scanCache = [...this.rows.values()].sort((a, b) => compareRowids(a.rowid, b.rowid));
      }
    }
    yield* this.scanCache;
  }

  clone(): Table {
    const copy = new Table(this.name, this.columns, {
      constraints: this.constraints,
      indexes: this.indexes,
      originalSql: this.originalSql,
      withoutRowid: this.withoutRowid,
      strict: this.strict,
    });
    copy.nextRowid = this.nextRowid;
    copy.maximumRowid = this.maximumRowid;
    if (this.slab) {
      for (const row of this.slab.scan()) copy.rows.set(row.rowid, row);
    } else {
      for (const [rowid, row] of this.rows) copy.rows.set(rowid, row);
    }
    for (const [clusterKey, row] of this.clusteredRows) copy.clusteredRows.set(clusterKey, row);
    return copy;
  }

  freeze(): void {
    this.frozen = true;
  }

  private assertMutable(): void {
    if (this.frozen) throw new SqliteError("internal: cannot mutate a frozen table", "other");
    if (this.slab) this.materializeSlab();
  }

  /** Rebuild clustered storage after snapshot decode or bulk load. */
  rebuildClusteredRows(): void {
    this.maximumRowid = undefined;
    if (!this.withoutRowid) return;
    this.clusteredRows.clear();
    const iter = this.slab ? this.slab.scan() : this.rows.values();
    for (const row of iter) {
      this.clusteredRows.set(this.makeClusterKey(row.values), row);
    }
    this.invalidateScan();
    this.clearEqualityHashes();
  }

  private cellsFromInput(input: RowValues, prepared: boolean): SqlValue[] {
    if (isValueArray(input)) {
      if (prepared && input.length === this.columns.length) return [...input];
      return this.prepareValues(namedFromArray(this, input));
    }
    if (prepared) {
      const named = rowValues(input);
      const cells: SqlValue[] = [];
      for (const column of this.columns) cells.push(named.get(normalizeColumnName(column.name)) ?? null);
      return cells;
    }
    return this.prepareValues(input);
  }

  private prepareValues(input: NamedRowValues): SqlValue[] {
    const supplied = rowValues(input);
    for (const name of supplied.keys()) this.column(name);

    const result: SqlValue[] = [];
    for (const column of this.columns) {
      const key = normalizeColumnName(column.name);
      const raw = cloneSqlValue(supplied.get(key) ?? null);
      const affined = applyAffinity(raw, column.affinity);
      result.push(this.strict ? applyStrictValue(affined, column.typeName ?? "", this.name, column.name) : affined);
    }
    return result;
  }

  private column(name: string): ColumnInfo {
    const key = normalizeColumnName(name);
    const column = this.columns.find((item) => normalizeColumnName(item.name) === key);
    if (!column) throw new SqliteError(`no such column: ${name}`, "no_such_column");
    return column;
  }

  private validate(row: Row, excludedRowid?: Rowid): void {
    for (let i = 0; i < this.columns.length; i++) {
      const column = this.columns[i]!;
      const value = row.values[i] ?? null;
      if ((column.notNull || column.primaryKey) && value === null) {
        const category = column.primaryKey ? "constraint_primary" : "constraint_notnull";
        const code = column.primaryKey ? "SQLITE_CONSTRAINT_PRIMARYKEY" : "SQLITE_CONSTRAINT_NOTNULL";
        throw new SqliteError(
          `${column.primaryKey ? "PRIMARY KEY" : "NOT NULL"} constraint failed: ${this.name}.${column.name}`,
          category,
          code,
        );
      }
    }

    const uniqueSets = this.uniqueColumnSets();
    if (this.indexes.length === 0) {
      for (const names of uniqueSets) {
        const values = names.map((name) => this.cell(row, normalizeColumnName(name)));
        if (values.some((value) => value === null)) continue;
        for (const other of this.rows.values()) {
          if (excludedRowid !== undefined && other.rowid === excludedRowid) continue;
          if (
            values.every((value, index) => {
              const column = this.column(names[index]!);
              const otherValue = this.cell(other, normalizeColumnName(names[index]!));
              const collation = column.collate ?? "BINARY";
              return compareWithCollation(value, otherValue, collation) === 0;
            })
          ) {
            const qualified = names.map((name) => `${this.name}.${name}`).join(", ");
            throw new SqliteError(
              `UNIQUE constraint failed: ${qualified}`,
              "constraint_unique",
              "SQLITE_CONSTRAINT_UNIQUE",
            );
          }
        }
      }
    } else if (uniqueSets.length > 0) {
      // Indexes exist: uniqueness is enforced by IndexStore on addIndexes / conflict checks.
    }
  }

  private uniqueColumnSets(): string[][] {
    const sets = this.columns.filter((column) => column.unique).map((column) => [column.name]);
    if (!this.constraints.some((constraint) => constraint.type === "primary_key")) {
      const primary = this.columns.filter((column) => column.primaryKey).map((column) => column.name);
      if (primary.length > 0) sets.push(primary);
    }
    for (const constraint of this.constraints) {
      if (constraint.type === "unique" || constraint.type === "primary_key") {
        sets.push(constraint.columns.map((column) => column.name));
      }
    }
    return sets;
  }

  private primaryKeyColumns(): ColumnInfo[] {
    const tablePrimary = this.constraints.find((constraint) => constraint.type === "primary_key");
    if (tablePrimary) {
      return tablePrimary.columns.map((column) => this.column(column.name));
    }
    return this.columns.filter((column) => column.primaryKey);
  }

  private makeClusterKey(values: readonly SqlValue[]): string {
    return this.primaryKeyColumns()
      .map((column) => {
        const offset = this.columnOffset(normalizeColumnName(column.name)) ?? 0;
        const value = values[offset] ?? null;
        const normalized = normalizeForCollation(value, column.collate ?? "BINARY");
        return serializePkComponent(normalized);
      })
      .join("\0");
  }

  private comparePrimaryKeys(left: Row, right: Row): number {
    for (const column of this.primaryKeyColumns()) {
      const key = normalizeColumnName(column.name);
      const leftValue = this.cell(left, key);
      const rightValue = this.cell(right, key);
      const comparison = column.collate
        ? compareWithCollation(leftValue, rightValue, column.collate)
        : compareSql(leftValue, rightValue);
      if (comparison !== 0) return comparison ?? 0;
    }
    return 0;
  }

  private integerPrimaryKeyAlias(): ColumnInfo | undefined {
    if (this.withoutRowid) return undefined;
    const primary = this.columns.filter((column) => column.primaryKey);
    if (primary.length !== 1 || primary[0]!.typeName?.trim().toUpperCase() !== "INTEGER") return undefined;
    return primary[0];
  }

  private allocateRowid(): Rowid {
    if (!this.columns.some((column) => column.autoincrement)) {
      if (this.maximumRowid === undefined) {
        this.maximumRowid = null;
        for (const rowid of this.allRowids()) {
          if (this.maximumRowid === null || compareRowids(rowid, this.maximumRowid) > 0) this.maximumRowid = rowid;
        }
      } else if (this.maximumRowid === null && this.rowCount() > 0) {
        for (const rowid of this.allRowids()) {
          if (this.maximumRowid === null || compareRowids(rowid, this.maximumRowid) > 0) this.maximumRowid = rowid;
        }
      }
      return this.maximumRowid === null ? 1 : incrementRowid(this.maximumRowid);
    }
    const maxSigned = 9223372036854775807n;
    let candidate = canonicalRowid(this.nextRowid);
    while (this.hasRow(candidate)) {
      if (BigInt(candidate) >= maxSigned) {
        throw new SqliteError("database or disk is full", "other", "SQLITE_FULL");
      }
      candidate = incrementRowid(candidate);
    }
    if (BigInt(candidate) > maxSigned) {
      throw new SqliteError("database or disk is full", "other", "SQLITE_FULL");
    }
    return candidate;
  }

  private advanceNextRowid(rowid: Rowid): void {
    if (
      this.maximumRowid === null ||
      (this.maximumRowid !== undefined && compareRowids(rowid, this.maximumRowid) > 0)
    ) {
      this.maximumRowid = rowid;
    }
    if (compareRowids(rowid, this.nextRowid) >= 0) this.nextRowid = incrementRowid(rowid);
  }
}

export function makeColumnInfo(
  name: string,
  typeName: string | null,
  options: Partial<Omit<ColumnInfo, "name" | "nameLower" | "typeName" | "affinity">> = {},
): ColumnInfo {
  return {
    name,
    nameLower: name.toLowerCase(),
    typeName,
    affinity: affinityFromTypeName(typeName),
    notNull: options.notNull ?? false,
    primaryKey: options.primaryKey ?? false,
    autoincrement: options.autoincrement ?? false,
    defaultExpr: options.defaultExpr ?? null,
    unique: options.unique ?? false,
    collate: options.collate ?? null,
    generated: options.generated ?? null,
  };
}

function cloneColumn(column: ColumnInfo): ColumnInfo {
  return {
    ...column,
    nameLower: column.nameLower ?? column.name.toLowerCase(),
    defaultExpr: column.defaultExpr === null ? null : cloneAst(column.defaultExpr),
    generated:
      column.generated === null ? null : { expr: cloneAst(column.generated.expr), stored: column.generated.stored },
  };
}

function cloneAst<T>(value: T): T {
  return structuredClone(value);
}

function isInsertRow(input: InsertRow | RowValues): input is InsertRow {
  return (
    typeof input === "object" && input !== null && !Array.isArray(input) && !(input instanceof Map) && "values" in input
  );
}

function namedFromArray(table: Table, values: readonly SqlValue[]): Map<string, SqlValue> {
  const named = new Map<string, SqlValue>();
  for (let i = 0; i < table.columns.length; i++) {
    named.set(normalizeColumnName(table.columns[i]!.name), values[i] ?? null);
  }
  return named;
}

function asRowid(value: SqlValue, column: string): Rowid {
  if (typeof value === "bigint") return canonicalRowid(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new SqliteError(
    `datatype mismatch for INTEGER PRIMARY KEY column: ${column}`,
    "datatype_mismatch",
    "SQLITE_MISMATCH",
  );
}

function canonicalRowid(value: Rowid): Rowid {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new SqliteError("rowid must be a safe integer or bigint", "datatype_mismatch", "SQLITE_MISMATCH");
    return value;
  }
  if (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)) return Number(value);
  return value;
}

function incrementRowid(value: Rowid): Rowid {
  if (typeof value === "bigint") return value + 1n;
  if (value < Number.MAX_SAFE_INTEGER) return value + 1;
  return BigInt(value) + 1n;
}

function compareRowids(left: Rowid, right: Rowid): number {
  const a = typeof left === "bigint" ? left : BigInt(left);
  const b = typeof right === "bigint" ? right : BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function sameRowid(left: Rowid, right: Rowid): boolean {
  return typeof left === "bigint" || typeof right === "bigint" ? BigInt(left) === BigInt(right) : left === right;
}

function serializePkComponent(value: SqlValue): string {
  if (value === null) return "\0n";
  if (typeof value === "bigint") return `\0b:${value.toString()}`;
  if (typeof value === "number") return `\0i:${value}`;
  if (typeof value === "string") return `\0s:${value}`;
  if (value instanceof Uint8Array) return `\0x:${Array.from(value).join(",")}`;
  return `\0r:${value.value}`;
}

function primaryKeyConflict(tableName: string, columns: ColumnInfo[]): never {
  const qualified = columns.map((column) => `${tableName}.${column.name}`).join(", ");
  throw new SqliteError(`UNIQUE constraint failed: ${qualified}`, "constraint_primary", "SQLITE_CONSTRAINT_PRIMARYKEY");
}
