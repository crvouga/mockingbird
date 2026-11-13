import { ForkMap } from "@crvouga/mockingbird-core";
import type { CreateTriggerStmt, Expr, SelectStmt, Statement } from "../ast/nodes.ts";
import { pgError } from "../errors/error.ts";
import type { Clock } from "../runtime/clock.ts";
import type { Prng } from "../runtime/prng.ts";
import { PG_CATALOG_RELATIONS } from "../schema/catalog.ts";
import { type ColumnType, type Datum, TYPE_OIDS, type TypeId, typeDisplayName } from "../types/value.ts";
import { type CatalogExt, EMPTY_CATALOG_EXT } from "./catalog-ext.ts";
import type { ColumnarSlab } from "./columnar-slab.ts";
import type { CursorData } from "../executor/cursors.ts";
import { gucDef, gucDefaultDisplay, TRANSACTION_GUCS } from "./guc-catalog.ts";
import { currentRole } from "./roles.ts";

// --- table / relation metadata ---------------------------------------------

export interface ColumnMeta {
  name: string;
  /** COMMENT ON COLUMN (pg_description, col_description) */
  comment?: string;
  type: ColumnType;
  notNull: boolean;
  defaultExpr: Expr | null;
  identity: { always: boolean; sequence: string } | null; // sequence = qualified seq key "schema.name"
  generated: Expr | null; // GENERATED ALWAYS AS (...) STORED | VIRTUAL
  /** a VIRTUAL generated column (`pg_attribute.attgenerated = 'v'`); the engine still keeps its value in the row */
  virtual?: true;
  collate: string | null;
  /** resolved domain name when column type came from a domain */
  domain: string | null; // "schema.name"
  /** `pg_attribute.attstorage` override (p/e/x/m); absent = the type's default strategy */
  storage?: "p" | "e" | "x" | "m";
}

export type ConstraintMeta =
  // indexOid links a key constraint to the index that backs it (see schema/index-catalog.ts)
  // comment: COMMENT ON CONSTRAINT (pg_description)
  | { kind: "primary_key"; name: string; columns: string[]; indexOid?: number; comment?: string }
  | { kind: "unique"; name: string; columns: string[]; nullsNotDistinct: boolean; indexOid?: number; comment?: string }
  | { kind: "check"; name: string; expr: Expr; comment?: string }
  | {
      kind: "foreign_key";
      name: string;
      comment?: string;
      columns: string[];
      refSchema: string;
      refTable: string;
      refColumns: string[];
      onDelete: string | null;
      /** `ON DELETE SET NULL (cols)` / `SET DEFAULT (cols)`: the referencing columns the action sets */
      onDeleteColumns?: string[];
      onUpdate: string | null;
      match: "full" | "simple";
      /** `DEFERRABLE`; absent means NOT DEFERRABLE */
      deferrable?: boolean;
      /** `INITIALLY DEFERRED`; only set together with `deferrable` */
      initiallyDeferred?: boolean;
    };

export interface IndexMeta {
  oid?: number;
  name: string;
  schema: string;
  table: string;
  /** oid of the indexed table: the link that survives table and schema renames */
  tableOid?: number;
  unique: boolean;
  comment?: string | null;
  /** false after a failed or interrupted CREATE INDEX CONCURRENTLY / REINDEX CONCURRENTLY */
  valid?: boolean;
  scans?: bigint;
  /** clock time (ms) of the most recent scan counted in `scans` */
  lastScan?: number;
  /** access method (`USING ...`); absent means btree */
  method?: string;
  /** non-key columns of INCLUDE (...) */
  include?: string[];
  /** WITH (...) storage parameters as written, values unquoted */
  options?: Array<{ name: string; value: string }>;
  /** simple column indexes store names; expression indexes store the AST */
  columns: Array<{
    column: string | null;
    expr: Expr | null;
    dir: "asc" | "desc";
    nulls: "first" | "last";
    /** operator class as written, possibly schema-qualified; absent means the default */
    opclass?: string[] | null;
  }>;
  where: Expr | null;
  nullsNotDistinct: boolean;
  /** true when this index backs a constraint (pkey / unique constraint) */
  isConstraint: boolean;
}

export interface TriggerMeta {
  /** COMMENT ON TRIGGER */
  comment?: string;
  constraint?: boolean;
  deferrable?: boolean;
  initiallyDeferred?: boolean;
  name: string;
  timing: "before" | "after" | "instead_of";
  events: CreateTriggerStmt["events"];
  forEachRow: boolean;
  /** `REFERENCING OLD TABLE AS …` name; only on AFTER statement triggers for UPDATE or DELETE */
  oldTable?: string;
  /** `REFERENCING NEW TABLE AS …` name; only on AFTER statement triggers for INSERT or UPDATE */
  newTable?: string;
  when: Expr | null;
  funcSchema: string;
  funcName: string;
  funcArgs: string[];
}

export class TableData {
  /** @internal Optional physical row journal; IDs remain stable across heap splices. */
  durableChanges: ForkMap<number, { row: Datum[] | null; xmin: number }> | null = null;
  durableNextId = 0;
  durableEpoch: object | undefined;
  durableUnsafe = false;
  private durableIds: WeakMap<Datum[], number> | undefined;

