/**
 * A PostgreSQL wire-protocol (frontend/backend 3.0) TCP server in front of the in-memory
 * engine, so a separate process can use it through a normal `postgres://` connection string:
 * `pg`, `postgres.js`, a JDBC client, `psql`. It runs in Node and Bun (it needs `node:net`),
 * not the browser.
 *
 * One {@link Database} is shared by every connection through a {@link Cluster}: the engine
 * runs one statement at a time, so a connection inside an explicit `BEGIN` block holds the
 * engine until it commits or rolls back and the others queue, which keeps read-committed
 * visibility (uncommitted rows never reach another connection) at the cost of serializing
 * transaction blocks. Advisory locks, `LISTEN`/`NOTIFY`, `CancelRequest` and per-connection
 * aborted-transaction state (`25P02`) are coordinated across connections.
 *
 * @example
 * ```ts
 * import { serve } from "@crvouga/mockingbird-service-postgres/server";
 *
 * const server = await serve({ port: 0 });
 * // new pg.Pool({ connectionString: `postgres://postgres@127.0.0.1:${server.port}/db` })
 * await server.close();
 * ```
 *
 * @module
 */
import { createServer, type Server, type Socket } from "node:net";
import { Database } from "../api/database.ts";
import type { Snapshot } from "../api/snapshot.ts";
import { Cluster } from "./cluster.ts";
import { Connection, type ServerFaults, type ServerLog } from "./connection.ts";

export type ServeOptions = {
  /** TCP port; `0` (the default) picks a free one, reported as `server.port`. */
  port?: number;
  /** Interface to bind; default `127.0.0.1`. */
  host?: string;
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
};

export type PostgresServer = {
  /** The bound port. */
  readonly port: number;
  /** The bound host. */
  readonly host: string;
  /** The shared engine, for seeding, snapshotting or asserting from the test process. */
  readonly database: Database;
  /** The underlying `net.Server`. */
  readonly server: Server;
  /** Open connections right now. */
  readonly connections: number;
  /** Arm a fault preset for the next statement / connection (see {@link ServerFaults}). */
  fault(fault: ServerFaults): void;
  /** Freeze the live state (the admin `snapshot()` control). */
  snapshot(): Snapshot;
  /** Stop listening and close every connection. */
  close(): Promise<void>;
};

const isSnapshot = (value: unknown): value is Snapshot =>
  typeof value === "object" && value !== null && "open" in value && typeof (value as Snapshot).open === "function";

/** Start a server and resolve once it is listening. */
export const serve = (options: ServeOptions = {}): Promise<PostgresServer> => {
  const database = isSnapshot(options.database) ? options.database.open() : (options.database ?? new Database());
  const cluster = new Cluster(database);
  const faults: ServerFaults = {};
  const connections = new Set<Connection>();
  const host = options.host ?? "127.0.0.1";

  const server = createServer((socket: Socket) => {
    socket.setNoDelay(true);
    const connection = new Connection(socket, cluster, {
      ...(options.password !== undefined ? { password: options.password } : {}),
      serverVersion: options.serverVersion ?? "18.3",
      parameters: options.parameters ?? {},
      faults,
      ...(options.onLog ? { onLog: options.onLog } : {}),
    });
    connections.add(connection);
    socket.on("close", () => connections.delete(connection));
  });

  return new Promise<PostgresServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.removeListener("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        port,
        host,
        database,
        server,
        get connections() {
          return connections.size;
        },
        fault(next) {
          Object.assign(faults, next);
        },
        snapshot() {
          return database.snapshot();
        },
        close() {
          for (const connection of connections) connection.destroy();
          connections.clear();
          return new Promise<void>((done, fail) => {
            server.close((error?: Error | null) => (error ? fail(error) : done()));
          });
        },
      });
    });
  });
};

export { Cluster } from "./cluster.ts";
export type { ServerFaults, ServerLog } from "./connection.ts";
