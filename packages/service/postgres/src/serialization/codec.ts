import { registerCodec } from "../api/database.ts";
import type { SelectStmt } from "../ast/nodes.ts";
import { PostgresError } from "../errors/error.ts";
import type { Clock } from "../runtime/clock.ts";
import type { Prng } from "../runtime/prng.ts";
import {
  ColumnarSlab,
  PACK_BLOB,
  PACK_BOOL,
  PACK_FLOAT,
  PACK_INT,
  PACK_NULL,
  PACK_TAGGED,
  PACK_TEXT_INLINE,
  PACK_TEXT_INTERN,
  packKindOf,
  type SlabColumn,
} from "../storage/columnar-slab.ts";
import {
  type ColumnMeta,
  type ConstraintMeta,
  DatabaseState,
  type DomainData,
  type EnumData,
  type FunctionData,
  type IndexMeta,
  SchemaData,
  type SequenceData,
  TableData,
  type TriggerMeta,
  type ViewData,
} from "../storage/database-state.ts";
import type { Interval } from "../types/datetime.ts";
import { jsonbText, parseJsonText } from "../types/jsonb.ts";
import type { Numeric } from "../types/numeric.ts";
import type { Datum, PgArray, PgRecord, TypeId } from "../types/value.ts";
import {
  InternPool,
  readBjv,
  Reader,
  readInternTable,
  readVarintU32,
  utf8Encode,
  writeBjv,
  writeInternTable,
  writeVarintU32,
  Writer,
} from "./wire.ts";

const MAGIC = utf8Encode("PGMM");
/** PGMM v3: adaptive intern, BJV schema, columnar slab hydrate, zero-copy blobs. */
const VERSION = 3;

/** PRNG + clock captured alongside catalog/rows. */
export interface SnapshotRuntime {
  prngState: bigint;
  nowMs: number;
}

/** Result of {@link decodeDatabaseState}. */
export interface DecodedSnapshot {
  state: DatabaseState;
  runtime: SnapshotRuntime | null;
}

interface TableMetaBjv {
  name: string;
  schema: string;
  columns: ColumnMeta[];
  constraints: ConstraintMeta[];
  triggers: TriggerMeta[];
  temp: boolean;
  oid: number;
}

interface ViewMetaBjv {
  name: string;
  schema: string;
  query: SelectStmt;
  columns: string[] | null;
  materialized: boolean;
  matColumns: Array<{ name: string; type: TypeId }> | null;
  temp: boolean;
  oid: number;
}

type FunctionMetaBjv = Omit<FunctionData, "jsImpl">;

/**
 * Encode catalog, rows, and runtime into a postgres-mem `PGMM` snapshot blob
 * (not an on-disk PostgreSQL format).
 */
