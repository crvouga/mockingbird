import { createHash } from "node:crypto";
import type { ConfigService, FleetChild } from "@crvouga/mockingbird-adapter-node";
import { type Clock, createClock, normalizeBootControls } from "@crvouga/mockingbird-service";
import { Database } from "../api/database.ts";
import { Snapshot } from "../api/snapshot.ts";
import type { ServerFaults } from "./connection.ts";
import { type PostgresServer, serve } from "./index.ts";
import { probe } from "./probe.ts";

/** Separate database listeners make the protocol namespace explicit in discovery. */
export async function startProtocol(entry: ConfigService): Promise<FleetChild> {
  const namespaces = new Map<string, { server: PostgresServer; clock: Clock }>();
  const selectors = { default: entry.database ?? "postgres", ...entry.namespaces };
  if (entry.seed !== undefined && (!String(entry.seed).trim() || !Number.isFinite(Number(entry.seed))))
    throw new Error("Postgres seed must be a finite number");
  let admission: ((namespace: string) => boolean) | undefined;
  const boot = normalizeBootControls(entry.adminControls);
  const create = async (name: string, databaseName: string, port = 0) => {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name) || typeof databaseName !== "string" || !databaseName.length)
      throw new Error("invalid Postgres namespace/database name");
    const clock = createClock();
    const control = { ...boot.shared.clock, ...boot.namespaces[name]?.clock };
    if (control.frozen) clock.freeze();
    if (control.now !== undefined) clock.set(control.now);
    const database = new Database({
      now: () => new Date(clock.now()),
      ...(entry.seed !== undefined ? { seed: Number(entry.seed) } : {}),
    });
    const server = await serve({
      database,
      databaseName,
      allowDatabaseSelection: true,
      host: entry.host ?? "127.0.0.1",
      port,
      ...(entry.password !== undefined ? { password: entry.password } : {}),
      ...(entry.user !== undefined ? { user: entry.user } : {}),
    });
    server.server.prependListener("connection", (socket: import("node:net").Socket) => {
      if (admission?.(name) === false) socket.destroy();
    });
    namespaces.set(name, { server, clock });
  };
  try {
    for (const [name, databaseName] of Object.entries(selectors))
      await create(name, databaseName as string, name === "default" ? (entry.port ?? 0) : 0);
  } catch (error) {
    await Promise.allSettled([...namespaces.values()].map(({ server }) => server.close()));
    throw error;
  }
  const get = (name: string) => {
    const found = namespaces.get(name);
    if (!found) throw new Error(`Postgres namespace ${name} is not configured`);
    return found;
  };
  const publicUrl = (name: string) => {
    const url = new URL(get(name).server.connectionString);
    url.password = "";
    return url.href;
  };
  const locked = new Set<string>();
  const snapshots = new WeakMap<
    object,
    { namespace: string; databases: Map<string, Snapshot>; clock: ReturnType<Clock["state"]>; faults: ServerFaults }
  >();
  const origins = new Map([...namespaces].map(([name, { server }]) => [name, server.snapshotAll()]));
  return {
    protocol: "postgres",
    url: publicUrl("default"),
    connection: get("default").server.connectionString,
    get connections() {
      return Object.fromEntries([...namespaces].map(([name, { server }]) => [name, server.connectionString]));
    },
    get namespaces() {
      return {
        mechanism: "endpoint",
        endpoints: Object.fromEntries([...namespaces.keys()].map((name) => [name, publicUrl(name)])),
      };
    },
    async createNamespace(name) {
      if (namespaces.has(name)) throw new Error("namespace already exists");
      await create(name, entry.database ?? "postgres");
      origins.set(name, get(name).server.snapshotAll());
    },
    async deleteNamespace(name) {
      const { server } = get(name);
      if (server.connections) throw new Error("Postgres namespace has open sessions");
      await server.close();
      for (const database of server.databaseNames()) server.getDatabase(database).close();
      namespaces.delete(name);
      origins.delete(name);
    },
    async exportCheckpoint(namespace, handle) {
      const point = typeof handle === "object" && handle !== null ? snapshots.get(handle) : undefined;
      if (!point || point.namespace !== namespace) throw new Error("invalid Postgres checkpoint");
      return {
        format: "mockingbird.postgres/v1",
        inventory: Object.fromEntries(
          [...point.databases].map(([name, snapshot]) => {
            const database = snapshot.open();
            try {
              const tables = database
                .prepare("SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = 'public'")
                .all() as { table_schema: string; table_name: string }[];
              return [
                name,
                Object.fromEntries(
                  tables.map((table) => {
                    const identifier = table.table_name.replaceAll('"', '""');
                    const rows = database.prepare(`SELECT * FROM public."${identifier}"`).all() as Record<
                      string,
                      unknown
                    >[];
                    return [
                      table.table_name,
                      {
                        count: rows.length,
                        records: Object.fromEntries(
                          rows.map((row, index) => [
                            String(row.id ?? index),
                            createHash("sha256")
                              .update(
                                JSON.stringify(row, (_key, value: unknown) =>
                                  typeof value === "bigint" ? String(value) : value,
                                ),
                              )
                              .digest("hex"),
                          ]),
                        ),
                      },
                    ];
                  }),
                ),
              ];
            } finally {
              database.close();
            }
          }),
        ),
        databases: [...point.databases].map(([name, snapshot]) => ({
          name,
          bytes: Buffer.from(snapshot.encode()).toString("base64"),
        })),
        clock: point.clock,
        faults: point.faults,
      };
    },
    async importCheckpoint(namespace, document) {
      const doc = document as {
        format?: unknown;
        databases?: { name: string; bytes: string }[];
        clock: ReturnType<Clock["state"]>;
        faults: ServerFaults;
      };
      if (
        doc?.format !== "mockingbird.postgres/v1" ||
        !Array.isArray(doc.databases) ||
        !doc.databases.length ||
        !Number.isFinite(doc.clock?.now) ||
        typeof doc.clock?.frozen !== "boolean"
      )
        throw new Error("invalid Postgres archive");
      const databases = new Map<string, Snapshot>();
      for (const row of doc.databases) {
        if (
          typeof row.name !== "string" ||
          databases.has(row.name) ||
          typeof row.bytes !== "string" ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(row.bytes)
        )
          throw new Error("invalid Postgres archive database");
        databases.set(row.name, Snapshot.decode(Buffer.from(row.bytes, "base64")));
      }
      const handle = {};
      snapshots.set(handle, { namespace, databases, clock: doc.clock, faults: doc.faults ?? {} });
      return handle;
    },
    async inspect(namespace, { offset, limit, collection }) {
      const { server } = get(namespace);
      const database = server.getDatabase(server.databaseNames()[0] as string);
      const tables = database
        .prepare("SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = 'public'")
        .all();
      if (!collection) return { tables };
      const table = collection.replaceAll('"', '""');
      return {
        records: database.prepare(`SELECT * FROM public."${table}" LIMIT ${limit} OFFSET ${offset}`).all(),
        offset,
      };
    },
    async initializationAccess() {
      const privateServers: PostgresServer[] = [];
      const connections: Record<string, string> = {};
      try {
        for (const [name, { server }] of namespaces) {
          const databaseName = server.databaseNames()[0] as string;
          const seedServer = await serve({
            database: server.getDatabase(databaseName),
            databaseName,
            port: 0,
            host: "127.0.0.1",
            ...(entry.user ? { user: entry.user } : {}),
            ...(entry.password ? { password: entry.password } : {}),
          });
          privateServers.push(seedServer);
          connections[name] = seedServer.connectionString;
        }
      } catch (error) {
        await Promise.allSettled(privateServers.map((s) => s.close()));
        throw error;
      }
      return {
        connections,
        close: async () => {
          await Promise.all(privateServers.map((s) => s.close()));
        },
      };
    },
    setAdmission(allow) {
      admission = allow;
    },
    async ready() {
      if (admission) return [...namespaces.values()].every(({ server }) => server.server.listening);
      const results = await Promise.all(
        [...namespaces.values()].map(({ server }) =>
          server.server.listening ? probe(server.connectionString) : false,
        ),
      );
      const deadline = Date.now() + 2000;
      while ([...namespaces.values()].some(({ server }) => server.connections > 0) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 1));
      return results.every(Boolean);
    },
    async close() {
      await Promise.all(
        [...namespaces.values()].map(async ({ server }) => {
          await server.close();
          for (const name of server.databaseNames()) server.getDatabase(name).close();
        }),
      );
    },
    lock(namespace) {
      const { server } = get(namespace);
      if (locked.has(namespace)) throw new Error("Postgres namespace already locked");
      locked.add(namespace);
      const reject = (socket: import("node:net").Socket) => socket.destroy();
      // Prepend the fence, so the protocol handler never receives a live new socket.
      server.server.prependListener("connection", reject);
      return () => {
        locked.delete(namespace);
        server.server.off("connection", reject);
      };
    },
    diagnostics(namespace) {
      const { server } = get(namespace);
      // Even an idle client may retain prepared statements or a transaction workspace.
      return {
        activeRequests: server.connections,
        activeConnections: server.connections,
        blockedCommands: 0,
        pendingJobs: 0,
        pendingWebhooks: 0,
        unmatchedRequests: 0,
      };
    },
    async checkpoint(namespace) {
      const { server, clock } = get(namespace);
      const handle = {};
      snapshots.set(handle, {
        namespace,
        databases: server.snapshotAll(),
        clock: clock.state(),
        faults: server.faultState(),
      });
      return handle;
    },
    async restore(namespace, handle) {
      const point = typeof handle === "object" && handle !== null ? snapshots.get(handle) : undefined;
      if (!point || point.namespace !== namespace) throw new Error("invalid Postgres checkpoint");
      const { server, clock } = get(namespace);
      server.restoreAll(point.databases);
      for (const name of server.databaseNames()) server.getDatabase(name).now = () => new Date(clock.now());
      server.clearFaults();
      server.fault(point.faults);
      clock.freeze();
      clock.set(point.clock.now);
      if (!point.clock.frozen) clock.unfreeze();
    },
    async reset(namespace) {
      const { server, clock } = get(namespace);
      server.restoreAll(origins.get(namespace) as Map<string, Snapshot>);
      for (const name of server.databaseNames()) server.getDatabase(name).now = () => new Date(clock.now());
      server.clearFaults();
      clock.reset();
      const control = { ...boot.shared.clock, ...boot.namespaces[namespace]?.clock };
      if (control.frozen) clock.freeze();
      if (control.now !== undefined) clock.set(control.now);
    },
    nextEvent: () => undefined,
    clock: (namespace) => get(namespace).clock,
  };
}