  enableDurabilityTracking(ids?: readonly number[], nextId?: number): void {
    if (this.durableChanges && !this.durableUnsafe && !ids) return;
    this.materializeSlab();
    this.durableIds = new WeakMap();
    this.durableChanges = new ForkMap();
    this.durableNextId = nextId ?? this.#rows.length;
    for (let i = 0; i < this.#rows.length; i++) this.durableIds!.set(this.#rows[i]!, ids?.[i] ?? i);
    this.durableEpoch = {};
    this.durableUnsafe = false;
  }

  durableRowId(row: Datum[]): number {
    const id = this.durableIds?.get(row);
    if (id === undefined) throw new Error("Untracked durable row");
    return id;
  }

  disableDurabilityTracking(): void {
    this.durableChanges = null;
    this.durableIds = undefined;
    this.durableEpoch = undefined;
    this.durableUnsafe = false;
  }

  recordDurableRow(row: Datum[], previous?: Datum[]): void {
    if (!this.durableChanges) return;
    const id = (previous && this.durableIds?.get(previous)) ?? this.durableIds?.get(row) ?? this.durableNextId++;
    this.durableIds!.set(row, id);
    this.durableChanges.set(id, { row, xmin: this.rowXmins.get(row) ?? 2 });
  }

  recordDurableDelete(row: Datum[]): void {
    if (this.durableChanges) this.durableChanges.set(this.durableRowId(row), { row: null, xmin: 0 });
  }

  /** @internal Metadata twin with no visits/copies of existing rows or index entries. */
  emptyForDurability(): TableData {
    const copy = new TableData(this.schema, this.name, this.columns, this.oid, this.temp);
    copy.constraints = this.constraints;
    copy.triggers = this.triggers;
    copy.unlogged = this.unlogged;
    copy.onCommit = this.onCommit;
    copy.comment = this.comment;
    return copy;
  }

  /** @internal Serialization/SQL scans must not count as public native-array exposure. */
  serializationRows(): Datum[][] {
    this.materializeSlab();
    return this.materializedRows();
  }

  /** @internal Internal mutable array access, with ordinary public mutableRows kept intact. */
  writeRows(): Datum[][] {
    return this.serializationRows();
  }

  /** @internal Ordinary snapshot branches must not inherit a persistence journal. */
  untrackedFork(): TableData {
    const copy = this.emptyForDurability();
    copy.rowXmins = this.rowXmins;
    copy.slabXmins = this.slabXmins;
    if (this.slab) copy.slab = this.slab;
    else {
      copy.#rows = this.#rows;
      copy.#rowPatches = this.#rowPatches?.fork() ?? null;
      copy.#rowsShared = this.#rowsShared = true;
      copy.tuplesShared = this.tuplesShared = true;
    }
    copy.indexStores = this.indexStores
      ? new Map([...this.indexStores].map(([name, store]) => [name, store.clone()]))
      : null;
    return copy;
  }
  name: string;
  schema: string;
  columns: ColumnMeta[];
  declare rows: Datum[][];
  #rows: Datum[][] = [];
  #rowPatches: ForkMap<number, Datum[]> | null = null;
  #rowsShared = false;
  #rowsExposed = false;
  rowXmins = new WeakMap<Datum[], number>();
  slabXmins: number[] | null = null;
  /** Frozen columnar storage after snapshot hydrate; `rows` stays empty until materialized. */
  slab: ColumnarSlab | null = null;
  constraints: ConstraintMeta[];
  triggers: TriggerMeta[];
  temp: boolean;
  /** UNLOGGED table (`pg_class.relpersistence = 'u'`); catalog metadata only, there is no WAL to skip */
  unlogged = false;
  /** a temporary table's `ON COMMIT DROP` / `ON COMMIT DELETE ROWS`, run when a transaction commits */
  onCommit: "drop" | "delete_rows" | null = null;
  /** COMMENT ON TABLE (pg_description, obj_description) */
  comment: string | undefined;
  /** monotonically increasing oid-like id for catalog output */
  readonly oid: number;
  /** Derived unique/btree index maps; null until built or invalidated. */
  indexStores: Map<string, import("../indexes/index.ts").IndexStore> | null = null;
  /** DML replaces tuples; DDL must detach them before changing cells in place. */
  private tuplesShared = false;

  constructor(schema: string, name: string, columns: ColumnMeta[], oid: number, temp = false) {
    this.schema = schema;
    this.name = name;
    this.columns = columns;
    Object.defineProperty(this, "rows", {
      enumerable: true,
      configurable: true,
      get: this.nativeRows,
      set: this.setNativeRows,
    });
    this.constraints = [];
    this.triggers = [];
    this.temp = temp;
    this.oid = oid;
  }

  rowCount(): number {
    return this.slab ? this.slab.rowCount : this.#rows.length;
  }

  rowAt(index: number): Datum[] {
    if (this.slab) return this.slab.rowAt(index);
    return this.#rowPatches?.get(index) ?? this.#rows[index] ?? [];
  }

  /** Replace an existing tuple without copying the array of unchanged row references. */
  replaceRow(index: number, row: Datum[]): void {
    if (this.durableChanges) this.recordDurableRow(row, this.rowAt(index));
    if (this.#rowPatches) this.#rowPatches.set(index, row);
    else this.#rows[index] = row;
  }

  private materializedRows(): Datum[][] {
    if (this.#rowsShared) this.#rows = this.#rows.slice();
    if (this.#rowPatches) for (const [index, row] of this.#rowPatches) this.#rows[index] = row;
    this.#rowPatches = null;
    this.#rowsShared = false;
    return this.#rows;
  }

  private nativeRows(): Datum[][] {
    if (this.durableChanges) this.durableUnsafe = true;
    this.#rowsExposed = true;
    return this.materializedRows();
  }

  private setNativeRows(rows: Datum[][]): void {
    if (this.durableChanges) this.durableUnsafe = true;
    this.#rows = rows;
    this.#rowPatches = null;
    this.#rowsShared = false;
    this.#rowsExposed = true;
  }

  /** All rows for scans; materializes slab once into `rows` when needed. */
  allRows(): Datum[][] {
    this.materializeSlab();
    return this.rows;
  }

  attachSlab(slab: ColumnarSlab): void {
    this.slab = slab;
    this.#rows = [];
    this.#rowPatches = null;
    this.#rowsShared = false;
  }

  materializeSlab(): void {
    if (!this.slab) return;
    this.#rows = this.slab.materialize();
    if (this.slabXmins)
      this.#rows.forEach((row, index) => {
        this.rowXmins.set(row, this.slabXmins![index] ?? 2);
      });
    this.slabXmins = null;
    this.slab = null;
    this.indexStores = null;
  }

  /** Writable row storage; materializes slab if needed. */
  mutableRows(): Datum[][] {
    this.materializeSlab();
    return this.rows;
  }

  columnIndex(name: string): number {
    return this.columns.findIndex((c) => c.name === name);
  }

  private cloneMetadata(): TableData {
    const t = new TableData(
      this.schema,
      this.name,
      this.columns.map((c) => ({ ...c })),
      this.oid,
      this.temp,
    );
    t.unlogged = this.unlogged;
    t.onCommit = this.onCommit;
    t.comment = this.comment;
    t.durableChanges = this.durableChanges?.fork() ?? null;
    t.durableIds = this.durableIds;
    t.durableNextId = this.durableNextId;
    t.durableEpoch = this.durableEpoch;
    t.durableUnsafe = this.durableUnsafe;
    t.constraints = this.constraints.map((c) => ({ ...c }));
    t.triggers = this.triggers.map((tr) => ({ ...tr }));
    t.indexStores = this.indexStores ? new Map([...this.indexStores].map(([k, v]) => [k, v.clone()])) : null;
    return t;
  }

  clone(): TableData {
    const t = this.cloneMetadata();
    if (t.durableChanges) t.durableUnsafe = true;
    if (this.slab) {
      t.#rows = this.slab.materialize().map((r) => r.slice());
    } else {
      t.#rows = this.materializedRows().map((r) => r.slice());
    }
    t.#rows.forEach((row, index) => {
      const xmin = this.slabXmins?.[index] ?? this.rowXmins.get(this.#rows[index]!);
      if (xmin !== undefined) t.rowXmins.set(row, xmin);
    });
    return t;
  }

  /** DML creates new tuple arrays; retain existing tuples and xmin bindings until DDL. */
  cloneForDml(): TableData {
    // A trigger can return OLD and stamp it with a new xmin, so its tuples need isolation.
    if (this.triggers.length > 0) return this.cloneForWrite();
    const t = this.cloneMetadata();
    t.rowXmins = this.rowXmins;
    if (this.slab) {
      t.#rows = this.slab.materialize();
      if (this.slabXmins) {
        for (let index = 0; index < t.#rows.length; index++)
          t.rowXmins.set(t.#rows[index]!, this.slabXmins[index] ?? 2);
      }
    } else {
      if (this.#rows.length >= 4096 && !this.#rowsExposed) {
        this.#rowPatches ??= new ForkMap();
        t.#rowPatches = this.#rowPatches.fork();
        t.#rows = this.#rows;
        t.#rowsShared = this.#rowsShared = true;
      } else t.#rows = this.materializedRows().slice();
      this.tuplesShared = true;
    }
    t.tuplesShared = true;
    return t;
  }

  /** A live DML fork can be unfrozen while its unchanged tuples still belong to history. */
  ownTuples(): void {
    if (this.durableChanges) this.durableUnsafe = true;
    if (!this.tuplesShared) return;
    const xmins = new WeakMap<Datum[], number>();
    this.rows = this.rows.map((row) => {
      const copy = row.slice();
      const xmin = this.rowXmins.get(row);
      if (xmin !== undefined) xmins.set(copy, xmin);
      return copy;
    });
    this.rowXmins = xmins;
    this.tuplesShared = false;
  }

  /** Independent writable copy (row tuples copied so ALTER COLUMN is isolated). */
  cloneForWrite(): TableData {
    const t = this.clone();
    t.materializeSlab();
    return t;
  }
}

export interface ViewData {
  name: string;
  schema: string;
  query: SelectStmt;
  columns: string[] | null;
  materialized: boolean;
  /** materialized contents; null = WITH NO DATA (not populated) */
  matRows: Datum[][] | null;
  matColumns: Array<{ name: string; type: TypeId }> | null;
  temp: boolean;
  oid: number;
  /** COMMENT ON VIEW / MATERIALIZED VIEW */
  comment?: string;
}

export interface SequenceData {
  /** COMMENT ON (pg_description) */
  comment?: string;
  name: string;
  schema: string;
  increment: bigint;
  minValue: bigint;
  maxValue: bigint;
  startValue: bigint;
  cache: bigint;
  cycle: boolean;
  lastValue: bigint;
  isCalled: boolean;
  ownedBy: { table: string; column: string } | null;
  dataType: TypeId;
  temp: boolean;
  /** UNLOGGED sequence (`pg_class.relpersistence = 'u'`); absent = logged */
  unlogged?: boolean;
  oid: number;
}

export interface EnumData {
  /** COMMENT ON (pg_description) */
  comment?: string;
  name: string;
  schema: string;
  labels: string[];
  oid: number;
}

export interface DomainData {
  /** COMMENT ON (pg_description) */
  comment?: string;
  name: string;
  schema: string;
  baseType: ColumnType;
  notNull: boolean;
  defaultExpr: Expr | null;
  checks: Array<{ name: string; expr: Expr }>;
  oid: number;
}

export interface FunctionData {
  /** COMMENT ON (pg_description) */
  comment?: string;
  /** IMMUTABLE / STABLE; absent means VOLATILE */
  volatility?: "immutable" | "stable";
  settings?: Record<string, string>;
  name: string;
  schema: string;
  argNames: (string | null)[];
  argTypes: TypeId[];
  argDefaults: (Expr | null)[];
  returns: TypeId | null;
  returnsSet: boolean;
  returnsTable: Array<{ name: string; type: TypeId }> | null;
  /** OUT / INOUT parameters: variables of a plpgsql body that make up its result */
  outArgs?: Array<{ name: string; type: TypeId }>;
  /**
   * `p` for a procedure (CREATE PROCEDURE); absent for a function. A procedure's argument lists
   * cover every parameter in call order, OUT ones included (CALL passes a placeholder for them).
   */
  kind?: "p";
  /** a procedure's parameter modes, parallel to argTypes */
  argModes?: Array<"in" | "out" | "inout" | "variadic">;
  language: string;
  body: Statement[] | null;
  rawBody: string | null;
  strict: boolean;
  oid: number;
  /** on an extension's member functions: the installed version when it is not the extension's default */
  extensionVersion?: string;
  jsImpl?: (
    ...args: Array<null | boolean | number | bigint | string | Uint8Array>
  ) => null | boolean | number | bigint | string | Uint8Array;
}

// --- copy-on-write bookkeeping --------------------------------------------------
//
// Snapshots (BEGIN, SAVEPOINT, autocommit statement rollback, PL/pgSQL EXCEPTION blocks, exported
// snapshots) share catalog objects with the live state instead of copying them. Every catalog
// object is stamped with the epoch at which it entered a catalog map (or was copied for writing);
// a state treats an object as shared, and copies it before changing it, when that stamp is older
// than the state's own `cowEpoch`. Taking a snapshot only advances `cowEpoch` — O(1), however big
// the catalog is — and the catalog maps themselves are {@link ForkMap}s, so forking them is O(1)
// and a write copies only the few internal pages it touches (issue #710).

let epochCounter = 0;
/** Epoch at which each catalog object (table, view, sequence, enum, ...) became owned by a live state. */
const bornAt = new WeakMap<object, number>();

function nextEpoch(): number {
  return ++epochCounter;
}

/** Mark `value` as freshly owned: writable in place until the next snapshot of the state holding it. */
function stampOwned(value: object): void {
  bornAt.set(value, epochCounter);
}

/** @internal How many catalog maps were copied entry by entry (a plain Map turned into a fork); tests use it. */
export const catalogCopyStats = { mapsCopied: 0 };

/**
 * A catalog map (one schema's tables, views, sequences, ...): an insertion-ordered map with O(1)
 * forks. A value inserted for the first time is stamped as owned by the state writing it.
 */
export class CatalogMap<V extends object> implements Map<string, V> {
  #map: ForkMap<string, V>;
  /** one derived view of the entries (see {@link derived}), dropped by writes it depends on; forks share it */
  #derived: { build: (map: CatalogMap<V>) => unknown; on: (value: V) => unknown; value: unknown } | null = null;

  constructor(entries?: Iterable<readonly [string, V]>) {
    this.#map = new ForkMap();
    if (entries) for (const [key, value] of entries) this.set(key, value);
  }

  /** O(1) copy: both sides copy-on-write the pages they later change. */
  fork(): CatalogMap<V> {
    const copy = new CatalogMap<V>();
    copy.#map = this.#map.fork();
    copy.#derived = this.#derived;
    return copy;
  }

  /**
   * `build(this)`, computed once until a key is added or deleted, or a value is replaced by one
   * whose `on(value)` differs. Forks share the cached value, so a lookup structure survives
   * snapshots without being rebuilt. `build` should keep keys, not values, which may be replaced.
   */
  derived<R>(build: (map: CatalogMap<V>) => R, on: (value: V) => unknown): R {
    if (this.#derived?.build !== build) this.#derived = { build, on, value: build(this) };
    return this.#derived.value as R;
  }

  /**
   * `map` as a CatalogMap: a plain Map (assigned by a caller) is copied once, without stamping its
   * values, so they stay shared with whatever else holds them.
   */
  static of<V extends object>(map: Map<string, V>): CatalogMap<V> {
    if (map instanceof CatalogMap) return map;
    catalogCopyStats.mapsCopied++;
    const copy = new CatalogMap<V>();
    for (const [key, value] of map) copy.#map.set(key, value);
    return copy;
  }

  get size(): number {
    return this.#map.size;
  }

  get [Symbol.toStringTag](): string {
    return "Map";
  }

  get(key: string): V | undefined {
    return this.#map.get(key);
  }

  has(key: string): boolean {
    return this.#map.has(key);
  }

  set(key: string, value: V): this {
    if (!bornAt.has(value)) stampOwned(value);
    const derived = this.#derived;
    if (derived) {
      const previous = this.#map.get(key);
      if (previous === undefined || derived.on(previous) !== derived.on(value)) this.#derived = null;
    }
    this.#map.set(key, value);
    return this;
  }

  delete(key: string): boolean {
    this.#derived = null;
    return this.#map.delete(key);
  }

  clear(): void {
    this.#derived = null;
    this.#map.clear();
  }

  entries(): MapIterator<[string, V]> {
    return this.#map.entries();
  }

  keys(): MapIterator<string> {
    return this.#map.keys();
  }

  values(): MapIterator<V> {
    return this.#map.values();
  }

  [Symbol.iterator](): MapIterator<[string, V]> {
    return this.#map.entries();
  }

  forEach(callback: (value: V, key: string, map: Map<string, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#map) callback.call(thisArg, value, key, this);
  }
}

/** A schema's index names grouped by table name, in creation order. */
function indexNamesByTable(indexes: Map<string, IndexMeta>): Map<string, string[]> {
  const byTable = new Map<string, string[]>();
  for (const [name, index] of indexes) {
    const list = byTable.get(index.table);
    if (list) list.push(name);
    else byTable.set(index.table, [name]);
  }
  return byTable;
}

const indexTable = (index: IndexMeta): string => index.table;

const NO_INDEXES: readonly IndexMeta[] = Object.freeze([]);

/** A state-level map (prepared statements, currval, stats, host functions) as a forkable map. */
function forkable<K extends string | number, V>(map: Map<K, V>): ForkMap<K, V> {
  if (map instanceof ForkMap) return map;
  catalogCopyStats.mapsCopied++;
  return new ForkMap(map);
}

export class SchemaData {
  name: string;
  tables: Map<string, TableData> = new CatalogMap<TableData>();
  views: Map<string, ViewData> = new CatalogMap<ViewData>();
  sequences: Map<string, SequenceData> = new CatalogMap<SequenceData>();
  enums: Map<string, EnumData> = new CatalogMap<EnumData>();
  domains: Map<string, DomainData> = new CatalogMap<DomainData>();
  functions: Map<string, FunctionData[]> = new CatalogMap<FunctionData[]>();
  indexes: Map<string, IndexMeta> = new CatalogMap<IndexMeta>();
  oid: number;

  constructor(name: string, oid: number) {
    this.name = name;
    this.oid = oid;
  }

  /**
   * The indexes on table `table`, in creation order, without scanning the whole schema: the
   * grouping is cached until the schema's index map next changes (writes look this up per row).
   */
  indexesOn(table: string): readonly IndexMeta[] {
    const indexes = this.indexes;
    const names = (
      indexes instanceof CatalogMap ? indexes.derived(indexNamesByTable, indexTable) : indexNamesByTable(indexes)
    ).get(table);
    return names ? names.map((name) => indexes.get(name)!) : NO_INDEXES;
  }

  /** all relation names (tables, views, sequences, indexes share pg_class namespace) */
  hasRelation(name: string): boolean {
    return this.tables.has(name) || this.views.has(name) || this.sequences.has(name) || this.indexes.has(name);
  }

  clone(): SchemaData {
    const s = new SchemaData(this.name, this.oid);
    for (const [k, v] of this.tables) s.tables.set(k, v.clone());
    for (const [k, v] of this.views) {
      s.views.set(k, {
        ...v,
        matRows: v.matRows ? v.matRows.map((r) => r.slice()) : null,
        matColumns: v.matColumns ? v.matColumns.map((c) => ({ ...c })) : null,
      });
    }
    for (const [k, v] of this.sequences) s.sequences.set(k, { ...v });
    for (const [k, v] of this.enums) s.enums.set(k, { ...v, labels: v.labels.slice() });
    for (const [k, v] of this.domains) s.domains.set(k, { ...v, checks: v.checks.map((c) => ({ ...c })) });
    for (const [k, v] of this.functions)
      s.functions.set(
        k,
        v.map((f) => ({ ...f })),
      );
    for (const [k, v] of this.indexes) s.indexes.set(k, { ...v, columns: v.columns.map((c) => ({ ...c })) });
    return s;
  }

  /**
   * Share every catalog object and fork the maps, so CREATE/DROP on either side stays isolated.
   * O(1) per map: neither side copies anything until it writes. Overload lists are shared too;
   * writers replace a list (`functions.set(name, [...])`) rather than changing it in place.
   */
  cloneShallow(): SchemaData {
    // every field is assigned below: skip the constructor's empty maps
    const s = Object.create(SchemaData.prototype) as SchemaData;
    s.name = this.name;
    s.oid = this.oid;
    s.tables = (this.tables = CatalogMap.of(this.tables)).fork();
    s.views = (this.views = CatalogMap.of(this.views)).fork();
    s.sequences = (this.sequences = CatalogMap.of(this.sequences)).fork();
    s.enums = (this.enums = CatalogMap.of(this.enums)).fork();
    s.domains = (this.domains = CatalogMap.of(this.domains)).fork();
    s.functions = (this.functions = CatalogMap.of(this.functions)).fork();
    s.indexes = (this.indexes = CatalogMap.of(this.indexes)).fork();
    return s;
  }
}

/** One advisory lock key held by the session: its tag and its session- and transaction-level counts per mode. */
export interface AdvisoryLockHold {
  readonly key: AdvisoryLockKey;
  exclusive: { session: number; xact: number };
  share: { session: number; xact: number };
}

/** pg_locks' tag of an advisory lock: a bigint key splits into classid / objid with objsubid 1; (int4, int4) is objsubid 2. */
export interface AdvisoryLockKey {
  readonly classid: number;
  readonly objid: number;
  readonly objsubid: 1 | 2;
}

/** ANALYZE bookkeeping for pg_stat_user_tables, keyed by table oid in {@link DatabaseState.tableStats}. */
export interface TableStats {
  analyzeCount: number;
  /** clock time (ms) of the most recent ANALYZE */
  lastAnalyze: number;
}

/** One-shot failure presets armed by tests (`Database.fault`). */
export interface EngineFaults {
  /** SQLSTATE raised by the next concurrent index build, which leaves its index invalid. */
  concurrentIndexBuild?: string;
}

export interface PreparedStatement {
  name: string;
  argTypes: TypeId[] | null;
  stmt: Statement;
}

// --- database state -----------------------------------------------------------

/** Set while {@link DatabaseState.cloneShallow} constructs its clone, which it fills in itself. */
let constructingClone = false;

export class DatabaseState {
  schemas = new Map<string, SchemaData>();
  settings = new Map<string, string>();
  /** SET LOCAL values, cleared on COMMIT/ROLLBACK */
  localSettings = new Map<string, string>();
  /**
   * What `RESET` and `SET ... TO DEFAULT` return to, over the built-in defaults: the settings a
   * wire session started with. Belongs to the session executing, so clones do not carry it.
   */
  settingDefaults: ReadonlyMap<string, string> | null = null;
  /**
   * Host functions registered under `pg_catalog`: found ahead of the search path, the way
   * PostgreSQL finds its own functions whatever `search_path` says. Copied to clones, not encoded.
   */
  systemFunctions: Map<string, FunctionData[]> = new ForkMap();
  prepared: Map<string, PreparedStatement> = new ForkMap();
  prng: Prng;
  clock: Clock;
  changes = 0;
  private oidCounter = 16384;
  /** Local monotonic xid allocator; 2 denotes a row from a legacy snapshot without metadata. */
  xidCounter = 3;
  transactionXid: number | null = null;
  /** The client's statement text being executed (current_query()); not cloned, encoded or rolled back. */
  currentQuery: string | null = null;
  /**
   * The session's advisory locks (pg_advisory_lock and friends) on the engine on its own; the wire
   * server keeps them in its cluster instead. Like PostgreSQL's lock table, they are not rolled back:
   * {@link restoreFrom} leaves them alone, and transaction-level ones are released at COMMIT / ROLLBACK.
   */
  advisoryLocks: Map<string, AdvisoryLockHold> = new Map();
  /** Start of the open transaction block (now() / transaction_timestamp()): PG-epoch UTC micros; set by its first statement. */
  transactionStart: bigint | null = null;
  /**
   * The running top-level statement's statement_timeout deadline (`performance.now()` ms), null when
   * none applies. Checked cooperatively by {@link checkStatementTimeout}.
   */
  statementDeadline: number | null = null;
  /** Counts {@link checkStatementTimeout} calls between clock reads. */
  deadlineTicks = 0;

  allocateXid(): number {
    if (this.xidCounter > 4294967295)
      throw pgError("program_limit_exceeded", "transaction ID space exhausted; xid wraparound is not modeled", "54000");
    return this.xidCounter++;
  }
  inTransaction = false;
  /**
   * Whether a temporary table `ON COMMIT DROP` / `DELETE ROWS` may exist: only then does a commit look
   * for one. Set when such a table is created and never cleared, so it can only err towards looking.
   */
  mayHaveOnCommitActions = false;
  /** Transaction-only events: included in rollback clones, never in exported snapshots. */
  pendingTriggers: Array<{
    schema: string;
    table: string;
    trigger: string;
    event: "insert" | "update" | "delete";
    oldRow: Datum[] | null;
    newRow: Datum[] | null;
  }> = [];
  constraintModes = new Map<string, boolean>();
  /**
   * Foreign keys whose check is deferred to COMMIT (or SET CONSTRAINTS ... IMMEDIATE): the referencing
   * table and constraint, and which side's change queued it (it picks the error message).
   */
  pendingForeignKeys: Array<{
    schema: string;
    table: string;
    constraint: string;
    side: "referencing" | "referenced";
    /** for `side: "referenced"`: the referenced table whose row was updated or deleted */
    referenced?: string;
  }> = [];
  /** most recent sequence touched by nextval/setval, for lastval() */
  lastSequence: { schema: string; name: string } | null = null;
  /** Session currval per sequence; absent entry means currval is undefined. */
  sequenceCurrval: Map<string, bigint> = new ForkMap();
  /** Per-table ANALYZE bookkeeping, keyed by table oid. */
  tableStats: Map<number, TableStats> = new ForkMap();
  /**
   * Catalog objects stamped before this epoch may be shared with a snapshot: they are copied
   * before being changed (see `ensureWritable*`). Advancing it is how a snapshot is taken.
   */
  private cowEpoch = nextEpoch();
  /** `cowEpoch` never drops below this: set by snapshots that are never released. */
  private cowFloor = 0;
  /** Epochs of the released-later snapshots still alive (ascending). */
  private cowHolds: number[] = [];
  /** Armed failure presets. Not part of snapshots, clones or transaction rollback. */
  faults: EngineFaults = {};
  /**
   * Roles, privileges, composite types, event triggers, partitioning and row-level security
   * (issue #692): one immutable value, replaced on every change, so clones and rollback copy it by reference.
   */
  catalogExt: CatalogExt = EMPTY_CATALOG_EXT;
  /** Open SQL cursors of this session (`DECLARE`); session state, never part of a snapshot. */
  cursors = new Map<string, CursorData>();

  constructor(prng: Prng, clock: Clock) {
    this.prng = prng;
    this.clock = clock;
    // cloneShallow assigns every field itself
    if (constructingClone) return;
    this.schemas.set("public", new SchemaData("public", this.nextOid()));
    this.settings.set("timezone", "UTC");
    this.settings.set("search_path", '"$user", public');
    this.settings.set("datestyle", "ISO, MDY");
    this.settings.set("intervalstyle", "postgres");
    this.settings.set("bytea_output", "hex");
    this.settings.set("standard_conforming_strings", "on");
    this.settings.set("client_encoding", "UTF8");
    this.settings.set("server_encoding", "UTF8");
    this.settings.set("integer_datetimes", "on");
    this.settings.set("transaction_isolation", "read committed");
    this.settings.set("application_name", "");
    this.settings.set("extra_float_digits", "1");
    this.settings.set("client_min_messages", "notice");
    this.settings.set("max_identifier_length", "63");
    this.settings.set("server_version", "18.3");
    this.settings.set("server_version_num", "180003");
    this.settings.set("lc_messages", "C");
    this.settings.set("lc_monetary", "C");
    this.settings.set("lc_numeric", "C");
    this.settings.set("lc_time", "C");
    this.settings.set("default_transaction_isolation", "read committed");
    this.settings.set("lock_timeout", "0");
    this.settings.set("idle_in_transaction_session_timeout", "0");
    this.settings.set("transaction_timeout", "0");
    this.settings.set("statement_timeout", "0");
    this.settings.set("check_function_bodies", "on");
    this.settings.set("xmloption", "content");
    this.settings.set("row_security", "on");
    this.settings.set("array_nulls", "on");
    this.settings.set("backslash_quote", "safe_encoding");
    this.settings.set("default_tablespace", "");
    this.settings.set("default_table_access_method", "heap");
  }

  nextOid(): number {
    return this.oidCounter++;
  }

  getSetting(name: string): string | undefined {
    // is_superuser is derived from the current role (it follows SET ROLE); PostgreSQL keeps it out of SHOW ALL
    if (name === "is_superuser") return currentRole(this).superuser ? "on" : "off";
    const local = this.localSettings.get(name);
    if (local !== undefined) return local;
    // transaction_read_only and the like: outside a transaction block, each statement's own transaction
    const transactionDefault = TRANSACTION_GUCS.get(name);
    if (transactionDefault !== undefined) return this.getSetting(transactionDefault);
    const value = this.settings.get(name);
    if (value !== undefined) return value;
    const def = gucDef(name);
    return def ? gucDefaultDisplay(def) : undefined;
  }

  /** effective search path: existing schemas from search_path setting */
  effectiveSearchPath(): string[] {
    const raw = this.getSetting("search_path") ?? "public";
    const parts = raw
      .split(",")
      .map((p) => p.trim())
      .map((p) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p))
      .filter((p) => p.length > 0);
    const out: string[] = [];
    for (const p of parts) {
      const name = p === "$user" ? "postgres" : p;
      if (this.schemas.has(name)) out.push(name);
    }
    return out;
  }

  currentSchema(): string {
    const path = this.effectiveSearchPath();
    return path[0] ?? "public";
  }

  getSchema(name: string): SchemaData {
    const s = this.schemas.get(name);
    if (!s) throw pgError("undefined_object", `schema "${name}" does not exist`, "3F000");
    return s;
  }

  /** Resolve a possibly-qualified relation name to its schema. */
  /**
   * `pg_temp.x` (and `pg_temp_N.x`) names the session's temporary relation `x`. The engine keeps a
   * temporary relation in the schema it was created in, flagged temporary: this finds that schema.
   */
  private resolveTempSchema(parts: string[]): string[] {
    if (parts.length < 2) return parts;
    const schema = parts[parts.length - 2]!;
    if (!/^pg_temp(_\d+)?$/.test(schema) || this.schemas.has(schema)) return parts;
    const name = parts[parts.length - 1]!;
    for (const data of this.schemas.values()) {
      const relation = data.tables.get(name) ?? data.views.get(name) ?? data.sequences.get(name);
      const index = data.indexes.get(name);
      const temp = relation?.temp === true || (index !== undefined && data.tables.get(index.table)?.temp === true);
      if (temp) return [data.name, name];
    }
    return parts;
  }

  resolveRelationSchema(parts: string[]): { schema: string; name: string } | null {
    parts = this.resolveTempSchema(parts);
    if (parts.length === 2) {
      const [schema, name] = parts as [string, string];
      return { schema, name };
    }
    if (parts.length === 3) {
      // database.schema.name — database must match
      const [, schema, name] = parts as [string, string, string];
      return { schema, name };
    }
    const name = parts[0]!;
    for (const schema of ["pg_catalog", ...this.effectiveSearchPath()]) {
      if (schema === "pg_catalog" && PG_CATALOG_RELATIONS.has(name)) return { schema, name };
      const s = this.schemas.get(schema);
      if (s?.hasRelation(name)) return { schema, name };
    }
    return null;
  }

  findTable(parts: string[]): TableData | null {
    parts = this.resolveTempSchema(parts);
    if (parts.length >= 2) {
      const schema = parts[parts.length - 2]!;
      const name = parts[parts.length - 1]!;
      return this.schemas.get(schema)?.tables.get(name) ?? null;
    }
    const name = parts[0]!;
    for (const schema of this.effectiveSearchPath()) {
      const t = this.schemas.get(schema)?.tables.get(name);
      if (t) return t;
    }
    return null;
  }

  requireTable(parts: string[]): TableData {
    const t = this.findTable(parts);
    if (!t) {
      throw pgError("undefined_table", `relation "${parts.join(".")}" does not exist`);
    }
    return t;
  }

  findView(parts: string[]): ViewData | null {
    parts = this.resolveTempSchema(parts);
    if (parts.length >= 2) {
      const schema = parts[parts.length - 2]!;
      const name = parts[parts.length - 1]!;
      return this.schemas.get(schema)?.views.get(name) ?? null;
    }
    const name = parts[0]!;
    for (const schema of this.effectiveSearchPath()) {
      const v = this.schemas.get(schema)?.views.get(name);
      if (v) return v;
    }
    return null;
  }

  findSequence(parts: string[]): SequenceData | null {
    parts = this.resolveTempSchema(parts);
    if (parts.length >= 2) {
      const schema = parts[parts.length - 2]!;
      const name = parts[parts.length - 1]!;
      return this.schemas.get(schema)?.sequences.get(name) ?? null;
    }
    const name = parts[0]!;
    for (const schema of this.effectiveSearchPath()) {
      const s = this.schemas.get(schema)?.sequences.get(name);
      if (s) return s;
    }
    return null;
  }

  findEnum(parts: string[]): EnumData | null {
    if (parts.length >= 2) {
      const schema = parts[parts.length - 2]!;
      const name = parts[parts.length - 1]!;
      return this.schemas.get(schema)?.enums.get(name) ?? null;
    }
    const name = parts[0]!;
    for (const schema of ["pg_catalog", ...this.effectiveSearchPath()]) {
      const e = this.schemas.get(schema)?.enums.get(name);
      if (e) return e;
    }
    return null;
  }

  findDomain(parts: string[]): DomainData | null {
    if (parts.length >= 2) {
      const schema = parts[parts.length - 2]!;
      const name = parts[parts.length - 1]!;
      return this.schemas.get(schema)?.domains.get(name) ?? null;
    }
    const name = parts[0]!;
    for (const schema of ["pg_catalog", ...this.effectiveSearchPath()]) {
      const d = this.schemas.get(schema)?.domains.get(name);
      if (d) return d;
    }
    return null;
  }

  findFunctions(parts: string[]): FunctionData[] {
    if (parts.length >= 2) {
      const schema = parts[parts.length - 2]!;
      const name = parts[parts.length - 1]!;
      if (schema === "pg_catalog") return this.systemFunctions.get(name) ?? [];
      return this.schemas.get(schema)?.functions.get(name) ?? [];
    }
    const name = parts[0]!;
    const out: FunctionData[] = [...(this.systemFunctions.get(name) ?? [])];
    for (const schema of this.effectiveSearchPath()) {
      const fns = this.schemas.get(schema)?.functions.get(name);
      if (fns) out.push(...fns);
    }
    return out;
  }

  findEnumByKey(key: string): EnumData | null {
    const dot = key.indexOf(".");
    if (dot === -1) return this.findEnum([key]);
    return this.schemas.get(key.slice(0, dot))?.enums.get(key.slice(dot + 1)) ?? null;
  }

  /** format_type()-style display name for a type OID (builtin or enum). */
  typeNameForOid(oid: number): string | null {
    for (const [name, o] of Object.entries(TYPE_OIDS)) {
      if (o === oid) return typeDisplayName(name);
    }
    for (const schema of this.schemas.values()) {
      for (const e of schema.enums.values()) {
        if (e.oid === oid) return e.name;
      }
    }
    return null;
  }

  /** deep clone (datums are immutable; rows copied) */
  clone(): DatabaseState {
    const s = new DatabaseState(this.prng, this.clock);
    s.schemas = new Map();
    for (const [k, v] of this.schemas) s.schemas.set(k, v.clone());
    s.settings = new Map(this.settings);
    s.localSettings = new Map(this.localSettings);
    s.prepared = new Map(this.prepared);
    s.changes = this.changes;
    s.inTransaction = this.inTransaction;
    s.mayHaveOnCommitActions = this.mayHaveOnCommitActions;
    s.pendingTriggers = this.pendingTriggers.slice();
    s.constraintModes = new Map(this.constraintModes);
    s.pendingForeignKeys = this.pendingForeignKeys.slice();
    s.lastSequence = this.lastSequence ? { ...this.lastSequence } : null;
    s.sequenceCurrval = new Map(this.sequenceCurrval);
    s.tableStats = new Map(this.tableStats);
    s.catalogExt = this.catalogExt;
    s.oidCounter = this.oidCounter;
    s.xidCounter = this.xidCounter;
    s.transactionXid = this.transactionXid;
    s.transactionStart = this.transactionStart;
    for (const [name, overloads] of this.systemFunctions) s.systemFunctions.set(name, overloads.slice());
    return s;
  }

  /**
   * Share catalog objects and fork every map, so CREATE/DROP on either side stays isolated. O(number
   * of schemas): no catalog map is copied. Callers take {@link freezeShared} or
   * {@link holdForRollback} first, so this state copies a shared object before changing it; the
   * clone starts with everything shared.
   */
  cloneShallow(): DatabaseState {
    constructingClone = true;
    let s: DatabaseState;
    try {
      s = new DatabaseState(this.prng, this.clock);
    } finally {
      constructingClone = false;
    }
    s.schemas = new Map();
    for (const [k, v] of this.schemas) s.schemas.set(k, v.cloneShallow());
    s.settings = new Map(this.settings);
    s.localSettings = new Map(this.localSettings);
    s.prepared = (this.prepared = forkable(this.prepared)).fork();
    s.changes = this.changes;
    s.inTransaction = this.inTransaction;
    s.mayHaveOnCommitActions = this.mayHaveOnCommitActions;
    s.pendingTriggers = this.pendingTriggers.slice();
    s.constraintModes = new Map(this.constraintModes);
    s.pendingForeignKeys = this.pendingForeignKeys.slice();
    s.lastSequence = this.lastSequence ? { ...this.lastSequence } : null;
    s.sequenceCurrval = (this.sequenceCurrval = forkable(this.sequenceCurrval)).fork();
    s.tableStats = (this.tableStats = forkable(this.tableStats)).fork();
    s.catalogExt = this.catalogExt;
    s.oidCounter = this.oidCounter;
    s.xidCounter = this.xidCounter;
    s.transactionXid = this.transactionXid;
    s.transactionStart = this.transactionStart;
    // overload lists are replaced, never changed in place, so the clone shares them
    s.systemFunctions = (this.systemFunctions = forkable(this.systemFunctions)).fork();
    s.cowFloor = s.cowEpoch = nextEpoch();
    return s;
  }

  /** Whether `object` may be shared with a snapshot, so it must be copied before it is changed. */
  isShared(object: object): boolean {
    return (bornAt.get(object) ?? -1) < this.cowEpoch;
  }

  /**
   * Share every catalog object with snapshots taken from now on, for good (exported snapshots,
   * durable checkpoints): an object is copied before its first change after this. O(1).
   */
  freezeShared(): void {
    this.cowFloor = this.cowEpoch = nextEpoch();
  }

  /**
   * Share every catalog object with a rollback snapshot (BEGIN, SAVEPOINT, a statement's or an
   * EXCEPTION block's implicit savepoint) and return that snapshot. O(number of schemas). Pass the
   * returned epoch to {@link releaseHold} once the snapshot is discarded or restored, so objects
   * nothing else shares become writable in place again.
   */
  holdForRollback(): { state: DatabaseState; epoch: number } {
    const epoch = nextEpoch();
    this.cowEpoch = epoch;
    this.cowHolds.push(epoch);
    return { state: this.cloneShallow(), epoch };
  }

  /** The snapshot taken at `epoch` by {@link holdForRollback} is gone. */
  releaseHold(epoch: number): void {
    const at = this.cowHolds.lastIndexOf(epoch);
    if (at === -1) return;
    this.cowHolds.splice(at, 1);
    // Objects stamped before a live hold's epoch are in its snapshot; the floor guards permanent ones.
    this.cowEpoch = Math.max(this.cowFloor, this.cowHolds[this.cowHolds.length - 1] ?? 0);
  }

  /** @internal Tests: epochs of rollback snapshots still held. */
  heldSnapshots(): number {
    return this.cowHolds.length;
  }

  private owned<T extends object>(copy: T): T {
    stampOwned(copy);
    return copy;
  }

  ensureWritableTable(table: TableData): TableData {
    if (!this.isShared(table)) {
      table.ownTuples();
      return table;
    }
    const schema = this.schemas.get(table.schema);
    const copy = this.owned(table.cloneForWrite());
    schema?.tables.set(table.name, copy);
    return copy;
  }

  ensureWritableTableForDml(table: TableData): TableData {
    if (!this.isShared(table)) return table;
    const copy = this.owned(table.cloneForDml());
    this.schemas.get(table.schema)?.tables.set(table.name, copy);
    return copy;
  }

  ensureWritableSequence(seq: SequenceData): SequenceData {
    if (!this.isShared(seq)) return seq;
    const schema = this.schemas.get(seq.schema);
    const copy: SequenceData = this.owned({ ...seq });
    schema?.sequences.set(seq.name, copy);
    return copy;
  }

  ensureWritableView(view: ViewData): ViewData {
    if (!this.isShared(view)) return view;
    const schema = this.schemas.get(view.schema);
    const copy: ViewData = this.owned({
      ...view,
      matRows: view.matRows ? view.matRows.map((r) => r.slice()) : null,
      matColumns: view.matColumns ? view.matColumns.map((c) => ({ ...c })) : null,
    });
    schema?.views.set(view.name, copy);
    return copy;
  }

  ensureWritableEnum(en: EnumData): EnumData {
    if (!this.isShared(en)) return en;
    const schema = this.schemas.get(en.schema);
    const copy: EnumData = this.owned({ ...en, labels: en.labels.slice() });
    schema?.enums.set(en.name, copy);
    return copy;
  }

  /**
   * Copy the contents of `other` into this state (rollback restore). `other`'s objects may be shared
   * with anything (an exported snapshot, another database), so they are all treated as shared from
   * now on — except when `other` is this state's own {@link holdForRollback} snapshot whose hold is
   * still alive (`fromHold`), which already protects them until it is released.
   */
  restoreFrom(other: DatabaseState, fromHold = false): void {
    if (!fromHold) this.freezeShared();
    this.schemas = other.schemas;
    this.settings = other.settings;
    this.localSettings = other.localSettings;
    this.prepared = other.prepared;
    this.pendingTriggers = other.pendingTriggers.slice();
    this.constraintModes = new Map(other.constraintModes);
    this.pendingForeignKeys = other.pendingForeignKeys.slice();
    this.changes = other.changes;
    this.lastSequence = other.lastSequence;
    this.sequenceCurrval = other.sequenceCurrval;
    this.tableStats = other.tableStats;
    this.catalogExt = other.catalogExt;
    this.oidCounter = other.oidCounter;
    this.xidCounter = Math.max(this.xidCounter, other.xidCounter);
    this.transactionXid = other.transactionXid;
    this.transactionStart = other.transactionStart;
  }

  /** @internal Snapshot codec access to the oid allocator. */
  snapshotOidCounter(): number {
    return this.oidCounter;
  }

  /** @internal Snapshot codec restore of the oid allocator. */
  restoreOidCounter(value: number): void {
    this.oidCounter = value;
  }
}