export function encodeDatabaseState(state: DatabaseState, runtime: SnapshotRuntime): Uint8Array {
  const pool = new InternPool();
  const schemas = [...state.schemas.values()].sort((a, b) => compareNames(a.name, b.name));

  for (const schema of schemas) {
    pool.count(schema.name);
    for (const table of sortedValues(schema.tables)) {
      pool.count(table.name);
      pool.count(table.schema);
      for (const column of table.columns) {
        pool.count(column.name);
        pool.count(column.collate ?? "");
        pool.count(column.domain ?? "");
        if (column.identity) pool.count(column.identity.sequence);
      }
      for (const row of table.allRows()) {
        for (const d of row) if (typeof d === "string") pool.count(d);
      }
    }
    for (const view of sortedValues(schema.views)) {
      pool.count(view.name);
      pool.count(view.schema);
      if (view.matRows) {
        for (const row of view.matRows) {
          for (const d of row) if (typeof d === "string") pool.count(d);
        }
      }
    }
    for (const seq of sortedValues(schema.sequences)) {
      pool.count(seq.name);
      pool.count(seq.schema);
    }
    for (const en of sortedValues(schema.enums)) {
      pool.count(en.name);
      pool.count(en.schema);
      for (const label of en.labels) pool.count(label);
    }
    for (const domain of sortedValues(schema.domains)) {
      pool.count(domain.name);
      pool.count(domain.schema);
    }
    for (const idx of sortedValues(schema.indexes)) {
      pool.count(idx.name);
      pool.count(idx.schema);
      pool.count(idx.table);
    }
    for (const overloads of schema.functions.values()) {
      for (const fn of overloads) {
        if (fn.language === "js") continue;
        pool.count(fn.name);
        pool.count(fn.schema);
        pool.count(fn.language);
        pool.count(fn.rawBody ?? "");
      }
    }
  }

  pool.finalize();
  forceAllEncodeIntern(pool, state, schemas);

  const internId = (s: string): number => pool.id(s);
  const forceId = (s: string): number => {
    const id = pool.id(s);
    if (id < 0) throw snapshotError();
    return id;
  };

  const w = new Writer(64 * 1024);
  w.raw(MAGIC);
  w.u32(VERSION);
  w.u32(state.snapshotOidCounter());
  w.u32(state.changes);
  writeInternTable(w, pool.list);
  const settings = [...state.settings.entries()].sort((a, b) => compareNames(a[0], b[0]));
  writeVarintU32(w, settings.length);
  for (const [k, v] of settings) {
    writeVarintU32(w, forceId(k));
    writeVarintU32(w, forceId(v));
  }

  writeVarintU32(w, schemas.length);
  for (const schema of schemas) {
    writeVarintU32(w, forceId(schema.name));
    w.u32(schema.oid);

    const tables = sortedValues(schema.tables);
    writeVarintU32(w, tables.length);
    for (const table of tables) {
      writeBjv(
        w,
        {
          name: table.name,
          schema: table.schema,
          columns: table.columns,
          constraints: table.constraints,
          triggers: table.triggers,
          temp: table.temp,
          oid: table.oid,
        } satisfies TableMetaBjv,
        forceId,
      );
      const rows = table.allRows();
      writeVarintU32(w, rows.length);
      for (let c = 0; c < table.columns.length; c++) writePackedColumn(w, rows, c, internId, forceId);
    }

    const views = sortedValues(schema.views);
    writeVarintU32(w, views.length);
    for (const view of views) {
      writeBjv(
        w,
        {
          name: view.name,
          schema: view.schema,
          query: view.query,
          columns: view.columns,
          materialized: view.materialized,
          matColumns: view.matColumns,
          temp: view.temp,
          oid: view.oid,
        } satisfies ViewMetaBjv,
        forceId,
      );
      if (view.matRows === null) {
        w.u8(0);
      } else {
        w.u8(1);
        const width = view.matColumns?.length ?? view.matRows[0]?.length ?? 0;
        writeVarintU32(w, view.matRows.length);
        writeVarintU32(w, width);
        for (let c = 0; c < width; c++) writePackedColumn(w, view.matRows, c, internId, forceId);
      }
    }

    writeSchemaCatalog(w, schema, forceId);
  }

  if (state.lastSequence === null) {
    w.u8(0);
  } else {
    w.u8(1);
    writeVarintU32(w, forceId(state.lastSequence.schema));
    writeVarintU32(w, forceId(state.lastSequence.name));
  }
  w.u64(runtime.prngState);
  w.i64(BigInt(Math.trunc(runtime.nowMs)));
  return w.finish();
}

/**
 * Decode a blob from {@link encodeDatabaseState} / {@link Database.snapshot}.
 */
export function decodeDatabaseState(snapshot: Uint8Array, prng: Prng, clock: Clock): DecodedSnapshot {
  try {
    return decodeInner(snapshot, prng, clock);
  } catch (error) {
    if (error instanceof PostgresError) throw error;
    throw snapshotError();
  }
}

