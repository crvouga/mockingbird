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
import { pgError } from "../errors/error.ts";
import { encodeDatabaseState } from "../serialization/codec.ts";
import type { DatabaseState, PreparedStatement, TableData } from "../storage/database-state.ts";
import type { Datum } from "../types/value.ts";
import { Database, type DatabaseOptions, Snapshot } from "./database.ts";
import type { DurableDatabaseOptions } from "./durable.ts";
import { captureSnapshot } from "./snapshot.ts";

export interface BufferedDurableDatabaseOptions extends DurableDatabaseOptions, BufferedDurabilityOptions {}

type Extra = { xidCounter: number; sequenceCurrval: [string, bigint][]; prepared: [string, PreparedStatement][] };
type TableRecord = { schema: string; name: string; ids: number[]; deleted: number[]; nextId: number };
type RecordMeta = Extra & { checkpoint: boolean; tables: TableRecord[] };
interface Token {
  metadata: Uint8Array;
  shape: Uint8Array;
  tables: Map<string, Pick<TableData, "durableChanges" | "durableEpoch">>;
}
const key = (schema: string, name: string) => JSON.stringify([schema, name]);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, index) => byte === b[index]);
function tables(state: DatabaseState): Map<string, TableData> {
  return new Map(
    [...state.schemas.values()].flatMap((schema) =>
      [...schema.tables.values()].map((table) => [key(schema.name, table.name), table] as const),
    ),
  );
}
function extra(state: DatabaseState): Extra {
  return { xidCounter: state.xidCounter, sequenceCurrval: [...state.sequenceCurrval], prepared: [...state.prepared] };
}

/** @internal Immediate writers preserve metadata when opening the opt-in envelope. */
export function encodeBufferedCheckpoint(db: Database): Uint8Array {
  const snap = captureSnapshot(db.engineState, db.prng, db.now, db.seed, db.randomMode, db.systemClock, db.int8Mode);
  const info = [...tables(snap.state).values()].map((table) => ({
    schema: table.schema,
    name: table.name,
    ids: Array.from({ length: table.rowCount() }, (_, id) => id),
    deleted: [],
    nextId: table.rowCount(),
  }));
  return encodeDurableCheckpoint(
    packDurableRecord({ ...extra(snap.state), checkpoint: true, tables: info } satisfies RecordMeta, snap.encode()),
  );
}

export function decodeBufferedDatabase(bytes: Uint8Array, options?: DatabaseOptions): Database {
  const records = readDurableJournal(bytes);
  const db = records ? recover(records, options) : Snapshot.decode(bytes).open(options);
  for (const table of tables(db.engineState).values()) table.disableDurabilityTracking();
  return db;
}

