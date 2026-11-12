/**
 * A PostgreSQL wire-protocol (frontend/backend 3.0) TCP server in front of the in-memory
 * engine, so a separate process can use it through a normal `postgres://` connection string:
 * `pg`, `postgres.js`, a JDBC client, `psql`. It runs in Node and Bun (it needs `node:net`).
 * Where no listener can run (a browser, a worker, an edge runtime), `createWireServer()` from
 * `/transport` is the same server accepting connections as injected byte streams.
 *
 * One {@link Database} is shared by every connection through a {@link Cluster}: the engine
 * runs one statement at a time, so a connection inside an explicit `BEGIN` block holds the
 * engine until it commits or rolls back and the others queue, which keeps read-committed
 * visibility (uncommitted rows never reach another connection) at the cost of serializing
 * transaction blocks. Advisory locks, `LISTEN`/`NOTIFY`, `CancelRequest` and per-connection
 * aborted-transaction state (`25P02`) are coordinated across connections.
 *
 * State lives in memory. The opt-in `durable` option persists the cluster before each commit is
 * acknowledged (see ./durable.ts); without it the server touches no filesystem.
 *
 * @example
 * ```ts
 * import { serve } from "@crvouga/mockingbird-service-postgres/wire";
 *
 * const server = await serve({ port: 0 });
 * // new pg.Pool({ connectionString: `postgres://postgres@127.0.0.1:${server.port}/db` })
 * await server.close();
 * ```
 *
 * @module
 */
import { createServer, type Server, type Socket } from "node:net";
import type { Database } from "../api/database.ts";
import type { Snapshot } from "../api/snapshot.ts";
import type { ServerLog } from "./connection.ts";
import type { DurableOptions, DurableStorage } from "./durable.ts";
import { fileStorage } from "./file-storage.ts";
import { createWireServer, type WireServer, type WireServerOptions } from "./transport.ts";

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
  /**
   * Per-statement log sink, for tests and debugging. Every statement the client ran or failed is
   * reported once, including those rejected at Parse or Bind, with the error message it received.
   */
  onLog?: (entry: ServerLog) => void;
  /** Include extended-protocol parameter values in `onLog` entries (`params`). Off by default: they may be large. */
  logParams?: boolean;
  /**
   * `postgres://` or `postgresql://` URL. User, password, host, port, and database name
   * fill the fields above when those fields are omitted. An omitted port means `5432`;
   * pass port `0` in the URL (`postgres://postgres@127.0.0.1:0/app`) for an ephemeral port.
   */
  url?: string;
  /**
   * Database name clients must request in the startup packet. A different name is
   * SQLSTATE `3D000`. Set from `url` when the path is non-empty. Unset accepts any name.
   */
  databaseName?: string;
  /** Accept other databases in this listener's catalog while retaining its default URL. */
  allowDatabaseSelection?: boolean;
  /** Role shown in `connectionString`. A URI's username fills this. Default `postgres`. */
  user?: string;
  /**
   * Opt-in durable mode: a directory (the file-backed store), an injected {@link DurableStorage},
   * or {@link DurableOptions} with test controls. An autocommit write or `COMMIT` is then
   * persisted before it is acknowledged, and a server started on the same storage resumes from
   * the last acknowledged commit, even after a `SIGKILL`. Storage that already holds a cluster
   * wins over `database`, which then only supplies the clock, seed and entropy mode. Omitted
   * (the default), state lives in memory only and no filesystem is touched.
   */
  durable?: string | DurableStorage | DurableOptions;
};

/** A listening {@link WireServer}: the same controls, plus the TCP address. */
export type PostgresServer = WireServer & {
  /** The bound port. */
  readonly port: number;
  /** The bound host. */
  readonly host: string;
  /** `postgres://` URL for the bound address, including the database name. */
  readonly connectionString: string;
  /** The underlying `net.Server`. */
  readonly server: Server;
  /** Stop listening and close every connection. Durable mode also waits for a write in flight. */
  close(): Promise<void>;
};

export type ServeInput = ServeOptions | string;

