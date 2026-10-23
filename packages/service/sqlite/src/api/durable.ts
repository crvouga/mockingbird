import {
  type DurabilityBackend,
  type Durable,
  IndexedDBDurabilityBackend,
  openDurable,
} from "@crvouga/mockingbird-core";
import { SqliteError } from "../errors/index.ts";
import { Database, type DatabaseOptions, Snapshot } from "./database.ts";
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
  return openDurable({
    key: options.key,
    backend,
    pageSize: options.pageSize,
    codec: {
      create: () => new Database(options.databaseOptions),
      decode: (bytes) => Snapshot.decode(bytes).open(options.databaseOptions),
      encode: (db) => {
        db.assertOpen();
        if (db.transactions.inTransaction) throw new SqliteError("cannot persist during a transaction", "transaction");
        // Persistence must not retain a new timeline checkpoint for every save.
        return captureSnapshot(db.state, db.prng, db.now, db.seed, db.randomMode, db.systemClock).encode();
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