function decodeInner(snapshot: Uint8Array, prng: Prng, clock: Clock): DecodedSnapshot {
  const r = new Reader(snapshot);
  const magic = r.raw(4);
  if (!magic.every((byte, index) => byte === MAGIC[index])) {
    throw new PostgresError("snapshot_format", "invalid postgres-mem snapshot magic", "XX000");
  }
  const version = r.u32();
  if (version !== VERSION) {
    throw new PostgresError("snapshot_version", `unsupported postgres-mem snapshot version: ${version}`, "XX000");
  }

  const state = new DatabaseState(prng, clock);
  state.restoreOidCounter(r.u32());
  state.changes = r.u32();
  const intern = readInternTable(r);
  const str = (id: number): string => intern[id] ?? "";
  state.settings = new Map();
  const settingCount = readVarintU32(r);
  for (let i = 0; i < settingCount; i++) {
    state.settings.set(str(readVarintU32(r)), str(readVarintU32(r)));
  }

  state.schemas = new Map();
  const schemaCount = readVarintU32(r);
  for (let si = 0; si < schemaCount; si++) {
    const schema = new SchemaData(str(readVarintU32(r)), r.u32());

    const tableCount = readVarintU32(r);
    for (let i = 0; i < tableCount; i++) {
      const meta = readBjv(r, intern);
      validateTableMetaBjv(meta);
      const table = new TableData(meta.schema, meta.name, meta.columns, meta.oid, meta.temp);
      table.constraints = meta.constraints;
      table.triggers = meta.triggers;
      const rowCount = readVarintU32(r);
      const slabColumns: SlabColumn[] = [];
      for (let c = 0; c < meta.columns.length; c++) slabColumns.push(readPackedColumn(r, rowCount, intern));
      table.attachSlab(new ColumnarSlab(snapshot, rowCount, slabColumns, intern));
      schema.tables.set(table.name, table);
    }

    const viewCount = readVarintU32(r);
    for (let i = 0; i < viewCount; i++) {
      const meta = readBjv(r, intern);
      validateViewMetaBjv(meta);
      let matRows: Datum[][] | null = null;
      if (r.u8() === 1) {
        const matRowCount = readVarintU32(r);
        const width = readVarintU32(r);
        const cols: SlabColumn[] = [];
        for (let c = 0; c < width; c++) cols.push(readPackedColumn(r, matRowCount, intern));
        const slab = new ColumnarSlab(snapshot, matRowCount, cols, intern);
        matRows = slab.materialize();
      }
      const view: ViewData = { ...(meta as ViewMetaBjv), matRows };
      schema.views.set(view.name, view);
    }

    readSchemaCatalog(r, schema, intern, str);
    state.schemas.set(schema.name, schema);
  }

  state.lastSequence = r.u8() === 1 ? { schema: str(readVarintU32(r)), name: str(readVarintU32(r)) } : null;
  if (r.remaining() < 16) throw snapshotError();
  const runtime: SnapshotRuntime = { prngState: r.u64(), nowMs: finiteNowMs(Number(r.i64())) };
  if (!r.done()) throw new PostgresError("snapshot_format", "snapshot has trailing data", "XX000");
  return { state, runtime };
}

// --- tagged datum (packed column cells) ---------------------------------------

function writeTaggedDatum(
  w: Writer,
  value: Datum,
  internId: (s: string) => number,
  forceId: (s: string) => number,
): void {
  if (value === null) {
    w.u8(0);
    return;
  }
  if (typeof value === "boolean") {
    w.u8(1);
    w.u8(value ? 1 : 0);
    return;
  }
  if (typeof value === "number") {
    w.u8(2);
    w.f64(value);
    return;
  }
  if (typeof value === "bigint") {
    w.u8(3);
    w.i64(value);
    return;
  }
  if (typeof value === "string") {
    const id = internId(value);
    if (id >= 0) {
      w.u8(4);
      writeVarintU32(w, id);
      return;
    }
    w.u8(5);
    w.text(value);
    return;
  }
  if (value instanceof Uint8Array) {
    w.u8(6);
    writeVarintU32(w, value.length);
    w.raw(value);
    return;
  }
  switch (value.kind) {
    case "numeric": {
      w.u8(7);
      w.u8(value.special === null ? 0 : value.special === "nan" ? 1 : value.special === "inf" ? 2 : 3);
      w.u32(value.dscale);
      const min = -0x8000000000000000n;
      const max = 0x7fffffffffffffffn;
      if (value.coef >= min && value.coef <= max) {
        w.u8(0);
        w.i64(value.coef);
      } else {
        w.u8(1);
        w.text(value.coef.toString());
      }
      return;
    }
    case "interval": {
      w.u8(8);
      w.i32(value.months);
      w.i32(value.days);
      w.i64(value.micros);
      return;
    }
    case "pgarray": {
      w.u8(9);
      w.text(value.elem);
      writeVarintU32(w, value.dims.length);
      for (const d of value.dims) w.i32(d);
      for (const l of value.lbs) w.i32(l);
      writeVarintU32(w, value.items.length);
      for (const item of value.items) writeTaggedDatum(w, item, internId, forceId);
      return;
    }
    case "pgrecord": {
      w.u8(10);
      writeBjv(w, value.types, forceId);
      writeBjv(w, value.names ?? null, forceId);
      writeVarintU32(w, value.values.length);
      for (const item of value.values) writeTaggedDatum(w, item, internId, forceId);
      return;
    }
    case "jsonb": {
      w.u8(11);
      w.text(jsonbText(value.value));
      return;
    }
    default: {
      const tz = value as unknown as { micros?: bigint; offsetSec?: number };
      if (typeof tz.micros === "bigint" && typeof tz.offsetSec === "number") {
        w.u8(12);
        w.i64(tz.micros);
        w.i32(tz.offsetSec);
        return;
      }
      w.u8(0);
    }
  }
}