function recover(records: readonly Uint8Array[], options?: DatabaseOptions): Database {
  let db: Database | undefined;
  const rows = new Map<string, { rows: Map<number, { row: Datum[]; xmin: number }>; nextId: number }>();
  try {
    for (const bytes of records) {
      const { metadata, snapshot } = unpackDurableRecord<RecordMeta>(bytes);
      const next = Snapshot.decode(snapshot).open(options);
      next.engineState.xidCounter = metadata.xidCounter;
      next.engineState.sequenceCurrval = new Map(metadata.sequenceCurrval);
      next.engineState.prepared = new Map(metadata.prepared);
      if (metadata.checkpoint) rows.clear();
      else if (!db) throw new Error("Missing buffered checkpoint");
      const changes = tables(next.engineState);
      for (const info of metadata.tables) {
        const name = key(info.schema, info.name);
        const table = changes.get(name);
        if (!table || table.rowCount() !== info.ids.length) throw new Error("Invalid incremental row IDs");
        let target = rows.get(name);
        if (!target) {
          target = { rows: new Map(), nextId: 0 };
          rows.set(name, target);
        }
        target.nextId = info.nextId;
        for (const id of info.deleted) target.rows.delete(id);
        table.materializeSlab();
        for (let i = 0; i < info.ids.length; i++) {
          const row = table.rowAt(i);
          target.rows.set(info.ids[i]!, { row, xmin: table.rowXmins.get(row) ?? 2 });
        }
      }
      db?.close();
      db = next;
    }
    if (!db) throw new Error("Missing buffered checkpoint");
    for (const [name, table] of tables(db.engineState)) {
      const stored = rows.get(name);
      if (!stored) throw new Error("Missing buffered table");
      const ordered = [...stored.rows].sort((a, b) => a[0] - b[0]);
      table.rows = ordered.map(([, value]) => value.row);
      table.rowXmins = new WeakMap(ordered.map(([, value]) => [value.row, value.xmin]));
      table.indexStores = null;
      table.enableDurabilityTracking(
        ordered.map(([id]) => id),
        stored.nextId,
      );
    }
    const snap = captureSnapshot(db.engineState, db.prng, db.now, db.seed, db.randomMode, db.systemClock, db.int8Mode);
    const result = snap.open(options);
    for (const [name, table] of tables(result.engineState)) {
      const stored = rows.get(name)!;
      const ids = [...stored.rows.keys()].sort((a, b) => a - b);
      table.enableDurabilityTracking(ids, stored.nextId);
    }
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
    if (db.transactions.inTransaction)
      throw pgError("transaction_state", "cannot persist during a transaction", "25P01");
    const currentTables = tables(db.engineState);
    const shape = packDurableRecord(
      [...currentTables].map(([name, table]) => [name, table.oid, table.columns, table.constraints, table.triggers]),
      new Uint8Array(),
    );
    checkpoint ||=
      exposed ||
      !previous ||
      !same(shape, previous.shape) ||
      [...currentTables].some(
        ([name, table]) =>
          table.durableUnsafe ||
          !table.durableChanges ||
          table.durableEpoch !== previous?.tables.get(name)?.durableEpoch,
      );
    for (const table of currentTables.values()) table.enableDurabilityTracking();
    const snap = captureSnapshot(db.engineState, db.prng, db.now, db.seed, db.randomMode, db.systemClock, db.int8Mode);
    const capturedTables = tables(snap.state);
    const metadataState = snap.state.cloneShallow();
    for (const schema of metadataState.schemas.values())
      schema.tables = new Map([...schema.tables].map(([name, table]) => [name, table.emptyForDurability()]));
    const runtime = { prngState: snap.prngState, nowMs: snap.nowMs };
    const extras = extra(snap.state);
    const metadata = packDurableRecord(extras, encodeDatabaseState(metadataState, runtime));
    const token: Token = {
      metadata,
      shape,
      tables: new Map(
        [...capturedTables].map(([name, table]) => [
          name,
          {
            durableChanges: table.durableChanges!.fork(),
            durableEpoch: table.durableEpoch,
          },
        ]),
      ),
    };
    if (baselineOnly) return { token, checkpoint: true };
    const info: TableRecord[] = [];
    let changed = false;
    for (const [name, table] of capturedTables) {
      const ids: number[] = [];
      const deleted: number[] = [];
      if (checkpoint) {
        for (let i = 0; i < table.rowCount(); i++) ids.push(table.durableRowId(table.rowAt(i)));
      } else {
        const destination = metadataState.schemas.get(table.schema)!.tables.get(table.name)!;
        const destinationRows = destination.writeRows();
        for (const change of table.durableChanges!.changes(previous?.tables.get(name)?.durableChanges ?? undefined)) {
          if (change.deleted) continue;
          changed = true;
          if (change.value.row) {
            ids.push(change.key);
            destinationRows.push(change.value.row);
            destination.rowXmins.set(change.value.row, change.value.xmin);
          } else deleted.push(change.key);
        }
      }
      info.push({ schema: table.schema, name: table.name, ids, deleted, nextId: table.durableNextId });
    }
    if (!checkpoint && !changed && previous && same(metadata, previous.metadata)) return { token, checkpoint: false };
    return {
      token,
      checkpoint,
      bytes: packDurableRecord(
        { ...extras, checkpoint, tables: info } satisfies RecordMeta,
        checkpoint ? snap.encode() : encodeDatabaseState(metadataState, runtime),
      ),
    };
  }
  return {
    create: () => new Database(options.databaseOptions),
    decode: (bytes) => decodeBufferedDatabase(bytes, options.databaseOptions),
    decodeJournal: (records) => recover(records, options.databaseOptions),
    encode: (db) =>
      captureSnapshot(db.engineState, db.prng, db.now, db.seed, db.randomMode, db.systemClock, db.int8Mode).encode(),
    canCapture: (db) => !db.transactions.inTransaction,
    capture,
    baseline: (db) => capture(db, undefined, true, true).token,
    acknowledge(db, token) {
      const liveTables = tables(db.engineState);
      for (const [name, table] of token.tables) {
        const live = liveTables.get(name);
        if (!live?.durableChanges || !table.durableChanges || live.durableEpoch !== table.durableEpoch) continue;
        for (const [id, row] of table.durableChanges)
          if (live.durableChanges.get(id) === row) live.durableChanges.delete(id);
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
