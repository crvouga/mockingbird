import { asSqlReal, SqlJsonText, SqlReal, type SqlValue, utf8Decode } from "../types/value.ts";
import type { Rowid } from "./row.ts";

/** Column pack tags (SQLM v5). */
export const PACK_NULL = 0;
export const PACK_I32 = 1;
export const PACK_I64 = 2;
export const PACK_F64 = 3;
export const PACK_TEXT_INTERN = 4;
export const PACK_TEXT_INLINE = 5;
export const PACK_BLOB = 6;
export const PACK_TAGGED = 7;

export interface SlabColumn {
  pack: number;
  nullBitmap: Uint8Array | null;
  /** Typed payload or inline blob region inside `buffer`. */
  payload: Uint8Array;
  /** Cached view over `payload` (avoid per-cell DataView alloc). */
  view?: DataView;
  /** Prefix count of non-null cells before each row (when nulls exist). */
  nonNullRank?: Uint32Array;
  /** For PACK_TEXT_INLINE: u32 offsets into payload per row. */
  inlineOffsets?: Uint32Array;
  /** For PACK_TAGGED: decoded values per non-null row in order. */
  tagged?: SqlValue[];
  /** For PACK_BLOB: one entry per non-null row. */
  blobChunks?: Uint8Array[];
}

/** Attach decode helpers; drop an all-zero null bitmap. */
export function prepareSlabColumn(column: SlabColumn, rowCount: number, nonNull: number): SlabColumn {
  if (column.payload.length > 0) {
    column.view = new DataView(column.payload.buffer, column.payload.byteOffset, column.payload.byteLength);
  }
  if (!column.nullBitmap || nonNull === rowCount) {
    column.nullBitmap = null;
    column.nonNullRank = undefined;
    return column;
  }
  column.nonNullRank = buildNonNullRank(column.nullBitmap, rowCount);
  return column;
}

function buildNonNullRank(bits: Uint8Array, n: number): Uint32Array {
  const rank = new Uint32Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    rank[i] = k;
    if ((bits[i >> 3]! & (1 << (i & 7))) === 0) k++;
  }
  return rank;
}

/** Frozen columnar row storage; zero-copy views into snapshot buffer. */
export class ColumnarSlab {
  readonly buffer: Uint8Array;
  readonly rowCount: number;
  readonly rowids: Rowid[];
  readonly columns: SlabColumn[];
  private readonly intern: readonly string[];
  private rowidIndex: Map<Rowid, number> | null = null;

  constructor(buffer: Uint8Array, rowCount: number, rowids: Rowid[], columns: SlabColumn[], intern: readonly string[]) {
    this.buffer = buffer;
    this.rowCount = rowCount;
    this.rowids = rowids;
    this.columns = columns;
    this.intern = intern;
  }

  private rowIndex(rowid: Rowid): number {
    this.rowidIndex ??= new Map(this.rowids.map((id, i) => [canonicalRowid(id), i]));
    const hit = this.rowidIndex.get(canonicalRowid(rowid));
    if (hit === undefined) return -1;
    return hit;
  }

  cell(rowIndex: number, col: number): SqlValue {
    if (rowIndex < 0 || rowIndex >= this.rowCount) return null;
    const column = this.columns[col];
    if (!column) return null;
    if (column.nullBitmap && isNull(column.nullBitmap, rowIndex)) return null;
    return readSlabCell(column, rowIndex, this.intern);
  }

  rowAt(rowIndex: number): { rowid: Rowid; values: SqlValue[] } {
    const values: SqlValue[] = new Array(this.columns.length);
    for (let c = 0; c < this.columns.length; c++) values[c] = this.cell(rowIndex, c);
    return { rowid: this.rowids[rowIndex]!, values };
  }

  get(rowid: Rowid): { rowid: Rowid; values: SqlValue[] } | undefined {
    const i = this.rowIndex(rowid);
    if (i < 0) return undefined;
    return this.rowAt(i);
  }

  *scan(): Generator<{ rowid: Rowid; values: SqlValue[] }> {
    for (let i = 0; i < this.rowCount; i++) yield this.rowAt(i);
  }

  materialize(): Map<Rowid, { rowid: Rowid; values: SqlValue[] }> {
    const map = new Map<Rowid, { rowid: Rowid; values: SqlValue[] }>();
    for (let i = 0; i < this.rowCount; i++) {
      const row = this.rowAt(i);
      map.set(row.rowid, row);
    }
    return map;
  }
}

function canonicalRowid(rowid: Rowid): Rowid {
  return typeof rowid === "bigint" ? rowid : rowid;
}

function isNull(bits: Uint8Array, i: number): boolean {
  return (bits[i >> 3]! & (1 << (i & 7))) !== 0;
}

function nonNullRowIndex(column: SlabColumn, rowIndex: number): number {
  if (!column.nullBitmap) return rowIndex;
  return column.nonNullRank?.[rowIndex] ?? rowIndex;
}

function readSlabCell(column: SlabColumn, rowIndex: number, intern: readonly string[]): SqlValue {
  const pack = column.pack;
  if (pack === PACK_NULL) return null;
  const nonNullIndex = nonNullRowIndex(column, rowIndex);
  const view = column.view;

  if (pack === PACK_I32) {
    return view!.getInt32(nonNullIndex * 4, true);
  }
  if (pack === PACK_I64) {
    const integer = view!.getBigInt64(nonNullIndex * 8, true);
    return integer <= BigInt(Number.MAX_SAFE_INTEGER) && integer >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(integer)
      : integer;
  }
  if (pack === PACK_F64) {
    const value = view!.getFloat64(nonNullIndex * 8, true);
    return Number.isInteger(value) && Number.isFinite(value) ? asSqlReal(value) : value;
  }
  if (pack === PACK_TEXT_INTERN) {
    const id = view!.getUint32(nonNullIndex * 4, true);
    return intern[id] ?? "";
  }
  if (pack === PACK_TEXT_INLINE) {
    const offsets = column.inlineOffsets!;
    const start = offsets[nonNullIndex]!;
    const end = nonNullIndex + 1 < offsets.length ? offsets[nonNullIndex + 1]! : column.payload.length;
    return utf8Decode(column.payload.subarray(start, end));
  }
  if (pack === PACK_BLOB) {
    const blob = column.blobChunks![nonNullIndex]!;
    return blob;
  }
  if (pack === PACK_TAGGED) {
    return column.tagged![nonNullIndex] ?? null;
  }
  return null;
}

export function packKindOf(value: SqlValue): number {
  if (value instanceof SqlReal) return PACK_F64;
  if (typeof value === "bigint") return PACK_I64;
  if (typeof value === "number" && Number.isInteger(value)) {
    return value >= -0x80000000 && value <= 0x7fffffff ? PACK_I32 : PACK_I64;
  }
  if (typeof value === "number") return PACK_F64;
  if (value instanceof SqlJsonText) return PACK_TAGGED;
  if (typeof value === "string") return PACK_TEXT_INTERN;
  if (value instanceof Uint8Array) return PACK_BLOB;
  return PACK_TAGGED;
}