function readTaggedDatum(r: Reader, intern: readonly string[]): Datum {
  const tag = r.u8();
  switch (tag) {
    case 0:
      return null;
    case 1:
      return r.u8() !== 0;
    case 2:
      return r.f64();
    case 3: {
      const integer = r.i64();
      return integer <= BigInt(Number.MAX_SAFE_INTEGER) && integer >= BigInt(Number.MIN_SAFE_INTEGER)
        ? Number(integer)
        : integer;
    }
    case 4:
      return intern[readVarintU32(r)] ?? "";
    case 5:
      return r.text();
    case 6:
      return r.raw(readVarintU32(r));
    case 7: {
      const specialTag = r.u8();
      const special = specialTag === 0 ? null : specialTag === 1 ? "nan" : specialTag === 2 ? "inf" : "-inf";
      const dscale = r.u32();
      const compact = r.u8() === 0;
      const coef = compact ? r.i64() : BigInt(r.text());
      return { kind: "numeric", coef, dscale, special } satisfies Numeric;
    }
    case 8: {
      const months = r.i32();
      const days = r.i32();
      const micros = r.i64();
      return { kind: "interval", months, days, micros } satisfies Interval;
    }
    case 9: {
      const elem = r.text() as TypeId;
      const ndims = readVarintU32(r);
      const dims: number[] = [];
      for (let i = 0; i < ndims; i++) dims.push(r.i32());
      const lbs: number[] = [];
      for (let i = 0; i < ndims; i++) lbs.push(r.i32());
      const count = readVarintU32(r);
      const items: Datum[] = [];
      for (let i = 0; i < count; i++) items.push(readTaggedDatum(r, intern));
      return { kind: "pgarray", elem, dims, lbs, items } satisfies PgArray;
    }
    case 10: {
      const types = readBjv(r, intern) as TypeId[];
      const names = readBjv(r, intern) as string[] | null;
      const count = readVarintU32(r);
      const values: Datum[] = [];
      for (let i = 0; i < count; i++) values.push(readTaggedDatum(r, intern));
      const rec: PgRecord = names ? { kind: "pgrecord", types, values, names } : { kind: "pgrecord", types, values };
      return rec;
    }
    case 11:
      return { kind: "jsonb", value: parseJsonText(r.text()) };
    case 12: {
      const micros = r.i64();
      const offsetSec = r.i32();
      return { micros, offsetSec } as unknown as Datum;
    }
    default:
      return r.fail();
  }
}

// --- packed columns -----------------------------------------------------------

