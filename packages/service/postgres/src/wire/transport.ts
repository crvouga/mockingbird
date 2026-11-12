/**
 * The PostgreSQL wire-protocol server without a listener: it accepts client connections handed to
 * it as byte streams, so it runs in a browser, a (Shared)Worker, an edge runtime or a unit test
 * with no port. `serve()` from `/wire` is this server behind `net.createServer`.
 *
 * Nothing here imports a `node:` built-in: SCRAM-SHA-256 is pure TypeScript, and the file-backed
 * durable store (a directory path) stays in `/wire`; pass a {@link DurableStorage} instead.
 *
 * @example
 * ```ts
 * import { createWireServer } from "@crvouga/mockingbird-service-postgres/transport";
 *
 * const server = await createWireServer({ password: "secret" });
 * const toServer = new TransformStream<Uint8Array, Uint8Array>();
 * const toClient = new TransformStream<Uint8Array, Uint8Array>();
 * void server.accept({ readable: toServer.readable, writable: toClient.writable });
 * // The client writes to toServer.writable and reads toClient.readable.
 * ```
 *
 * @module
 */
import { Database } from "../api/database.ts";
import type { Snapshot } from "../api/snapshot.ts";
import { Cluster, type Session } from "./cluster.ts";
import { Connection, type ServerFaults, type ServerLog } from "./connection.ts";
import { Durability, type DurableOptions, type DurableStorage, openImage } from "./durable.ts";
import { type ClientStream, toSocket } from "./stream.ts";

export type WireServerOptions = {
  /**
   * The database to serve. Pass a {@link Database} to share an existing one, a {@link Snapshot}
   * to boot every server from one frozen template, or omit it for a fresh deterministic engine.
   */
  database?: Database | Snapshot;
  /** Require SCRAM-SHA-256 with this password; omitted means trust (AuthenticationOk). */
  password?: string;
  /** `server_version` reported at startup and by `SHOW server_version`. Default `18.3`. */
  serverVersion?: string;
  /** Extra `ParameterStatus` values sent at startup (override the defaults). */
  parameters?: Record<string, string>;
  /** Per-statement log sink, for tests and debugging. */
  onLog?: (entry: ServerLog) => void;
  /** Include extended-protocol parameter values in `onLog` entries. */
  logParams?: boolean;
  /**
   * Database name clients must request in the startup packet. A different name is
   * SQLSTATE `3D000`. Unset accepts any name.
   */
  databaseName?: string;
  /** Accept other databases in this server's catalog while retaining `databaseName` as the default. */
  allowDatabaseSelection?: boolean;
  /**
   * Opt-in durable mode over an injected {@link DurableStorage} (or {@link DurableOptions} whose
   * `storage` is one). A directory path needs the file-backed store, which only `serve()` from
   * `/wire` (Node, Bun) provides.
   */
  durable?: DurableStorage | DurableOptions;
};

export type WireServer = {
  /**
   * Serve one client connection: web streams (`{ readable, writable }`) or a Node `Duplex`.
   * Resolves when the connection closes, from either side; the session is then disposed as on
   * a socket close (its transaction rolled back, its locks and listeners released).
   */
  accept(stream: ClientStream): Promise<void>;
  /** The shared engine, for seeding, snapshotting or asserting from the host. */
  readonly database: Database;
  /** Names in the cluster catalog, in deterministic order. */
  databaseNames(): readonly string[];
  /** Resolve a named database, or throw SQLSTATE `3D000`. */
  getDatabase(name: string): Database;
  /** Open connections right now. */
  readonly connections: number;
  /** Arm a fault preset for the next statement / connection (see {@link ServerFaults}). */
  fault(fault: ServerFaults): void;
  clearFaults(): void;
  faultState(): ServerFaults;
  /** Freeze the live state (the admin `snapshot()` control). */
  snapshot(name?: string): Snapshot;
  snapshotAll(): Map<string, Snapshot>;
  restoreAll(points: ReadonlyMap<string, Snapshot>): void;
  /**
   * Durable mode: persist every database now, for changes made through `database` /
   * `getDatabase()` / `restoreAll()` rather than a connection. Resolves at once without `durable`.
   */
  persist(): Promise<void>;
  /** Close every connection. Durable mode also waits for a write in flight. */
  close(): Promise<void>;
};