const parseUri = (raw: string): ServeOptions => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid postgres URI: ${raw}`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`unsupported postgres URI protocol ${url.protocol}`);
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const password = url.password === "" ? undefined : decodeURIComponent(url.password);
  const user = decodeURIComponent(url.username || "postgres");
  const port = url.port === "" ? 5432 : Number(url.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid postgres URI port: ${url.port}`);
  return {
    host: url.hostname || "127.0.0.1",
    port,
    user,
    ...(password !== undefined ? { password } : {}),
    ...(databaseName !== "" ? { databaseName } : {}),
  };
};

const normalize = (input: ServeInput): ServeOptions => {
  if (typeof input === "string") return parseUri(input);
  if (input.url === undefined) return input;
  const parsed = parseUri(input.url);
  return {
    ...parsed,
    ...input,
    host: input.host ?? parsed.host,
    port: input.port ?? parsed.port,
    password: input.password ?? parsed.password,
    databaseName: input.databaseName ?? parsed.databaseName,
    user: input.user ?? parsed.user,
    parameters: input.parameters ?? parsed.parameters,
  };
};

/** A directory path becomes the file-backed store; the transport server takes only injected storage. */
const resolveDurable = (durable: ServeOptions["durable"]): WireServerOptions["durable"] => {
  if (durable === undefined) return undefined;
  if (typeof durable === "string") return fileStorage(durable);
  if ("write" in durable) return durable;
  return { ...durable, storage: typeof durable.storage === "string" ? fileStorage(durable.storage) : durable.storage };
};

/** Start a server and resolve once it is listening. A string argument is a `postgres://` URI. */
export const serve = (input: ServeInput = {}): Promise<PostgresServer> => start(normalize(input));

const start = async (options: ServeOptions): Promise<PostgresServer> => {
  const durable = resolveDurable(options.durable);
  const wire = await createWireServer({
    ...(options.database !== undefined ? { database: options.database } : {}),
    ...(options.password !== undefined ? { password: options.password } : {}),
    ...(options.serverVersion !== undefined ? { serverVersion: options.serverVersion } : {}),
    ...(options.parameters !== undefined ? { parameters: options.parameters } : {}),
    ...(options.onLog !== undefined ? { onLog: options.onLog } : {}),
    ...(options.logParams !== undefined ? { logParams: options.logParams } : {}),
    ...(options.databaseName !== undefined ? { databaseName: options.databaseName } : {}),
    ...(options.allowDatabaseSelection !== undefined ? { allowDatabaseSelection: options.allowDatabaseSelection } : {}),
    ...(durable !== undefined ? { durable } : {}),
  });
  const host = options.host ?? "127.0.0.1";
  const user = options.user || "postgres";

  const server = createServer((socket: Socket) => {
    socket.setNoDelay(true);
    void wire.accept(socket);
  });

  return new Promise<PostgresServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.removeListener("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const name = options.databaseName ?? "postgres";
      const auth = options.password
        ? `${encodeURIComponent(user)}:${encodeURIComponent(options.password)}@`
        : `${encodeURIComponent(user)}@`;
      resolve({
        port,
        host,
        connectionString: `postgres://${auth}${host}:${port}/${encodeURIComponent(name)}`,
        accept: (stream) => wire.accept(stream),
        get database() {
          return wire.database;
        },
        databaseNames: () => wire.databaseNames(),
        getDatabase: (databaseName) => wire.getDatabase(databaseName),
        server,
        get connections() {
          return wire.connections;
        },
        fault: (next) => wire.fault(next),
        clearFaults: () => wire.clearFaults(),
        faultState: () => wire.faultState(),
        snapshotAll: () => wire.snapshotAll(),
        restoreAll: (points) => wire.restoreAll(points),
        snapshot: (databaseName) => wire.snapshot(databaseName),
        persist: () => wire.persist(),
        async close() {
          const closing = wire.close();
          await new Promise<void>((done, fail) => {
            server.close((error?: Error | null) => (error ? fail(error) : done()));
          });
          await closing;
        },
      });
    });
  });
};

export { Cluster } from "./cluster.ts";
export type { ServerFaults, ServerLog, ServerLogPhase } from "./connection.ts";
export type { ClusterImage, DurableCommit, DurableOptions, DurableStorage } from "./durable.ts";
export { fileStorage } from "./file-storage.ts";
export type { ByteStreamPair, ClientStream, DuplexLike } from "./stream.ts";
export { createWireServer, type WireServer, type WireServerOptions } from "./transport.ts";