function writePackedColumn(
  w: Writer,
  rows: Datum[][],
  col: number,
  internId: (s: string) => number,
  forceId: (s: string) => number,
): void {
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
    const value = rows[i]![col] ?? null;
    if (value === null) {
      bits[i >> 3] = (bits[i >> 3]! | (1 << (i & 7))) as number;
      nulls++;
      continue;
    }
    const cellKind = packKindOf(value);
    if (kind === null) kind = cellKind;
    else if (kind !== cellKind) kind = PACK_TAGGED;
    if (cellKind === PACK_TEXT_INTERN && typeof value === "string" && internId(value) < 0) useInlineText = true;
  }
  if (nulls === n) {
    w.u8(PACK_NULL);
    return;
  }
  let pack = kind ?? PACK_TAGGED;
  if (pack === PACK_TEXT_INTERN && useInlineText) pack = PACK_TEXT_INLINE;
  w.u8(pack);
  w.raw(bits);

  if (pack === PACK_BOOL) {
    for (let i = 0; i < n; i++) {
      if (bits[i >> 3]! & (1 << (i & 7))) continue;
      w.u8(rows[i]![col] ? 1 : 0);
    }
    return;
  }
  if (pack === PACK_FLOAT) {
    w.align4();
    for (let i = 0; i < n; i++) {
      if (bits[i >> 3]! & (1 << (i & 7))) continue;
      w.f64(rows[i]![col] as number);
    }
    return;
  }
  if (pack === PACK_INT) {
    w.align4();
    for (let i = 0; i < n; i++) {
      if (bits[i >> 3]! & (1 << (i & 7))) continue;
      const v = rows[i]![col]!;
      w.i64(typeof v === "bigint" ? v : BigInt(v as number));
    }
    return;
  }
  if (pack === PACK_TEXT_INTERN) {
    w.align4();
    for (let i = 0; i < n; i++) {
      if (bits[i >> 3]! & (1 << (i & 7))) continue;
      w.u32(internId(rows[i]![col] as string));
    }
    return;
  }
  if (pack === PACK_TEXT_INLINE) {
    const offsets: number[] = [];
    let blobLen = 0;
    for (let i = 0; i < n; i++) {
      if (bits[i >> 3]! & (1 << (i & 7))) continue;
      offsets.push(blobLen);
      blobLen += utf8Encode(rows[i]![col] as string).length;
    }
    writeVarintU32(w, offsets.length);
    for (const off of offsets) writeVarintU32(w, off);
    writeVarintU32(w, blobLen);
    for (let i = 0; i < n; i++) {
      if (bits[i >> 3]! & (1 << (i & 7))) continue;
      w.textBytes(rows[i]![col] as string);
    }
    return;
  }
  if (pack === PACK_BLOB) {
    for (let i = 0; i < n; i++) {
      if (bits[i >> 3]! & (1 << (i & 7))) continue;
      const blob = rows[i]![col] as Uint8Array;
      writeVarintU32(w, blob.length);
      w.raw(blob);
    }
    return;
  }
  for (let i = 0; i < n; i++) {
    if (bits[i >> 3]! & (1 << (i & 7))) continue;
    writeTaggedDatum(w, rows[i]![col]!, internId, forceId);
  }
}

function readPackedColumn(r: Reader, n: number, intern: readonly string[]): SlabColumn {
  const pack = r.u8();
  if (pack === PACK_NULL) return { pack, nullBitmap: null, payload: new Uint8Array(0) };
  const bits = r.raw((n + 7) >> 3);
  const nonNull = countNonNull(bits, n);

  if (pack === PACK_BOOL) {
    const payload = r.raw(nonNull);
    return { pack, nullBitmap: bits, payload };
  }
  if (pack === PACK_FLOAT || pack === PACK_INT) {
    r.skipAlign4();
    const width = 8;
    const payload = r.raw(nonNull * width);
    return { pack, nullBitmap: bits, payload };
  }
  if (pack === PACK_TEXT_INTERN) {
    r.skipAlign4();
    const payload = r.raw(nonNull * 4);
    return { pack, nullBitmap: bits, payload };
  }
  if (pack === PACK_TEXT_INLINE) {
    const count = readVarintU32(r);
    const offsets = new Uint32Array(count);
    for (let i = 0; i < count; i++) offsets[i] = readVarintU32(r);
    const total = readVarintU32(r);
    const payload = r.raw(total);
    return { pack, nullBitmap: bits, payload, inlineOffsets: offsets };
  }
  if (pack === PACK_BLOB) {
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < n; i++) {
      if (bits[i >> 3]! & (1 << (i & 7))) continue;
      const len = readVarintU32(r);
      chunks.push(r.raw(len));
    }
    return { pack, nullBitmap: bits, payload: new Uint8Array(0), blobChunks: chunks };
  }
  const tagged: Datum[] = [];
  for (let i = 0; i < n; i++) {
    if (bits[i >> 3]! & (1 << (i & 7))) continue;
    tagged.push(readTaggedDatum(r, intern));
  }
  return { pack: PACK_TAGGED, nullBitmap: bits, payload: new Uint8Array(0), tagged };
}

function countNonNull(bits: Uint8Array, n: number): number {
  let c = 0;
  for (let i = 0; i < n; i++) if ((bits[i >> 3]! & (1 << (i & 7))) === 0) c++;
  return c;
}

