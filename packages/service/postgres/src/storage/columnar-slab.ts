import { assert } from "../runtime/assert.ts";
import type { Datum } from "../types/value.ts";

/** Column pack tags (PGMM v3). */
export const PACK_NULL = 0;
export const PACK_BOOL = 1;
export const PACK_FLOAT = 2;
export const PACK_INT = 3;
export const PACK_TEXT_INTERN = 4;
export const PACK_TEXT_INLINE = 5;
export const PACK_BLOB = 6;
export const PACK_TAGGED = 7;

export interface SlabColumn {
  pack: number;
  nullBitmap: Uint8Array | null;
  /** Prefix sum of non-null rows for O(1) null-index lookup. */
  nonNullPrefix?: Uint32Array;
  /** Typed payload or inline blob region inside `buffer`. */
  payload: Uint8Array;
  /** For PACK_TEXT_INLINE: u32 offsets into payload per row. */
  inlineOffsets?: Uint32Array;
  /** For PACK_TAGGED: decoded values per non-null row in order. */
  tagged?: Datum[];
  /** For PACK_BLOB: one entry per non-null row (zero-copy views). */
  blobChunks?: Uint8Array[];
}

const decodeCache = new WeakMap<SlabColumn, { dataView: DataView; textDecoder: TextDecoder }>();

function slabDecodeHelpers(column: SlabColumn): { dataView: DataView; textDecoder: TextDecoder } {
  let cached = decodeCache.get(column);
  if (!cached) {
    cached = {
      dataView: new DataView(column.payload.buffer, column.payload.byteOffset, column.payload.byteLength),
      textDecoder: new TextDecoder(),
    };
    decodeCache.set(column, cached);
  }
  return cached;
}

/** Frozen columnar row storage; zero-copy views into snapshot buffer. */
export class ColumnarSlab {
  readonly buffer: Uint8Array;
  readonly rowCount: number;
  readonly columns: SlabColumn[];
  private readonly intern: readonly string[];

  constructor(buffer: Uint8Array, rowCount: number, columns: SlabColumn[], intern: readonly string[]) {
    this.buffer = buffer;
    this.rowCount = rowCount;
    this.columns = columns;
    this.intern = intern;
  }

  cell(rowIndex: number, col: number): Datum {
    assert(rowIndex >= 0 && rowIndex < this.rowCount, "slab row index out of bounds");
    assert(col >= 0 && col < this.columns.length, "slab column index out of bounds");
    const column = this.columns[col]!;
    if (column.nullBitmap && isNull(column.nullBitmap, rowIndex)) return null;
    return readSlabCell(column, rowIndex, this.intern, this.rowCount);
  }

  rowAt(rowIndex: number): Datum[] {
    const values: Datum[] = new Array(this.columns.length);
    for (let c = 0; c < this.columns.length; c++) values[c] = this.cell(rowIndex, c);
    return values;
  }

  *scan(): Generator<Datum[]> {
    for (let i = 0; i < this.rowCount; i++) yield this.rowAt(i);
  }

  materialize(): Datum[][] {
    const out: Datum[][] = new Array(this.rowCount);
    for (let i = 0; i < this.rowCount; i++) out[i] = this.rowAt(i);
    return out;
  }
}

function isNull(bits: Uint8Array, i: number): boolean {
  return (bits[i >> 3]! & (1 << (i & 7))) !== 0;
}

function nonNullRowIndex(column: SlabColumn, rowIndex: number, rowCount: number): number {
  if (!column.nullBitmap) return rowIndex;
  if (!column.nonNullPrefix) {
    const prefix = new Uint32Array(rowCount + 1);
    let count = 0;
    for (let i = 0; i < rowCount; i++) {
      prefix[i] = count;
      if (!isNull(column.nullBitmap, i)) count++;
    }
    prefix[rowCount] = count;
    column.nonNullPrefix = prefix;
  }
  return column.nonNullPrefix[rowIndex]!;
}

function readSlabCell(column: SlabColumn, rowIndex: number, intern: readonly string[], rowCount: number): Datum {
  const pack = column.pack;
  if (pack === PACK_NULL) return null;
  const nonNullIndex = nonNullRowIndex(column, rowIndex, rowCount);
  const { dataView: view, textDecoder } = slabDecodeHelpers(column);

  if (pack === PACK_BOOL) {
    return (column.payload[nonNullIndex] ?? 0) !== 0;
  }
  if (pack === PACK_FLOAT) {
    return view.getFloat64(nonNullIndex * 8, true);
  }
  if (pack === PACK_INT) {
    const integer = view.getBigInt64(nonNullIndex * 8, true);
    return integer <= BigInt(Number.MAX_SAFE_INTEGER) && integer >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(integer)
      : integer;
  }
  if (pack === PACK_TEXT_INTERN) {
    const id = view.getUint32(nonNullIndex * 4, true);
    return intern[id] ?? "";
  }
  if (pack === PACK_TEXT_INLINE) {
    const offsets = column.inlineOffsets!;
    const start = offsets[nonNullIndex]!;
    const end = nonNullIndex + 1 < offsets.length ? offsets[nonNullIndex + 1]! : column.payload.length;
    return textDecoder.decode(column.payload.subarray(start, end));
  }
  if (pack === PACK_BLOB) {
    return column.blobChunks![nonNullIndex]!;
  }
  if (pack === PACK_TAGGED) {
    return column.tagged![nonNullIndex] ?? null;
  }
  return null;
}

export function packKindOf(value: Datum): number {
  if (typeof value === "boolean") return PACK_BOOL;
  if (typeof value === "number") return Number.isInteger(value) ? PACK_INT : PACK_FLOAT;
  if (typeof value === "bigint") return PACK_INT;
  if (typeof value === "string") return PACK_TEXT_INTERN;
  if (value instanceof Uint8Array) return PACK_BLOB;
  return PACK_TAGGED;
}
