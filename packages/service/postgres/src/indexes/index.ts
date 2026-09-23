import { pgError } from "../errors/error.ts";

/** Btree / hash index over row indices. Keys are pre-serialized (datumKey tuples). */
export class IndexStore {
  readonly name: string;
  readonly unique: boolean;
  private entries = new Map<string, number[]>();

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
    const existing = this.entries.get(key);
    if (!existing) {
      this.entries.set(key, [rowIdx]);
      return;
    }
    if (existing.includes(rowIdx)) return;
    existing.push(rowIdx);
  }

  remove(key: string, rowIdx: number): void {
    const existing = this.entries.get(key);
    if (!existing) return;
    const at = existing.indexOf(rowIdx);
    if (at < 0) return;
    existing.splice(at, 1);
    if (existing.length === 0) this.entries.delete(key);
  }

  lookup(key: string): readonly number[] {
    return this.entries.get(key) ?? [];
  }

  clear(): void {
    this.entries.clear();
  }

  clone(): IndexStore {
    const copy = new IndexStore(this.name, this.unique);
    for (const [key, rowids] of this.entries) copy.entries.set(key, [...rowids]);
    return copy;
  }
}
