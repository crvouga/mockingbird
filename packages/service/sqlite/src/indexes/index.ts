import { SqliteError } from "../errors/index.ts";
import type { Rowid } from "../storage/row.ts";
import { compareSql, isSqlJsonText, isSqlReal, type SqlValue } from "../types/value.ts";

export class IndexStore {
  readonly name: string;
  private entries: Map<string, Rowid[]>;
  private keyValues: Map<string, SqlValue[]>;
  private sortedKeys: string[] | null;
  private mapsShared = false;
  frozen = false;

  constructor(
    name = "index",
    entries?: ReadonlyMap<string, readonly Rowid[]>,
    keyValues?: ReadonlyMap<string, readonly SqlValue[]>,
  ) {
    this.name = name;
    this.entries = new Map();
    this.keyValues = new Map();
    this.sortedKeys = null;
    if (entries) {
      for (const [key, rowids] of entries) this.entries.set(key, [...rowids]);
    }
    if (keyValues) {
      for (const [key, values] of keyValues) this.keyValues.set(key, [...values]);
    }
  }

  checkUnique(values: readonly SqlValue[], rowid?: Rowid): void {
    // SQLite treats NULLs as distinct for UNIQUE; skip conflict checks.
    if (values.some((value) => value === null)) return;
    const key = serializeIndexEntry(values);
    const existing = this.entries.get(key);
    if (!existing) return;
    for (const id of existing) {
      if (rowid === undefined || !sameRowid(id, rowid)) {
        throw new SqliteError(
          `UNIQUE constraint failed: ${this.name}`,
          "constraint_unique",
          "SQLITE_CONSTRAINT_UNIQUE",
        );
      }
    }
  }

  insert(values: readonly SqlValue[], rowid: Rowid, unique = true): void {
    this.assertMutable();
    const key = serializeIndexEntry(values);
    if (unique) this.checkUnique(values, rowid);
    const existing = this.entries.get(key);
    if (!existing) {
      this.entries.set(key, [rowid]);
      this.keyValues.set(key, [...values]);
      this.sortedKeys = null;
      return;
    }
    for (const id of existing) if (sameRowid(id, rowid)) return;
    existing.push(rowid);
  }

  lookup(values: readonly SqlValue[]): readonly Rowid[] {
    // SQL `=` never matches NULL; IS NULL is a different access path.
    if (values.some((value) => value === null)) return [];
    const key = serializeIndexEntry(values);
    return this.entries.get(key) ?? [];
  }

  /** Leftmost prefix match: INDEX(a,b) used for WHERE a = ?. */
  lookupPrefix(values: readonly SqlValue[]): readonly Rowid[] {
    if (values.length === 0) return [];
    if (values.some((value) => value === null)) return [];
    const prefix = serializeIndexEntry(values);
    const exact = this.entries.get(prefix);
    const rowids: Rowid[] = exact ? [...exact] : [];
    const keys = this.orderedKeys();
    let start = 0;
    let end = keys.length;
    while (start < end) {
      const mid = (start + end) >>> 1;
      const kv = this.keyValues.get(keys[mid]!);
      if (!kv || prefixKeyLess(kv, values)) start = mid + 1;
      else end = mid;
    }
    for (let i = start; i < keys.length; i++) {
      const kv = this.keyValues.get(keys[i]!);
      if (!kv || !prefixKeyMatches(kv, values)) break;
      const key = keys[i]!;
      if (key === prefix) continue;
      rowids.push(...(this.entries.get(key) ?? []));
    }
    return rowids;
  }

