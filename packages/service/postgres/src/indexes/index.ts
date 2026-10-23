import { pgError } from "../errors/error.ts";

/** Btree / hash index over row indices. Keys are pre-serialized (datumKey tuples). */
export class IndexStore {
  readonly name: string;
  readonly unique: boolean;
  private entries = new Map<string, number[]>();

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
    this.entries = new Map(this.entries);
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

  clear(): void {
    this.entries = new Map();
    this.shared = false;
  }

  clone(): IndexStore {
    const copy = new IndexStore(this.name, this.unique);
    copy.entries = this.entries;
    copy.shared = true;
    this.shared = true;
    this.ownedBuckets = new WeakSet();
    return copy;
  }
}
