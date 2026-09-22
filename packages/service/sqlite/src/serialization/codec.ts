import type { Expr, TableConstraint } from "../ast/nodes.ts";
import { SqliteError } from "../errors/index.ts";
import { IndexStore, serializeIndexEntry } from "../indexes/index.ts";
import {
  ColumnarSlab,
  PACK_BLOB,
  PACK_F64,
  PACK_I32,
  PACK_I64,
  PACK_NULL,
  PACK_TAGGED,
  PACK_TEXT_INLINE,
  PACK_TEXT_INTERN,
  packKindOf,
  prepareSlabColumn,
  type SlabColumn,
} from "../storage/columnar-slab.ts";
import { DatabaseState, type IndexInfo, type ViewInfo } from "../storage/database-state.ts";
import type { Row, Rowid } from "../storage/row.ts";
import { type ColumnInfo, Table } from "../storage/table.ts";
import { asSqlReal, SqlJsonText, SqlReal, type SqlValue, utf8Encode } from "../types/value.ts";
import {
  InternPool,
  Reader,
  readBjv,
  readInternTable,
  readVarintU32,
  Writer,
  writeBjv,
  writeInternTable,
  writeVarintU32,
} from "./wire.ts";

const MAGIC = utf8Encode("SQLM");
/** SQLM v5: adaptive intern, BJV schema, columnar slab hydrate, binary index keys. */
const VERSION = 5;

/** PRNG + clock captured alongside schema/rows. */
export interface SnapshotRuntime {
  prngState: bigint;
  nowMs: number;
}

/** Result of {@link decodeDatabaseState}. */
export interface DecodedSnapshot {
  state: DatabaseState;
  runtime: SnapshotRuntime;
}

const AFFINITIES: Array<import("../types/value.ts").Affinity> = ["TEXT", "NUMERIC", "INTEGER", "REAL", "BLOB"];

/**
 * Encode catalog, rows, and runtime into a sqlite-mem snapshot blob (not a `.sqlite` file).
 */
export function encodeDatabaseState(state: DatabaseState, runtime: SnapshotRuntime): Uint8Array {
  const pool = new InternPool();
  const tables = sortedValues(state.tables);
  const views = sortedValues(state.views);
  const indexes = sortedValues(state.indexes);
  const tableRows: Row[][] = [];

  for (const table of tables) {
    pool.count(table.name);
    pool.count(table.originalSql ?? "");
    for (const column of table.columns) {
      pool.count(column.name);
      pool.count(column.typeName ?? "");
      pool.count(column.collate ?? "");
    }
    for (const name of table.indexes) pool.count(name);
    const rows = table.sortedRows();
    tableRows.push(rows);
    for (const row of rows) {
      for (const value of row.values) {
        if (typeof value === "string") pool.count(value);
        else if (value instanceof SqlJsonText) pool.count(value.value);
      }
    }
  }
  for (const view of views) pool.count(JSON.stringify(view));
  for (const index of indexes) pool.count(index.name);
  pool.finalize();
  forceSchemaIntern(pool, tables, views, indexes);

  const internId = (s: string): number => pool.id(s);
  const forceId = (s: string): number => pool.forceId(s);

  const w = new Writer(64 * 1024);
  w.raw(MAGIC);
  w.u32(VERSION);
  w.u8(state.foreignKeysEnabled ? 1 : 0);
  w.u32(state.schemaVersion);
  w.u32(state.changes);
  w.u32(state.totalChanges);
  writeTaggedValue(w, state.lastInsertRowid, internId);
  writeInternTable(w, pool.list);

  writeVarintU32(w, tables.length);
  for (let t = 0; t < tables.length; t++) {
    const table = tables[t]!;
    writeVarintU32(w, forceId(table.name));
    writeVarintU32(w, table.columns.length);
    for (const column of table.columns) {
      writeVarintU32(w, forceId(column.name));
      writeVarintU32(w, forceId(column.typeName ?? ""));
      const aff = AFFINITIES.indexOf(column.affinity);
      w.u8(aff < 0 ? 2 : aff);
      w.u8(
        (column.notNull ? 1 : 0) |
          (column.primaryKey ? 2 : 0) |
          (column.autoincrement ? 4 : 0) |
          (column.unique ? 8 : 0),
      );
      writeVarintU32(w, forceId(column.collate ?? ""));
      if (column.defaultExpr) {
        w.u8(1);
        writeBjv(w, column.defaultExpr, forceId);
      } else w.u8(0);
      if (column.generated) {
        w.u8(1);
        writeBjv(w, column.generated, forceId);
      } else w.u8(0);
    }
    writeBjv(w, table.constraints, forceId);
    writeVarintU32(w, forceId(table.originalSql ?? ""));
    w.u8((table.withoutRowid ? 1 : 0) | (table.strict ? 2 : 0));
    const indexNames = [...table.indexes].sort(compareNames);
    writeVarintU32(w, indexNames.length);
    for (const name of indexNames) writeVarintU32(w, forceId(name));
    writeTaggedValue(w, table.nextRowid, internId);
    const rows = tableRows[t]!;
    writeVarintU32(w, rows.length);
    for (const row of rows) writeTaggedValue(w, row.rowid, internId);
    for (let c = 0; c < table.columns.length; c++) writePackedColumn(w, rows, c, internId);
  }

  writeVarintU32(w, views.length);
  for (const view of views) writeBjv(w, view, forceId);

  writeVarintU32(w, indexes.length);
  for (const index of indexes) {
    writeBjv(
      w,
      {
        name: index.name,
        tableName: index.tableName,
        unique: index.unique,
        columns: index.columns,
        where: index.where,
        originalSql: index.originalSql,
      },
      forceId,
    );
  }
  for (const index of indexes) writeIndexStoreBinary(w, index.store, internId);

  w.u64(runtime.prngState);
  w.i64(BigInt(Math.trunc(runtime.nowMs)));
  return w.finish();
}