// --- schema catalog (BJV) -----------------------------------------------------

function stripRuntimeFields<T extends { shareCount?: number; jsImpl?: unknown }>(
  value: T,
): Omit<T, "shareCount" | "jsImpl"> {
  const { shareCount: _sc, jsImpl: _js, ...rest } = value;
  return rest;
}

function writeSchemaCatalog(w: Writer, schema: SchemaData, forceId: (s: string) => number): void {
  const sequences = sortedValues(schema.sequences);
  writeVarintU32(w, sequences.length);
  for (const s of sequences) writeBjv(w, stripRuntimeFields(s), forceId);

  const enums = sortedValues(schema.enums);
  writeVarintU32(w, enums.length);
  for (const e of enums) writeBjv(w, stripRuntimeFields(e), forceId);

  const domains = sortedValues(schema.domains);
  writeVarintU32(w, domains.length);
  for (const d of domains) writeBjv(w, stripRuntimeFields(d), forceId);

  const functionEntries = [...schema.functions.entries()]
    .map(([key, overloads]) => [key, overloads.filter((f) => f.language !== "js")] as const)
    .filter((entry) => entry[1].length > 0)
    .sort((a, b) => compareNames(a[0], b[0]));
  writeVarintU32(w, functionEntries.length);
  for (const [key, overloads] of functionEntries) {
    writeVarintU32(w, forceId(key));
    writeVarintU32(w, overloads.length);
    for (const f of overloads) {
      const { jsImpl: _js, ...meta } = f;
      writeBjv(w, meta satisfies FunctionMetaBjv, forceId);
    }
  }

  const indexes = sortedValues(schema.indexes);
  writeVarintU32(w, indexes.length);
  for (const idx of indexes) writeBjv(w, idx, forceId);
}

function readSchemaCatalog(
  r: Reader,
  schema: SchemaData,
  intern: readonly string[],
  str: (id: number) => string,
): void {
  const seqCount = readVarintU32(r);
  for (let i = 0; i < seqCount; i++) {
    const seq = readBjv(r, intern) as SequenceData;
    schema.sequences.set(seq.name, seq);
  }

  const enumCount = readVarintU32(r);
  for (let i = 0; i < enumCount; i++) {
    const e = readBjv(r, intern) as EnumData;
    schema.enums.set(e.name, e);
  }

  const domainCount = readVarintU32(r);
  for (let i = 0; i < domainCount; i++) {
    const d = readBjv(r, intern) as DomainData;
    schema.domains.set(d.name, d);
  }

  const fnCount = readVarintU32(r);
  for (let i = 0; i < fnCount; i++) {
    const key = str(readVarintU32(r));
    const overloadCount = readVarintU32(r);
    const overloads: FunctionData[] = [];
    for (let oi = 0; oi < overloadCount; oi++) overloads.push(readBjv(r, intern) as FunctionMetaBjv);
    schema.functions.set(key, overloads);
  }

  const indexCount = readVarintU32(r);
  for (let i = 0; i < indexCount; i++) {
    const idx = readBjv(r, intern) as IndexMeta;
    schema.indexes.set(idx.name, idx);
  }
}

// --- helpers -------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateColumnType(value: unknown): asserts value is ColumnMeta["type"] {
  if (!isRecord(value) || typeof value.id !== "string") throw snapshotError();
}

function validateColumnMeta(value: unknown): asserts value is ColumnMeta {
  if (!isRecord(value) || typeof value.name !== "string") throw snapshotError();
  validateColumnType(value.type);
}

function validateTableMetaBjv(value: unknown): asserts value is TableMetaBjv {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.schema !== "string") throw snapshotError();
  if (!Array.isArray(value.columns)) throw snapshotError();
  for (const col of value.columns) validateColumnMeta(col);
}

function validateViewMetaBjv(value: unknown): asserts value is ViewMetaBjv {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.schema !== "string") throw snapshotError();
  if (value.matColumns === null || value.matColumns === undefined) return;
  if (!Array.isArray(value.matColumns)) throw snapshotError();
  for (const col of value.matColumns) {
    if (!isRecord(col) || typeof col.name !== "string" || typeof col.type !== "string") throw snapshotError();
  }
}