  /**
   * Ordered scan of rowids for a single-column comparison.
   * `op` applies to the first key component.
   */
  rangeLookup(op: ">" | ">=" | "<" | "<=" | "between", bound: SqlValue, bound2?: SqlValue): readonly Rowid[] {
    const keys = this.orderedKeys();
    const rowids: Rowid[] = [];
    const start = lowerBoundKeyValues(keys, this.keyValues, bound, op === ">" ? "gt" : op === ">=" ? "ge" : "any");
    const end =
      op === "<" || op === "<="
        ? upperBoundKeyValues(keys, this.keyValues, bound, op === "<" ? "lt" : "le")
        : op === "between" && bound2 !== undefined
          ? upperBoundKeyValues(keys, this.keyValues, bound2, "le")
          : keys.length;
    for (let i = start; i < end; i++) {
      const key = keys[i]!;
      const values = this.keyValues.get(key);
      if (!values || values[0] === undefined || values[0] === null) continue;
      const cmp = compareSerializedOrder(values[0], bound);
      let ok = false;
      if (op === ">") ok = cmp > 0;
      else if (op === ">=") ok = cmp >= 0;
      else if (op === "<") ok = cmp < 0;
      else if (op === "<=") ok = cmp <= 0;
      else if (op === "between" && bound2 !== undefined) {
        ok = cmp >= 0 && compareSerializedOrder(values[0], bound2) <= 0;
      }
      if (ok) {
        const ids = this.entries.get(key);
        if (ids) rowids.push(...ids);
      }
    }
    return rowids;
  }

  orderedRowids(desc = false): readonly Rowid[] {
    const keys = this.orderedKeys();
    const rowids: Rowid[] = [];
    const seq = desc ? [...keys].reverse() : keys;
    for (const key of seq) {
      const ids = this.entries.get(key);
      if (ids) rowids.push(...ids);
    }
    return rowids;
  }

  remove(values: readonly SqlValue[], rowid?: Rowid): boolean {
    this.assertMutable();
    const key = serializeIndexEntry(values);
    const existing = this.entries.get(key);
    if (!existing) return false;
    if (rowid === undefined) {
      this.entries.delete(key);
      this.keyValues.delete(key);
      this.sortedKeys = null;
      return true;
    }
    const index = existing.findIndex((id) => sameRowid(id, rowid));
    if (index < 0) return false;
    existing.splice(index, 1);
    if (existing.length === 0) {
      this.entries.delete(key);
      this.keyValues.delete(key);
      this.sortedKeys = null;
    }
    return true;
  }

  clear(): void {
    this.assertMutable();
    this.entries.clear();
    this.keyValues.clear();
    this.sortedKeys = null;
  }

  clone(): IndexStore {
    const copy = new IndexStore(this.name);
    copy.entries = this.entries;
    copy.keyValues = this.keyValues;
    copy.sortedKeys = this.sortedKeys;
    copy.mapsShared = true;
    return copy;
  }

  freeze(): void {
    this.frozen = true;
  }

  /** Sorted entries for SQLM v3 persistence. */
  snapshotEntries(): Array<{ key: string; rowids: Rowid[]; values: SqlValue[] }> {
    const keys = [...this.entries.keys()].sort();
    return keys.map((key) => ({
      key,
      rowids: [...(this.entries.get(key) ?? [])],
      values: [...(this.keyValues.get(key) ?? [])],
    }));
  }

  /** Sorted keys + rowids for SQLM v4 (values rebuilt from the table). */
  snapshotKeys(): Array<{ key: string; rowids: Rowid[] }> {
    const keys = [...this.entries.keys()].sort();
    return keys.map((key) => ({
      key,
      rowids: [...(this.entries.get(key) ?? [])],
    }));
  }

  rememberKeyValues(key: string, values: readonly SqlValue[]): void {
    this.keyValues.set(key, [...values]);
  }

  /** Key component values for snapshot encode (binary keys). */
  keyValuesFor(key: string): SqlValue[] {
    return [...(this.keyValues.get(key) ?? [])];
  }

  get size(): number {
    return this.entries.size;
  }

  private orderedKeys(): string[] {
    if (this.sortedKeys) return this.sortedKeys;
    const keys = [...this.entries.keys()];
    keys.sort((a, b) => {
      const left = this.keyValues.get(a);
      const right = this.keyValues.get(b);
      if (!left || !right) return a < b ? -1 : a > b ? 1 : 0;
      const n = Math.min(left.length, right.length);
      for (let i = 0; i < n; i++) {
        const a = left[i] ?? null;
        const b = right[i] ?? null;
        if (a === null && b === null) continue;
        if (a === null) return -1;
        if (b === null) return 1;
        const cmp = compareSql(a, b);
        if (cmp !== 0) return cmp ?? 0;
      }
      return left.length - right.length;
    });
    this.sortedKeys = keys;
    return keys;
  }

  private assertMutable(): void {
    if (this.frozen) throw new SqliteError("internal: cannot mutate a frozen index", "other");
    this.forkMaps();
  }

