import { PostgresError } from "../errors/error.ts";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export function utf8Encode(s: string): Uint8Array {
  return TEXT_ENCODER.encode(s);
}

export function utf8Decode(b: Uint8Array): string {
  return TEXT_DECODER.decode(b);
}

// --- varint -------------------------------------------------------------------

export function writeVarintU32(w: Writer, value: number): void {
  let v = value >>> 0;
  while (v >= 0x80) {
    w.u8((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  w.u8(v);
}

export function readVarintU32(r: Reader): number {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = r.u8();
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result >>> 0;
    shift += 7;
    if (shift > 28) r.fail();
  }
}

// --- Writer -------------------------------------------------------------------

export class Writer {
  private buf: Uint8Array;
  private view: DataView;
  private len = 0;

  constructor(capacity = 4096) {
    this.buf = new Uint8Array(capacity);
    this.view = new DataView(this.buf.buffer);
  }

  get position(): number {
    return this.len;
  }

  reserve(capacity: number): void {
    if (capacity <= this.buf.length) return;
    const next = new Uint8Array(capacity);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  private ensure(needed: number): void {
    if (this.len + needed <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + needed) cap *= 2;
    this.reserve(cap);
  }

  align4(): void {
    const pad = (4 - (this.len & 3)) & 3;
    for (let i = 0; i < pad; i++) this.u8(0);
  }

  u8(value: number): void {
    this.ensure(1);
    this.buf[this.len++] = value & 0xff;
  }

  u32(value: number): void {
    this.ensure(4);
    this.view.setUint32(this.len, value >>> 0, true);
    this.len += 4;
  }

  i32(value: number): void {
    this.u32(value | 0);
  }

  u64(value: bigint): void {
    this.ensure(8);
    this.view.setBigUint64(this.len, BigInt.asUintN(64, value), true);
    this.len += 8;
  }

  i64(value: bigint): void {
    this.ensure(8);
    this.view.setBigInt64(this.len, value, true);
    this.len += 8;
  }

  f64(value: number): void {
    this.ensure(8);
    this.view.setFloat64(this.len, value, true);
    this.len += 8;
  }

  raw(value: Uint8Array): void {
    this.ensure(value.length);
    this.buf.set(value, this.len);
    this.len += value.length;
  }

  /** Length-prefixed UTF-8. */
  text(value: string): void {
    const encoded = utf8Encode(value);
    writeVarintU32(this, encoded.length);
    this.raw(encoded);
  }

  /** Write UTF-8 at current position without length prefix (intern blob region). */
  textBytes(value: string): void {
    this.raw(utf8Encode(value));
  }

  finish(): Uint8Array {
    if (this.len === this.buf.length) return this.buf;
    return this.buf.subarray(0, this.len).slice();
  }

  fail(): never {
    throw new PostgresError("snapshot_format", "invalid or truncated postgres-mem snapshot", "XX000");
  }
}

// --- Reader -------------------------------------------------------------------

export class Reader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get position(): number {
    return this.offset;
  }

  skipAlign4(): void {
    const pad = (4 - (this.offset & 3)) & 3;
    this.offset += pad;
  }

  u8(): number {
    if (this.offset >= this.bytes.length) this.fail();
    return this.bytes[this.offset++]!;
  }

  u32(): number {
    if (this.offset + 4 > this.bytes.length) this.fail();
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  i32(): number {
    return this.u32() | 0;
  }

  u64(): bigint {
    if (this.offset + 8 > this.bytes.length) this.fail();
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }

  i64(): bigint {
    if (this.offset + 8 > this.bytes.length) this.fail();
    const value = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return value;
  }

  f64(): number {
    if (this.offset + 8 > this.bytes.length) this.fail();
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  raw(length: number): Uint8Array {
    if (length < 0 || this.offset + length > this.bytes.length) this.fail();
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  text(): string {
    const length = readVarintU32(this);
    return utf8Decode(this.raw(length));
  }

  remaining(): number {
    return this.bytes.length - this.offset;
  }

  done(): boolean {
    return this.offset === this.bytes.length;
  }

  fail(): never {
    throw new PostgresError("snapshot_format", "invalid or truncated postgres-mem snapshot", "XX000");
  }
}

// --- binary JSON (BJV) ------------------------------------------------------

const BJV_NULL = 0;
const BJV_FALSE = 1;
const BJV_TRUE = 2;
const BJV_I32 = 3;
const BJV_I64 = 4;
const BJV_F64 = 5;
const BJV_INTERN = 6;
const BJV_STRING = 7;
const BJV_BYTES = 8;
const BJV_ARRAY = 9;
const BJV_OBJECT = 10;

export function writeBjv(w: Writer, value: unknown, forceIntern: (s: string) => number): void {
  if (value === null || value === undefined) {
    w.u8(BJV_NULL);
    return;
  }
  if (typeof value === "boolean") {
    w.u8(value ? BJV_TRUE : BJV_FALSE);
    return;
  }
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff) {
      w.u8(BJV_I32);
      w.u32(value | 0);
      return;
    }
    w.u8(BJV_F64);
    w.f64(value);
    return;
  }
  if (typeof value === "bigint") {
    w.u8(BJV_I64);
    w.i64(value);
    return;
  }
  if (typeof value === "string") {
    w.u8(BJV_INTERN);
    writeVarintU32(w, forceIntern(value));
    return;
  }
  if (value instanceof Uint8Array) {
    w.u8(BJV_BYTES);
    writeVarintU32(w, value.length);
    w.raw(value);
    return;
  }
  if (Array.isArray(value)) {
    w.u8(BJV_ARRAY);
    writeVarintU32(w, value.length);
    for (const item of value) writeBjv(w, item, forceIntern);
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    w.u8(BJV_OBJECT);
    writeVarintU32(w, entries.length);
    for (const [k, v] of entries) {
      w.u8(BJV_INTERN);
      writeVarintU32(w, forceIntern(k));
      writeBjv(w, v, forceIntern);
    }
    return;
  }
  w.u8(BJV_NULL);
}

export function readBjv(r: Reader, intern: readonly string[]): unknown {
  const tag = r.u8();
  switch (tag) {
    case BJV_NULL:
      return null;
    case BJV_FALSE:
      return false;
    case BJV_TRUE:
      return true;
    case BJV_I32:
      return r.u32() | 0;
    case BJV_I64:
      return r.i64();
    case BJV_F64:
      return r.f64();
    case BJV_INTERN:
      return intern[readVarintU32(r)] ?? "";
    case BJV_STRING:
      return r.text();
    case BJV_BYTES:
      return r.raw(readVarintU32(r)).slice();
    case BJV_ARRAY: {
      const count = readVarintU32(r);
      const out: unknown[] = new Array(count);
      for (let i = 0; i < count; i++) out[i] = readBjv(r, intern);
      return out;
    }
    case BJV_OBJECT: {
      const count = readVarintU32(r);
      const out: Record<string, unknown> = {};
      for (let i = 0; i < count; i++) {
        const key = readBjv(r, intern) as string;
        out[key] = readBjv(r, intern);
      }
      return out;
    }
    default:
      return r.fail();
  }
}

// --- adaptive intern ----------------------------------------------------------

export class InternPool {
  private readonly counts = new Map<string, number>();
  private readonly ids = new Map<string, number>();
  readonly list: string[] = [];

  constructor() {
    this.list.push("");
    this.ids.set("", 0);
  }

  count(s: string): void {
    this.counts.set(s, (this.counts.get(s) ?? 0) + 1);
  }

  /** Assign ids only to strings seen ≥2 times (plus empty string). */
  finalize(): void {
    for (const [s, c] of this.counts) {
      if (c >= 2 && !this.ids.has(s)) {
        const id = this.list.length;
        this.ids.set(s, id);
        this.list.push(s);
      }
    }
  }

  /** Always intern (schema / catalog strings). */
  forceId(s: string): number {
    const hit = this.ids.get(s);
    if (hit !== undefined) return hit;
    const id = this.list.length;
    this.ids.set(s, id);
    this.list.push(s);
    return id;
  }

  id(s: string): number {
    const hit = this.ids.get(s);
    if (hit !== undefined) return hit;
    return -1;
  }
}

/** Write intern table: count, offsets[], concatenated UTF-8 blob. */
export function writeInternTable(w: Writer, strings: readonly string[]): void {
  writeVarintU32(w, strings.length);
  if (strings.length === 0) return;
  const offsets: number[] = [];
  let total = 0;
  for (const s of strings) {
    offsets.push(total);
    total += utf8Encode(s).length;
  }
  writeVarintU32(w, total);
  const base = w.position + offsets.length * 4;
  for (const off of offsets) w.u32(base + off);
  for (const s of strings) w.textBytes(s);
}

export function readInternTable(r: Reader): string[] {
  const count = readVarintU32(r);
  if (count === 0) return [];
  const total = readVarintU32(r);
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) offsets.push(r.u32());
  const blobStart = r.position;
  const blob = r.raw(total);
  const intern: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const start = offsets[i]! - blobStart;
    const end = i + 1 < count ? offsets[i + 1]! - blobStart : total;
    intern[i] = utf8Decode(blob.subarray(start, end));
  }
  return intern;
}
