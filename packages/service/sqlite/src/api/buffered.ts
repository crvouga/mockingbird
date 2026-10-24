import {
  type BufferedDurabilityOptions,
  type BufferedDurable,
  browserDurabilityLifecycle,
  encodeDurableCheckpoint,
  type IncrementalCapture,
  type IncrementalDurabilityCodec,
  IndexedDBDurabilityBackend,
  openBufferedDurable,
  packDurableRecord,
  readDurableJournal,
  unpackDurableRecord,
} from "@crvouga/mockingbird-core";
import { SqliteError } from "../errors/index.ts";
import { IndexStore } from "../indexes/index.ts";
import { rebuildIndexFromTable, tableRowEvalContext } from "../indexes/keys.ts";
import { encodeDatabaseState } from "../serialization/codec.ts";
import type { DatabaseState, TriggerInfo } from "../storage/database-state.ts";
import type { Table } from "../storage/table.ts";
import { Database, type DatabaseOptions, Snapshot } from "./database.ts";
import type { DurableDatabaseOptions } from "./durable.ts";
import { captureSnapshot } from "./snapshot.ts";

export interface BufferedDurableDatabaseOptions extends DurableDatabaseOptions, BufferedDurabilityOptions {}

type Extra = { userVersion: number; caseSensitiveLike: boolean; triggers: [string, TriggerInfo][] };
type RecordMeta = Extra & { checkpoint: boolean; deleted: [string, string[]][] };
interface Token {
  state: DatabaseState;
  metadata: Uint8Array;
  tables: Map<string, Pick<Table, "durableChanges">>;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
function extra(state: DatabaseState): Extra {
  return { userVersion: state.userVersion, caseSensitiveLike: state.caseSensitiveLike, triggers: [...state.triggers] };
}
function applyExtra(state: DatabaseState, meta: Extra): void {
  state.userVersion = meta.userVersion;
  state.caseSensitiveLike = meta.caseSensitiveLike;
  state.triggers = new Map(meta.triggers);
}

/** @internal Immediate writers preserve metadata when opening the opt-in envelope. */
export function encodeBufferedCheckpoint(db: Database): Uint8Array {
  const snap = captureSnapshot(db.engineState, db.prng, db.now, db.seed, db.randomMode, db.systemClock);
  return encodeDurableCheckpoint(
    packDurableRecord({ ...extra(snap.state), checkpoint: true, deleted: [] } satisfies RecordMeta, snap.encode()),
  );
}

/** Also used by the legacy opener: mode changes never make existing images unreadable. */
export function decodeBufferedDatabase(bytes: Uint8Array, options?: DatabaseOptions): Database {
  const records = readDurableJournal(bytes);
  return records ? recover(records, options) : Snapshot.decode(bytes).open(options);
}

function recover(records: readonly Uint8Array[], options?: DatabaseOptions): Database {
  let db: Database | undefined;
  let rebuild = false;
  try {
    for (const bytes of records) {
      const { metadata, snapshot } = unpackDurableRecord<RecordMeta>(bytes);
      const next = Snapshot.decode(snapshot).open(options);
      applyExtra(next.engineState, metadata);
      if (!metadata.checkpoint) {
        if (!db) throw new Error("Missing buffered checkpoint");
        const deleted = new Map(metadata.deleted);
        for (const [name, table] of next.engineState.tables) {
          const source = db.engineState.tables.get(name);
          if (!source) throw new Error("Invalid incremental table");
          const changed = [...table.scan()];
          table.adoptDurableRows(source);
          for (const id of deleted.get(name) ?? []) table.delete(BigInt(id));
          for (const row of changed) table.restoreDurableRow(row);
        }
        rebuild = true;
      } else rebuild = false;
      db?.close();
      db = next;
    }
    if (!db) throw new Error("Missing buffered checkpoint");
    if (rebuild)
      for (const index of db.engineState.indexes.values()) {
        const table = db.engineState.getTable(index.tableName);
        // Incremental captures admit only simple column indexes, so no functions execute here.
        rebuildIndexFromTable(db.engineState.getWritableIndex(index.name), table, (row) =>
          tableRowEvalContext(table, row),
        );
      }
    const snap = captureSnapshot(db.engineState, db.prng, db.now, db.seed, db.randomMode, db.systemClock);
    const result = snap.open(options);
    db.close();
    return result;
  } catch (error) {
    db?.close();
    throw error;
  }
}

function codec(
  options: BufferedDurableDatabaseOptions,
  closeBackend: () => Promise<void>,
): IncrementalDurabilityCodec<Database, Token> {
  let exposed = false;
  function capture(
    db: Database,
    previous: Token | undefined,
    checkpoint: boolean,
    baselineOnly = false,
  ): IncrementalCapture<Token> {
    db.assertOpen();
    if (db.transactions.inTransaction) throw new SqliteError("cannot persist during a transaction", "transaction");
    const state = db.engineState;
    checkpoint ||=
      exposed ||
      !previous ||
      state.schemaVersion !== previous.state.schemaVersion ||
      state.tables.size !== previous.tables.size ||
      state.virtualTables.size > 0 ||
      state.attached.size > 0 ||
      [...state.indexes.values()].some((index) => index.where || index.columns.some((column) => column.expr)) ||
      [...state.tables].some(
        ([name, table]) => table.durableUnsafe || !table.durableChanges || !previous?.tables.has(name),
      );
    for (const table of state.tables.values()) table.enableDurabilityTracking();
    const snap = captureSnapshot(state, db.prng, db.now, db.seed, db.randomMode, db.systemClock);
    const metadataState = snap.state.cloneShallow();
    metadataState.tables = new Map([...snap.state.tables].map(([name, table]) => [name, table.emptyForDurability()]));
    metadataState.indexes = new Map(
      [...snap.state.indexes].map(([name, index]) => [name, { ...index, store: new IndexStore(index.name) }]),
    );
    const runtime = { prngState: snap.prngState, nowMs: snap.nowMs };
    const extras = extra(snap.state);
    const metadata = packDurableRecord(extras, encodeDatabaseState(metadataState, runtime));
    // Transaction rollback may thaw a live Table also retained by a capture. Keep
    // the comparison journal independently forked, rather than observing that Table.
    const token: Token = {
      state: snap.state,
      metadata,
      tables: new Map(
        [...snap.state.tables].map(([name, table]) => [name, { durableChanges: table.durableChanges!.fork() }]),
      ),
    };
    if (baselineOnly) return { token, checkpoint: true };
    const deleted: [string, string[]][] = [];
    let changed = false;
    if (!checkpoint)
      for (const [name, table] of snap.state.tables) {
        const removed: string[] = [];
        for (const change of table.durableChanges!.changes(previous?.tables.get(name)?.durableChanges ?? undefined)) {
          if (change.deleted) continue; // Acknowledged tracking entries were reclaimed.
          changed = true;
          if (change.value) metadataState.tables.get(name)!.restoreDurableRow(change.value);
          else removed.push(String(change.key));
        }
        if (removed.length) deleted.push([name, removed]);
      }
    if (!checkpoint && !changed && previous && same(metadata, previous.metadata)) return { token, checkpoint: false };
    return {
      token,
      checkpoint,
      bytes: packDurableRecord(
        { ...extras, checkpoint, deleted } satisfies RecordMeta,
        checkpoint ? snap.encode() : encodeDatabaseState(metadataState, runtime),
      ),
    };
  }
  return {
    create: () => new Database(options.databaseOptions),
    decode: (bytes) => decodeBufferedDatabase(bytes, options.databaseOptions),
    decodeJournal: (records) => recover(records, options.databaseOptions),
    encode: (db) => captureSnapshot(db.engineState, db.prng, db.now, db.seed, db.randomMode, db.systemClock).encode(),
    canCapture: (db) => !db.transactions.inTransaction,
    capture,
    baseline: (db) => capture(db, undefined, true, true).token,
    acknowledge(db, token) {
      for (const [name, table] of token.tables) {
        const live = db.engineState.tables.get(name)?.durableChanges;
        if (!live || !table.durableChanges) continue;
        for (const [key, value] of table.durableChanges) if (live.get(key) === value) live.delete(key);
      }
    },
    subscribe(db, observer) {
      const descriptor = Object.getOwnPropertyDescriptor(db, "state")!;
      db.durabilityObserver = observer;
      Object.defineProperty(db, "state", {
        enumerable: true,
        configurable: true,
        get() {
          exposed = true;
          observer.exposed();
          return db.engineState;
        },
      });
      return () => {
        db.durabilityObserver = undefined;
        Object.defineProperty(db, "state", descriptor);
      };
    },
    async close(db) {
      db.close();
      await closeBackend();
    },
  };
}

/** One-second write-behind; explicit write/flush/close still await the injected backend. */
export async function openBufferedDurableDatabase(
  options: BufferedDurableDatabaseOptions,
): Promise<BufferedDurable<Database>> {
  const backend = options.backend ?? new IndexedDBDurabilityBackend({ durability: "relaxed" });
  const closeBackend = async () => {
    if (!options.backend && backend instanceof IndexedDBDurabilityBackend) await backend.close();
  };
  try {
    return await openBufferedDurable({
      ...options,
      backend,
      lifecycle: options.lifecycle ?? browserDurabilityLifecycle,
      codec: codec(options, closeBackend),
    });
  } catch (error) {
    await closeBackend();
    throw error;
  }
}