/**
 * Decode a blob from {@link encodeDatabaseState} / {@link Database.snapshot}.
 */
export function decodeDatabaseState(snapshot: Uint8Array): DecodedSnapshot {
  try {
    return decodeInner(snapshot);
  } catch (error) {
    if (error instanceof SqliteError) throw error;
    throw new SqliteError("invalid or truncated sqlite-mem snapshot", "other");
  }
}

function decodeInner(snapshot: Uint8Array): DecodedSnapshot {
  const r = new Reader(snapshot);
  const magic = r.raw(4);
  if (!magic.every((byte, index) => byte === MAGIC[index]))
    throw new SqliteError("invalid sqlite-mem snapshot magic", "other");
  const version = r.u32();
  if (version !== VERSION) {
    throw new SqliteError(`unsupported sqlite-mem snapshot version: ${version}`, "snapshot_version", "SQLITE_FORMAT");
  }

  const state = new DatabaseState();
  state.foreignKeysEnabled = r.u8() !== 0;
  state.schemaVersion = r.u32();
  state.changes = r.u32();
  state.totalChanges = r.u32();
  state.lastInsertRowid = asRowid(readTaggedValue(r, []));
  const intern = readInternTable(r);
  const str = (id: number): string => intern[id] ?? "";

  const tableCount = readVarintU32(r);
  for (let t = 0; t < tableCount; t++) {
    const name = str(readVarintU32(r));
    const colCount = readVarintU32(r);
    const columns: ColumnInfo[] = [];
    for (let c = 0; c < colCount; c++) {
      const colName = str(readVarintU32(r));
      const typeName = str(readVarintU32(r)) || null;
      const affIndex = r.u8();
      const flags = r.u8();
      const collate = str(readVarintU32(r)) || null;
      const hasDefault = r.u8() === 1;
      const defaultExpr = hasDefault ? (readBjv(r, intern) as Expr) : null;
      const hasGenerated = r.u8() === 1;
      const generated = hasGenerated ? (readBjv(r, intern) as ColumnInfo["generated"]) : null;
      columns.push({
        name: colName,
        nameLower: colName.toLowerCase(),
        typeName,
        affinity: AFFINITIES[affIndex] ?? "NUMERIC",
        notNull: (flags & 1) !== 0,
        primaryKey: (flags & 2) !== 0,
        autoincrement: (flags & 4) !== 0,
        unique: (flags & 8) !== 0,
        defaultExpr,
        collate,
        generated,
      });
    }
    const constraints = readBjv(r, intern) as TableConstraint[];
    const originalSql = str(readVarintU32(r)) || null;
    const tableFlags = r.u8();
    const indexNameCount = readVarintU32(r);
    const indexNames: string[] = [];
    for (let i = 0; i < indexNameCount; i++) indexNames.push(str(readVarintU32(r)));
    const table = new Table(name, columns, {
      constraints,
      indexes: indexNames,
      originalSql,
      withoutRowid: (tableFlags & 1) !== 0,
      strict: (tableFlags & 2) !== 0,
    });
    table.nextRowid = asRowid(readTaggedValue(r, intern));
    const rowCount = readVarintU32(r);
    const rowids: Rowid[] = [];
    for (let ri = 0; ri < rowCount; ri++) rowids.push(asRowid(readTaggedValue(r, intern)));
    const slabColumns: SlabColumn[] = [];
    for (let c = 0; c < colCount; c++) slabColumns.push(readPackedColumn(r, rowCount, intern));
    table.attachSlab(new ColumnarSlab(snapshot, rowCount, rowids, slabColumns, intern));
    if (table.withoutRowid) table.rebuildClusteredRows();
    state.tables.set(table.name.toLowerCase(), table);
  }

  const viewCount = readVarintU32(r);
  for (let i = 0; i < viewCount; i++) {
    const view = readBjv(r, intern) as ViewInfo;
    state.views.set(view.name.toLowerCase(), view);
  }

  const indexCount = readVarintU32(r);
  const loadedIndexes: IndexInfo[] = [];
  for (let i = 0; i < indexCount; i++) {
    const meta = readBjv(r, intern) as Omit<IndexInfo, "store">;
    const info: IndexInfo = { ...meta, store: new IndexStore(meta.name) };
    state.indexes.set(info.name.toLowerCase(), info);
    loadedIndexes.push(info);
  }
  for (const info of loadedIndexes) {
    info.store = readIndexStoreBinary(r, info.name, intern);
  }

  if (r.remaining() < 16) throw new SqliteError("invalid or truncated sqlite-mem snapshot", "other");
  const runtime: SnapshotRuntime = { prngState: r.u64(), nowMs: finiteNowMs(Number(r.i64())) };
  if (!r.done()) throw new SqliteError("snapshot has trailing data", "other");
  return { state, runtime };
}

