import {
  type DurabilityBackend,
  type Durable,
  IndexedDBDurabilityBackend,
  isDurableJournal,
  openDurable,
} from "@crvouga/mockingbird-core";
import { pgError } from "../errors/error.ts";
import { decodeBufferedDatabase, encodeBufferedCheckpoint } from "./buffered.ts";
import { Database, type DatabaseOptions } from "./database.ts";
import { captureSnapshot } from "./snapshot.ts";

export interface DurableDatabaseOptions {
  /** Independent saved image within the backend. */
  key: string;
  /** Defaults to IndexedDB. Inject any implementation of the shared binary image port. */
  backend?: DurabilityBackend;
  databaseOptions?: DatabaseOptions;
  pageSize?: number;
}

/** Open a browser-persisted database without changing the synchronous Database API. */
export function openDurableDatabase(options: DurableDatabaseOptions): Promise<Durable<Database>> {
  const backend = options.backend ?? new IndexedDBDurabilityBackend();
  let journal = false;
  return openDurable({
    key: options.key,
    backend,
    pageSize: options.pageSize,
    codec: {
      create: () => new Database(options.databaseOptions),
      decode: (bytes) => {
        journal = isDurableJournal(bytes);
        return decodeBufferedDatabase(bytes, options.databaseOptions);
      },
      encode: (db) => {
        db.assertOpen();
        if (db.transactions.inTransaction)
          throw pgError("transaction_state", "cannot persist during a transaction", "25P01");
        if (journal) return encodeBufferedCheckpoint(db);
        // Persistence must not retain a new timeline checkpoint for every save.
        return captureSnapshot(
          db.engineState,
          db.prng,
          db.now,
          db.seed,
          db.randomMode,
          db.systemClock,
          db.int8Mode,
        ).encode();
      },
      close: async (db) => {
        db.close();
        if (!options.backend && backend instanceof IndexedDBDurabilityBackend) await backend.close();
      },
    },
  }).catch(async (error: unknown) => {
    if (!options.backend && backend instanceof IndexedDBDurabilityBackend) await backend.close();
    throw error;
  });
}