const isSnapshot = (value: unknown): value is Snapshot =>
  typeof value === "object" && value !== null && "open" in value && typeof (value as Snapshot).open === "function";

const durableOptions = (
  durable: WireServerOptions["durable"],
): (DurableOptions & { storage: DurableStorage }) | null => {
  if (durable === undefined) return null;
  const options: DurableOptions = "write" in durable ? { storage: durable } : durable;
  if (typeof options.storage === "string") {
    throw new Error(
      "createWireServer: durable storage must be a DurableStorage; a directory path needs serve() or fileStorage() from @crvouga/mockingbird-service-postgres/wire",
    );
  }
  return { ...options, storage: options.storage };
};

/** The statement turn for work that is not a connection's: {@link WireServer.persist}. */
const hostSession = (cluster: Cluster): Session => ({
  pid: cluster.newPid(),
  database: cluster.db,
  databaseName: cluster.defaultDatabaseName,
  waitingForTurn: null,
  waitingForLock: null,
  pendingNotifies: [],
  queueNotification: () => undefined,
});

/** Create a wire-protocol server that accepts connections from {@link WireServer.accept}. */
export const createWireServer = async (options: WireServerOptions = {}): Promise<WireServer> => {
  const seed = isSnapshot(options.database) ? options.database.open() : (options.database ?? new Database());
  const initialName = options.databaseName ?? "postgres";
  const durable = durableOptions(options.durable);
  const image = durable ? await durable.storage.read() : null;
  const restored = image ? openImage(image, seed) : null;
  if (restored && !restored.has(initialName)) {
    throw new Error(
      `durable storage holds no database "${initialName}" (it has ${[...restored.keys()].sort().join(", ")}); start with that databaseName or an empty storage`,
    );
  }
  const cluster = new Cluster(restored?.get(initialName) ?? seed, initialName);
  for (const [name, database] of restored ?? []) if (name !== initialName) cluster.attach(name, database);
  let durability: Durability | null = null;
  if (durable) {
    durability = new Durability(cluster, durable.storage, durable);
    cluster.durability = durability;
    // An empty storage is initialised with the starting state, so the first restart finds a cluster.
    if (image) durability.adopt(image);
    else await durability.persist("all");
  }
  const faults: ServerFaults = {};
  const connections = new Set<Connection>();
  let closed = false;

  return {
    accept(stream) {
      const socket = toSocket(stream);
      if (closed) {
        socket.destroy();
        return socket.closed;
      }
      const connection = new Connection(socket, cluster, {
        ...(options.password !== undefined ? { password: options.password } : {}),
        serverVersion: options.serverVersion ?? "18.3",
        parameters: options.parameters ?? {},
        faults,
        ...(options.databaseName !== undefined && !options.allowDatabaseSelection
          ? { database: options.databaseName }
          : {}),
        ...(options.onLog ? { onLog: options.onLog } : {}),
        ...(options.logParams ? { logParams: true } : {}),
      });
      connections.add(connection);
      return socket.closed.then(() => {
        connections.delete(connection);
      });
    },
    get database() {
      return cluster.db;
    },
    databaseNames() {
      return cluster.databaseNames();
    },
    getDatabase(databaseName) {
      return cluster.requireDatabase(databaseName);
    },
    get connections() {
      return connections.size;
    },
    fault(next) {
      Object.assign(faults, next);
    },
    clearFaults() {
      for (const key of Object.keys(faults)) delete faults[key as keyof ServerFaults];
    },
    faultState() {
      return structuredClone(faults);
    },
    snapshotAll: () => cluster.snapshotAll(),
    restoreAll: (points) => cluster.restoreAll(points),
    snapshot(databaseName = initialName) {
      return cluster.requireDatabase(databaseName).snapshot();
    },
    async persist() {
      if (!durability) return;
      const session = hostSession(cluster);
      await cluster.acquireTurn(session);
      try {
        await durability.persist("all");
      } finally {
        cluster.releaseTurn(session);
      }
    },
    async close() {
      closed = true;
      for (const connection of connections) connection.destroy();
      connections.clear();
      await durability?.idle();
    },
  };
};

export type { ServerFaults, ServerLog, ServerLogPhase } from "./connection.ts";
export type { ClusterImage, DurableCommit, DurableOptions, DurableStorage } from "./durable.ts";
export type { ByteStreamPair, ClientStream, DuplexLike } from "./stream.ts";