// --- tagged SqlValue (rowid / tagged cells) -----------------------------------

function writeTaggedValue(w: Writer, value: SqlValue, internId: (s: string) => number): void {
  if (value === null) {
    w.u8(0);
    return;
  }
  if (value instanceof SqlReal) {
    w.u8(2);
    w.f64(value.value);
    return;
  }
  if (typeof value === "bigint" || (typeof value === "number" && Number.isInteger(value))) {
    w.u8(1);
    w.i64(BigInt(value));
    return;
  }
  if (typeof value === "number") {
    w.u8(2);
    w.f64(value);
    return;
  }
  if (typeof value === "string") {
    const id = internId(value);
    if (id >= 0) {
      w.u8(3);
      writeVarintU32(w, id);
      return;
    }
    w.u8(4);
    w.text(value);
    return;
  }
  if (value instanceof SqlJsonText) {
    w.u8(4);
    w.text(value.value);
    return;
  }
  w.u8(5);
  writeVarintU32(w, value.length);
  w.raw(value);
}

function readTaggedValue(r: Reader, intern: readonly string[]): SqlValue {
  const tag = r.u8();
  if (tag === 0) return null;
  if (tag === 1) {
    const integer = r.i64();
    return integer <= BigInt(Number.MAX_SAFE_INTEGER) && integer >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(integer)
      : integer;
  }
  if (tag === 2) {
    const value = r.f64();
    return Number.isInteger(value) && Number.isFinite(value) ? asSqlReal(value) : value;
  }
  if (tag === 3) return intern[readVarintU32(r)] ?? "";
  if (tag === 4) return r.text();
  return r.raw(readVarintU32(r));
}

// --- packed columns -----------------------------------------------------------