  private forkMaps(): void {
    if (!this.mapsShared) return;
    const entries = new Map<string, Rowid[]>();
    for (const [key, rowids] of this.entries) entries.set(key, [...rowids]);
    const keyValues = new Map<string, SqlValue[]>();
    for (const [key, values] of this.keyValues) keyValues.set(key, [...values]);
    this.entries = entries;
    this.keyValues = keyValues;
    this.mapsShared = false;
    this.sortedKeys = null;
  }
}

/** Hash-join / covering-hash key: NULL components never match. */
export function serializeIndexKey(values: readonly SqlValue[]): string | null {
  if (values.some((value) => value === null)) return null;
  return serializeIndexEntry(values);
}

/** Index-store key: NULL is a distinct component so composite prefix lookups still hit. */
export function serializeIndexEntry(values: readonly SqlValue[]): string {
  return values
    .map((value) => {
      const part = value === null ? NULL_PART : serializeValue(value);
      return `${part.length}:${part}`;
    })
    .join("|");
}

/** Dedicated tag; non-NULL encodings stay `t:` / `n:` / `f:` / `b:` (SQLM v3 compatible). */
const NULL_PART = "z";

function serializeValue(value: Exclude<SqlValue, null>): string {
  if (isSqlReal(value)) {
    const n = value.value;
    if (Number.isNaN(n)) return "f:nan";
    if (n === Infinity) return "f:+inf";
    if (n === -Infinity) return "f:-inf";
    return `f:${Object.is(n, -0) ? "0" : n.toString()}`;
  }
  if (isSqlJsonText(value)) return `t:${value.value}`;
  if (typeof value === "bigint") return `n:${value.toString()}`;
  if (typeof value === "number") {
    if (Number.isInteger(value)) return `n:${BigInt(value).toString()}`;
    if (Number.isNaN(value)) return "f:nan";
    if (value === Infinity) return "f:+inf";
    if (value === -Infinity) return "f:-inf";
    return `f:${Object.is(value, -0) ? "0" : value.toString()}`;
  }
  if (typeof value === "string") return `t:${value}`;
  let hex = "";
  for (const byte of value) hex += byte.toString(16).padStart(2, "0");
  return `b:${hex}`;
}

function compareSerializedOrder(left: SqlValue, right: SqlValue): number {
  return compareSql(left, right) ?? 0;
}

function prefixKeyLess(keyValues: readonly SqlValue[], prefix: readonly SqlValue[]): boolean {
  for (let i = 0; i < prefix.length; i++) {
    const cmp = compareSerializedOrder(keyValues[i] ?? null, prefix[i]!);
    if (cmp !== 0) return cmp < 0;
  }
  return false;
}

function prefixKeyMatches(keyValues: readonly SqlValue[], prefix: readonly SqlValue[]): boolean {
  for (let i = 0; i < prefix.length; i++) {
    if (compareSerializedOrder(keyValues[i] ?? null, prefix[i]!) !== 0) return false;
  }
  return true;
}

function lowerBoundKeyValues(
  keys: readonly string[],
  keyValues: ReadonlyMap<string, SqlValue[]>,
  bound: SqlValue,
  mode: "gt" | "ge" | "any",
): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const value = keyValues.get(keys[mid]!)?.[0];
    if (value === undefined || value === null) {
      lo = mid + 1;
      continue;
    }
    const cmp = compareSerializedOrder(value, bound);
    const before = mode === "gt" ? cmp <= 0 : mode === "ge" ? cmp < 0 : false;
    if (before) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBoundKeyValues(
  keys: readonly string[],
  keyValues: ReadonlyMap<string, SqlValue[]>,
  bound: SqlValue,
  mode: "lt" | "le",
): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const value = keyValues.get(keys[mid]!)?.[0];
    if (value === undefined || value === null) {
      lo = mid + 1;
      continue;
    }
    const cmp = compareSerializedOrder(value, bound);
    const after = mode === "lt" ? cmp >= 0 : cmp > 0;
    if (after) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function sameRowid(left: Rowid, right: Rowid): boolean {
  return typeof left === "bigint" || typeof right === "bigint" ? BigInt(left) === BigInt(right) : left === right;
}
