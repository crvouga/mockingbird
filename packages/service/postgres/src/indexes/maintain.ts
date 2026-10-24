import { type UniqueSpec, uniqueKeyOf, uniqueSpecsFor } from "../constraints/enforce.ts";
import type { ExecEnv } from "../executor/relation.ts";
import type { TableData } from "../storage/database-state.ts";
import type { Datum } from "../types/value.ts";
import { IndexStore } from "./index.ts";

export function invalidateTableIndexes(table: TableData): void {
  table.indexStores = null;
}

/** Retain pure derived indexes in the frozen source so rollback need not rebuild them. */
export function prepareDmlIndexStores(env: ExecEnv, table: TableData): void {
  if (table.indexStores || !table.frozen || table.triggers.length > 0) return;
  const specs = uniqueSpecsFor(env, table);
  // Expression/partial keys can invoke user code; preserve their existing evaluation order.
  if (specs.some((spec) => spec.where || spec.keys.some((key) => key.expr))) return;
  ensureIndexStores(env, table);
}

function ensureIndexStores(env: ExecEnv, table: TableData): Map<string, IndexStore> {
  if (table.indexStores) return table.indexStores;
  const stores = new Map<string, IndexStore>();
  for (const spec of uniqueSpecsFor(env, table)) {
    const store = new IndexStore(spec.name, true);
    for (let i = 0; i < table.rowCount(); i++) {
      const key = uniqueKeyOf(env, table, spec, table.rowAt(i));
      if (key !== null) store.insert(key, i);
    }
    stores.set(spec.name, store);
  }
  const schema = env.ctx.state.schemas.get(table.schema);
  if (schema) {
    for (const idx of schema.indexes.values()) {
      if (idx.table !== table.name || idx.unique) continue;
      stores.set(idx.name, new IndexStore(idx.name, false));
    }
  }
  table.indexStores = stores;
  return stores;
}

export function indexStoreFor(env: ExecEnv, table: TableData, spec: UniqueSpec): IndexStore {
  const stores = ensureIndexStores(env, table);
  let store = stores.get(spec.name);
  if (!store) {
    store = new IndexStore(spec.name, true);
    for (let i = 0; i < table.rowCount(); i++) {
      const key = uniqueKeyOf(env, table, spec, table.rowAt(i));
      if (key !== null) store.insert(key, i);
    }
    stores.set(spec.name, store);
  }
  return store;
}

export function indexInsertRow(env: ExecEnv, table: TableData, rowIdx: number, row: Datum[]): void {
  for (const spec of uniqueSpecsFor(env, table)) {
    const key = uniqueKeyOf(env, table, spec, row);
    if (key === null) continue;
    indexStoreFor(env, table, spec).insert(key, rowIdx);
  }
}

export function indexRemoveRow(env: ExecEnv, table: TableData, rowIdx: number, row: Datum[]): void {
  if (!table.indexStores) return;
  for (const spec of uniqueSpecsFor(env, table)) {
    const key = uniqueKeyOf(env, table, spec, row);
    if (key === null) continue;
    table.indexStores.get(spec.name)?.remove(key, rowIdx);
  }
}

export function indexUpdateRow(env: ExecEnv, table: TableData, rowIdx: number, oldRow: Datum[], newRow: Datum[]): void {
  const specs = uniqueSpecsFor(env, table);
  if (specs.some((spec) => spec.where || spec.keys.some((key) => key.expr))) {
    // Preserve evaluation order for expression/partial predicates, including user functions.
    indexRemoveRow(env, table, rowIdx, oldRow);
    indexInsertRow(env, table, rowIdx, newRow);
    return;
  }
  for (const spec of specs) {
    const before = uniqueKeyOf(env, table, spec, oldRow);
    const after = uniqueKeyOf(env, table, spec, newRow);
    if (before === after) continue;
    if (before !== null) table.indexStores?.get(spec.name)?.remove(before, rowIdx);
    if (after !== null) indexStoreFor(env, table, spec).insert(after, rowIdx);
  }
}

export function rebuildTableIndexes(env: ExecEnv, table: TableData): void {
  table.indexStores = null;
  ensureIndexStores(env, table);
}