function snapshotError(): PostgresError {
  return new PostgresError("snapshot_format", "invalid or truncated postgres-mem snapshot", "XX000");
}

function finiteNowMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const max = 8.64e15;
  if (value > max) return max;
  if (value < -max) return -max;
  return value;
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedValues<T extends { name: string }>(map: Map<string, T>): T[] {
  return [...map.values()].sort((a, b) => compareNames(a.name, b.name));
}

function forceAllEncodeIntern(pool: InternPool, state: DatabaseState, schemas: SchemaData[]): void {
  forceSchemaIntern(pool, schemas);
  for (const [k, v] of state.settings) {
    pool.forceId(k);
    pool.forceId(v);
  }
  if (state.lastSequence) {
    pool.forceId(state.lastSequence.schema);
    pool.forceId(state.lastSequence.name);
  }
  for (const schema of schemas) {
    pool.forceId(schema.name);
    for (const table of sortedValues(schema.tables)) {
      for (const row of table.allRows()) {
        for (const d of row) forceDatumIntern(pool, d);
      }
    }
    for (const view of sortedValues(schema.views)) {
      if (view.matRows) {
        for (const row of view.matRows) {
          for (const d of row) forceDatumIntern(pool, d);
        }
      }
    }
  }
}

function forceDatumIntern(pool: InternPool, value: Datum): void {
  if (value === null) return;
  if (typeof value === "string") {
    pool.forceId(value);
    return;
  }
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "bigint") return;
  if (value instanceof Uint8Array) return;
  switch (value.kind) {
    case "numeric": {
      const min = -0x8000000000000000n;
      const max = 0x7fffffffffffffffn;
      if (value.coef < min || value.coef > max) pool.forceId(value.coef.toString());
      return;
    }
    case "pgarray": {
      pool.forceId(value.elem);
      for (const item of value.items) forceDatumIntern(pool, item);
      return;
    }
    case "pgrecord": {
      for (const t of value.types) pool.forceId(t);
      if (value.names) {
        for (const n of value.names) pool.forceId(n);
      }
      for (const item of value.values) forceDatumIntern(pool, item);
      return;
    }
    case "jsonb":
      pool.forceId(jsonbText(value.value));
      return;
    default:
      return;
  }
}

function forceSchemaIntern(pool: InternPool, schemas: SchemaData[]): void {
  for (const schema of schemas) {
    pool.forceId(schema.name);
    for (const table of sortedValues(schema.tables)) {
      pool.forceId(table.name);
      pool.forceId(table.schema);
      forceBjvStrings(pool, {
        name: table.name,
        schema: table.schema,
        columns: table.columns,
        constraints: table.constraints,
        triggers: table.triggers,
        temp: table.temp,
        oid: table.oid,
      });
    }
    for (const view of sortedValues(schema.views)) {
      pool.forceId(view.name);
      pool.forceId(view.schema);
      forceBjvStrings(pool, {
        name: view.name,
        schema: view.schema,
        query: view.query,
        columns: view.columns,
        materialized: view.materialized,
        matColumns: view.matColumns,
        temp: view.temp,
        oid: view.oid,
      });
    }
    for (const seq of sortedValues(schema.sequences)) {
      pool.forceId(seq.name);
      pool.forceId(seq.schema);
      forceBjvStrings(pool, stripRuntimeFields(seq));
    }
    for (const en of sortedValues(schema.enums)) {
      pool.forceId(en.name);
      pool.forceId(en.schema);
      forceBjvStrings(pool, stripRuntimeFields(en));
    }
    for (const domain of sortedValues(schema.domains)) {
      pool.forceId(domain.name);
      pool.forceId(domain.schema);
      forceBjvStrings(pool, stripRuntimeFields(domain));
    }
    for (const idx of sortedValues(schema.indexes)) {
      pool.forceId(idx.name);
      pool.forceId(idx.schema);
      pool.forceId(idx.table);
      forceBjvStrings(pool, idx);
    }
    for (const [key, overloads] of schema.functions) {
      pool.forceId(key);
      for (const fn of overloads) {
        if (fn.language === "js") continue;
        const { jsImpl: _js, ...meta } = fn;
        forceBjvStrings(pool, meta);
      }
    }
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

registerCodec({ encodeDatabaseState, decodeDatabaseState });
