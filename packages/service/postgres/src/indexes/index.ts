import { ForkMap } from "@crvouga/mockingbird-core";
import { pgError } from "../errors/error.ts";

/** Btree / hash index over row indices. Keys are pre-serialized (datumKey tuples). */
export class IndexStore {
  readonly name: string;
  readonly unique: boolean;
  private entries: Map<string, number[]> = new Map();
  private integerKeys: { value: number; rows: readonly number[] }[] | null = null;

  private shared = false;
  private ownedBuckets = new WeakSet<number[]>();

  private writableBucket(key: string, bucket: number[]): number[] {
    if (this.ownedBuckets.has(bucket)) return bucket;
    const copy = bucket.slice();
    this.entries.set(key, copy);
    this.ownedBuckets.add(copy);
    return copy;
  }

  private detach(): void {
    if (!this.shared) return;
    if (!(this.entries instanceof ForkMap)) this.entries = new Map(this.entries);
    this.shared = false;
  }

  constructor(name: string, unique = false) {
    this.name = name;
    this.unique = unique;
  }

  get size(): number {
    return this.entries.size;
  }

  checkUnique(key: string, rowIdx?: number): void {
    const existing = this.entries.get(key);
    if (!existing) return;
    for (const i of existing) {
      if (rowIdx === undefined || i !== rowIdx) {
        throw pgError("constraint_unique", `duplicate key value violates unique constraint "${this.name}"`, "23505");
      }
    }
  }

  insert(key: string, rowIdx: number): void {
    if (this.unique) this.checkUnique(key, rowIdx);
    this.detach();
    this.integerKeys = null;
    const existing = this.entries.get(key);
    if (!existing) {
      const bucket = [rowIdx];
      this.ownedBuckets.add(bucket);
      this.entries.set(key, bucket);
      return;
    }
    if (existing.includes(rowIdx)) return;
    this.writableBucket(key, existing).push(rowIdx);
  }

  remove(key: string, rowIdx: number): void {
    const existing = this.entries.get(key);
    if (!existing) return;
    const at = existing.indexOf(rowIdx);
    if (at < 0) return;
    this.detach();
    this.integerKeys = null;
    if (existing.length === 1) this.entries.delete(key);
    else {
      const remaining = this.writableBucket(key, existing);
      remaining.splice(at, 1);
      this.entries.set(key, remaining);
    }
  }

  lookup(key: string): readonly number[] {
    return this.entries.get(key) ?? [];
  }

  /** Ordered access for a single int2/int4 key (the planner validates the key type). */
  integerRange(lower: number, upper: number, includeLower: boolean, includeUpper: boolean): number[] {
    const keys = (this.integerKeys ??= [...this.entries]
      .map(([key, rows]) => ({ value: Number(key.slice(1)), rows }))
      .sort((a, b) => a.value - b.value));
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const value = keys[mid]!.value;
      if (value < lower || (!includeLower && value === lower)) lo = mid + 1;
      else hi = mid;
    }
    const result: number[] = [];
    for (let i = lo; i < keys.length; i++) {
      const key = keys[i]!;
      if (key.value > upper || (!includeUpper && key.value === upper)) break;
      result.push(...key.rows);
    }
    // Preserve heap scan order before projection (including volatile SELECT targets).
    return result.sort((a, b) => a - b);
  }

  clear(): void {
    this.entries = new Map();
    this.shared = false;
    this.integerKeys = null;
  }

  clone(): IndexStore {
    const copy = new IndexStore(this.name, this.unique);
    if (this.entries.size >= 4096 && !(this.entries instanceof ForkMap)) this.entries = new ForkMap(this.entries);
    copy.entries = this.entries instanceof ForkMap ? this.entries.fork() : this.entries;
    copy.integerKeys = this.integerKeys;
    copy.shared = true;
    this.shared = true;
    this.ownedBuckets = new WeakSet();
    return copy;
  }
}