function writePackedColumn(w: Writer, rows: Row[], col: number, internId: (s: string) => number): void {
  const n = rows.length;
  if (n === 0) {
    w.u8(PACK_NULL);
    return;
  }
  const bits = new Uint8Array((n + 7) >> 3);
  let nulls = 0;
  let kind: number | null = null;
  let useInlineText = false;
  for (let i = 0; i < n; i++) {
    const value = rows[i]!.values[col] ?? null;
    if (value === null) {
      bits[i >> 3] = (bits[i >> 3]! | (1 << (i & 7))) as number;
      nulls++;
      continue;
    }
    const cellKind = packKindOf(value);
    if (kind === null) kind = cellKind;
    else if (kind !== cellKind) kind = PACK_TAGGED;
    if (cellKind === PACK_TEXT_INTERN && typeof value === "string" && internId(value) < 0) useInlineText = true;
    if (value instanceof SqlJsonText) kind = PACK_TAGGED;
  }
  if (nulls === n) {
    w.u8(PACK_NULL);
    return;
  }
  let pack = kind ?? PACK_TAGGED;
  if (pack === PACK_TEXT_INTERN && useInlineText) pack = PACK_TEXT_INLINE;
  w.u8(pack);
  w.raw(bits);
  if (pack === PACK_I32) {
    w.align4();
    for (let i = 0; i < n; i++) {
      if (bits[i >> 3]! & (1 << (i & 7))) continue;
      w.u32(rows[i]!.values[col] as number);
    }
    return;
  }
  if (pack === PACK_I64) {
    w.align4();
    for (let i = 0; i < n; i++) {
      if (bits[i >> 3]! & (1 << (i & 7))) continue;
      const v = rows[i]!.values[col]!;
      w.i64(typeof v === "bigint" ? v : BigInt(v as number));
    }
    return;
  }
  if (pack === PACK_F64) {
    w.align4();
    for (let i = 0; i < n; i++) {
      if (bits[i >> 3]! & (1 << (i & 7))) continue;
      const v = rows[i]!.values[col]!;
      w.f64(v instanceof SqlReal ? v.value : (v as number));
    }
    return;
  }
  if (pack === PACK_TEXT_INTERN) {
    w.align4();
    for (let i = 0; i < n; i++) {
      if (bits[i >> 3]! & (1 << (i & 7))) continue;
      const text = rows[i]!.values[col] as string;
      w.u32(internId(text));
    }
    return;
  }
  if (pack === PACK_TEXT_INLINE) {
    const offsets: number[] = [];
    let blobLen = 0;
    for (let i = 0; i < n; i++) {
      if (bits[i >> 3]! & (1 << (i & 7))) continue;
      offsets.push(blobLen);
      const text =
        rows[i]!.values[col] instanceof SqlJsonText
          ? (rows[i]!.values[col] as SqlJsonText).value
          : (rows[i]!.values[col] as string);
      blobLen += utf8Encode(text).length;
    }
    writeVarintU32(w, offsets.length);
    for (const off of offsets) writeVarintU32(w, off);
    writeVarintU32(w, blobLen);
    for (let i = 0; i < n; i++) {
      if (bits[i >> 3]! & (1 << (i & 7))) continue;
      const text =
        rows[i]!.values[col] instanceof SqlJsonText
          ? (rows[i]!.values[col] as SqlJsonText).value
          : (rows[i]!.values[col] as string);
      w.textBytes(text);
    }
    return;
  }
  if (pack === PACK_BLOB) {
    for (let i = 0; i < n; i++) {
      if (bits[i >> 3]! & (1 << (i & 7))) continue;
      const blob = rows[i]!.values[col] as Uint8Array;
      writeVarintU32(w, blob.length);
      w.raw(blob);
    }
    return;
  }
  for (let i = 0; i < n; i++) {
    if (bits[i >> 3]! & (1 << (i & 7))) continue;
    writeTaggedValue(w, rows[i]!.values[col]!, internId);
  }
}

function readPackedColumn(r: Reader, n: number, intern: readonly string[]): SlabColumn {
  const pack = r.u8();
  if (pack === PACK_NULL) return prepareSlabColumn({ pack, nullBitmap: null, payload: new Uint8Array(0) }, n, 0);
  const bits = r.raw((n + 7) >> 3);
  const nonNull = countNonNull(bits, n);

  if (pack === PACK_I32 || pack === PACK_I64 || pack === PACK_F64 || pack === PACK_TEXT_INTERN) {
    r.skipAlign4();
    const width = pack === PACK_I32 || pack === PACK_TEXT_INTERN ? 4 : 8;
    const payload = r.raw(nonNull * width);
    return prepareSlabColumn({ pack, nullBitmap: bits, payload }, n, nonNull);
  }
  if (pack === PACK_TEXT_INLINE) {
    const count = readVarintU32(r);
    const offsets = new Uint32Array(count);
    for (let i = 0; i < count; i++) offsets[i] = readVarintU32(r);
    const total = readVarintU32(r);
    const payload = r.raw(total);
    return prepareSlabColumn({ pack, nullBitmap: bits, payload, inlineOffsets: offsets }, n, nonNull);
  }
  if (pack === PACK_BLOB) {
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < n; i++) {
      if (bits[i >> 3]! & (1 << (i & 7))) continue;
      const len = readVarintU32(r);
      chunks.push(r.raw(len));
    }
    return prepareSlabColumn({ pack, nullBitmap: bits, payload: new Uint8Array(0), blobChunks: chunks }, n, nonNull);
  }
  const tagged: SqlValue[] = [];
  for (let i = 0; i < n; i++) {
    if (bits[i >> 3]! & (1 << (i & 7))) continue;
    tagged.push(readTaggedValue(r, intern));
  }
  return prepareSlabColumn({ pack: PACK_TAGGED, nullBitmap: bits, payload: new Uint8Array(0), tagged }, n, nonNull);
}

function countNonNull(bits: Uint8Array, n: number): number {
  let c = 0;
  for (let i = 0; i < n; i++) if ((bits[i >> 3]! & (1 << (i & 7))) === 0) c++;
  return c;
}

// --- binary index store -------------------------------------------------------

function writeIndexStoreBinary(w: Writer, store: IndexStore, internId: (s: string) => number): void {
  const entries = store.snapshotKeys();
  writeVarintU32(w, entries.length);
  for (const entry of entries) {
    const values = store.keyValuesFor(entry.key);
    writeVarintU32(w, values.length);
    for (const v of values) writeTaggedValue(w, v, internId);
    writeVarintU32(w, entry.rowids.length);
    for (const id of entry.rowids) writeTaggedValue(w, id, internId);
  }
}

function readIndexStoreBinary(r: Reader, name: string, intern: readonly string[]): IndexStore {
  const count = readVarintU32(r);
  const entries = new Map<string, Rowid[]>();
  const keyValues = new Map<string, SqlValue[]>();
  for (let i = 0; i < count; i++) {
    const valueCount = readVarintU32(r);
    const values: SqlValue[] = [];
    for (let v = 0; v < valueCount; v++) values.push(readTaggedValue(r, intern));
    const key = serializeIndexEntry(values);
    const rowidCount = readVarintU32(r);
    const rowids: Rowid[] = [];
    for (let ri = 0; ri < rowidCount; ri++) rowids.push(asRowid(readTaggedValue(r, intern)));
    entries.set(key, rowids);
    keyValues.set(key, values);
  }
  return new IndexStore(name, entries, keyValues);
}

// --- helpers ------------------------------------------------------------------

function asRowid(value: SqlValue): Rowid {
  if ((typeof value === "number" && Number.isSafeInteger(value)) || typeof value === "bigint") return value;
  throw new SqliteError("invalid rowid in snapshot", "other");
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function finiteNowMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const max = 8.64e15;
  if (value > max) return max;
  if (value < -max) return -max;
  return value;
}

function sortedValues<T extends { name: string }>(map: Map<string, T>): T[] {
  return [...map.values()].sort((a, b) => compareNames(a.name, b.name));
}

function forceSchemaIntern(pool: InternPool, tables: Table[], views: ViewInfo[], indexes: IndexInfo[]): void {
  for (const table of tables) {
    pool.forceId(table.name);
    pool.forceId(table.originalSql ?? "");
    for (const column of table.columns) {
      pool.forceId(column.name);
      pool.forceId(column.typeName ?? "");
      pool.forceId(column.collate ?? "");
    }
    for (const name of table.indexes) pool.forceId(name);
    forceBjvStrings(pool, table.constraints);
    for (const column of table.columns) {
      if (column.defaultExpr) forceBjvStrings(pool, column.defaultExpr);
      if (column.generated) forceBjvStrings(pool, column.generated);
    }
  }
  for (const view of views) forceBjvStrings(pool, view);
  for (const index of indexes) {
    pool.forceId(index.name);
    pool.forceId(index.tableName);
    pool.forceId(index.originalSql ?? "");
    forceBjvStrings(pool, {
      name: index.name,
      tableName: index.tableName,
      unique: index.unique,
      columns: index.columns,
      where: index.where,
      originalSql: index.originalSql,
    });
  }
}

function forceBjvStrings(pool: InternPool, value: unknown): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    pool.forceId(value);
    return;
  }
  if (typeof value === "bigint" || typeof value === "boolean" || typeof value === "number") return;
  if (value instanceof Uint8Array) return;
  if (Array.isArray(value)) {
    for (const item of value) forceBjvStrings(pool, item);
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      pool.forceId(k);
      forceBjvStrings(pool, v);
    }
  }
}
