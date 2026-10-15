import { afterEach, describe, expect, test } from "bun:test";
import pg from "pg";
import { Database } from "../../src/index.ts";
import {
  type ClusterImage,
  type DurableCommit,
  type DurableOptions,
  type DurableStorage,
  type PostgresServer,
  serve,
} from "../../src/wire/index.ts";

// Durable mode against an injected storage: no filesystem, so failure and pauses are modelled here.
// A "crash" is a server that is simply abandoned; a "restart" is a new server on the same storage.

/** What a real storage keeps across a process: the last image whose write completed. */
class MemoryStorage implements DurableStorage {
  image: ClusterImage | null = null;
  writes = 0;
  /** Reject the next write, leaving the previous image in place. */
  failNext: Error | null = null;
  /** Hold every write here before it takes effect. */
  gate: Promise<void> | null = null;

  async read(): Promise<ClusterImage | null> {
    return this.image;
  }

  async write(image: ClusterImage): Promise<void> {
    if (this.gate) await this.gate;
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    this.image = new Map(image);
    this.writes++;
  }
}

const servers: PostgresServer[] = [];
const clients: pg.Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.end().catch(() => undefined);
  for (const server of servers.splice(0)) await server.close().catch(() => undefined);
});

const start = async (durable: DurableStorage | DurableOptions, database?: Database): Promise<PostgresServer> => {
  const server = await serve({ port: 0, durable, ...(database ? { database } : {}) });
  servers.push(server);
  return server;
};

const connect = async (server: PostgresServer, database = "postgres"): Promise<pg.Client> => {
  const url = new URL(server.connectionString);
  url.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: url.toString() });
  client.on("error", () => undefined);
  await client.connect();
  clients.push(client);
  return client;
};

/** Rows a fresh server restored from `storage` answers with. */
const afterRestart = async (storage: DurableStorage, sql: string, database = "postgres"): Promise<unknown[]> => {
  const server = await start(storage);
  const client = await connect(server, database);
  return (await client.query(sql)).rows;
};

const gate = (): { promise: Promise<void>; open: () => void } => {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const pending = async (work: Promise<unknown>): Promise<"settled" | "pending"> =>
  Promise.race([work.then(() => "settled" as const), settle().then(() => "pending" as const)]);

describe("behavior 1: an acknowledged commit is durable", () => {
  test("autocommit writes, COMMIT, bound parameters, scripts and COPY survive a crash", async () => {
    const storage = new MemoryStorage();
    const server = await start(storage);
    const client = await connect(server);
    await client.query("CREATE TABLE ledger (id serial PRIMARY KEY, note text)");
    await client.query("INSERT INTO ledger (note) VALUES ('autocommit')");
    await client.query("BEGIN");
    await client.query("INSERT INTO ledger (note) VALUES ('in a block')");
    await client.query("COMMIT");
    await client.query("INSERT INTO ledger (note) VALUES ($1)", ["bound"]);
    await client.query("INSERT INTO ledger (note) VALUES ('script 1'); INSERT INTO ledger (note) VALUES ('script 2')");

    // No shutdown: the first server is still running when the second one reads the storage.
    expect(await afterRestart(storage, "SELECT note FROM ledger ORDER BY id")).toEqual([
      { note: "autocommit" },
      { note: "in a block" },
      { note: "bound" },
      { note: "script 1" },
      { note: "script 2" },
    ]);
  });

  test("bigint increments survive reopening retained snapshots (#352)", async () => {
    const storage = new MemoryStorage();
    const server = await start(storage);
    const client = await connect(server);
    await client.query("CREATE TABLE counter (id text PRIMARY KEY, revision bigint NOT NULL)");
    await client.query("INSERT INTO counter VALUES ('default', 1)");
    expect((await client.query("UPDATE counter SET revision = revision + 1 RETURNING revision")).rows).toEqual([
      { revision: "2" },
    ]);
    expect(await afterRestart(storage, "UPDATE counter SET revision = revision + 1 RETURNING revision")).toEqual([
      { revision: "3" },
    ]);
    expect(await afterRestart(storage, "UPDATE counter SET revision = revision + 1 RETURNING revision")).toEqual([
      { revision: "4" },
    ]);
  });

  test("the acknowledgement waits for the storage write", async () => {
    const storage = new MemoryStorage();
    const server = await start(storage);
    const client = await connect(server);
    await client.query("CREATE TABLE ledger (id int)");

    for (const sql of ["INSERT INTO ledger VALUES (1)", "BEGIN; INSERT INTO ledger VALUES (2); COMMIT"]) {
      const hold = gate();
      storage.gate = hold.promise;
      const before = storage.writes;
      const query = client.query(sql);
      expect(await pending(query)).toBe("pending");
      expect(storage.writes).toBe(before);
      storage.gate = null;
      hold.open();
      await query;
      expect(storage.writes).toBe(before + 1);
    }
  });

  test("a commit being persisted is not visible to other sessions yet", async () => {
    const storage = new MemoryStorage();
    const server = await start(storage);
    const writer = await connect(server);
    const reader = await connect(server);
    await writer.query("CREATE TABLE ledger (id int)");

    const hold = gate();
    storage.gate = hold.promise;
    const insert = writer.query("INSERT INTO ledger VALUES (1)");
    const read = reader.query("SELECT count(*)::int AS n FROM ledger");
    expect(await pending(read)).toBe("pending");
    storage.gate = null;
    hold.open();
    await insert;
    expect((await read).rows).toEqual([{ n: 1 }]);
  });

  test("reads and session settings do not write storage", async () => {
    const storage = new MemoryStorage();
    const server = await start(storage);
    const client = await connect(server);
    await client.query("CREATE TABLE ledger (id int); INSERT INTO ledger VALUES (1)");
    const before = storage.writes;
    await client.query("SELECT * FROM ledger WHERE id = $1", [1]);
    await client.query("SET search_path = public");
    await client.query("SHOW search_path");
    await client.query("BEGIN");
    await client.query("INSERT INTO ledger VALUES (2)");
    await client.query("ROLLBACK");
    await expect(client.query("INSERT INTO missing VALUES (1)")).rejects.toMatchObject({ code: "42P01" });
    expect(storage.writes).toBe(before);
  });
});

describe("behavior 2: only acknowledged commits are restored", () => {
  test("an open transaction and a rolled-back one leave nothing behind", async () => {
    const storage = new MemoryStorage();
    const server = await start(storage);
    const client = await connect(server);
    await client.query("CREATE TABLE ledger (id int)");
    await client.query("INSERT INTO ledger VALUES (1)");

    await client.query("BEGIN");
    await client.query("INSERT INTO ledger VALUES (2)");
    await client.query("ROLLBACK");
    await client.query("BEGIN");
    await client.query("INSERT INTO ledger VALUES (3)");
    // Crash with the block still open.
    expect(await afterRestart(storage, "SELECT id FROM ledger ORDER BY id")).toEqual([{ id: 1 }]);
  });

  test("a storage failure fails the autocommit write and takes it back out of memory", async () => {
    const storage = new MemoryStorage();
    const server = await start(storage);
    const client = await connect(server);
    const other = await connect(server);
    await client.query("CREATE TABLE ledger (id serial PRIMARY KEY, note text)");

    storage.failNext = new Error("disk unplugged");
    await expect(client.query("INSERT INTO ledger (note) VALUES ('lost')")).rejects.toMatchObject({
      severity: "ERROR",
      code: "58030",
      message: "could not persist the commit to durable storage: disk unplugged",
    });
    expect((await client.query("SELECT count(*)::int AS n FROM ledger")).rows).toEqual([{ n: 0 }]);
    expect((await other.query("SELECT count(*)::int AS n FROM ledger")).rows).toEqual([{ n: 0 }]);
    expect(server.database.query("SELECT count(*)::int AS n FROM ledger")).toEqual([{ n: 0 }]);

    // The session is usable, and the failed write did not even consume its serial value.
    await client.query("INSERT INTO ledger (note) VALUES ('kept')");
    expect((await client.query("SELECT id, note FROM ledger")).rows).toEqual([{ id: 1, note: "kept" }]);
    expect(await afterRestart(storage, "SELECT id, note FROM ledger")).toEqual([{ id: 1, note: "kept" }]);
  });

  test("a storage failure fails COMMIT and the transaction is gone", async () => {
    const storage = new MemoryStorage();
    const server = await start(storage);
    const client = await connect(server);
    const listener = await connect(server);
    const heard: string[] = [];
    listener.on("notification", (message) => heard.push(message.payload ?? ""));
    await listener.query("LISTEN ledger_events");
    await client.query("CREATE TABLE ledger (id int)");

    await client.query("BEGIN");
    await client.query("INSERT INTO ledger VALUES (1)");
    await client.query("NOTIFY ledger_events, 'lost'");
    storage.failNext = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "53100" });

    // Idle again, not in an aborted block: the next statement runs.
    expect((await client.query("SELECT count(*)::int AS n FROM ledger")).rows).toEqual([{ n: 0 }]);
    await client.query("BEGIN");
    await client.query("INSERT INTO ledger VALUES (2)");
    await client.query("NOTIFY ledger_events, 'kept'");
    await client.query("COMMIT");
    await settle();
    expect(heard).toEqual(["kept"]);
    expect(await afterRestart(storage, "SELECT id FROM ledger")).toEqual([{ id: 2 }]);
  });

  test("a storage failure fails a multi-statement script, COPY, and CREATE DATABASE the same way", async () => {
    const storage = new MemoryStorage();
    const server = await start(storage);
    const client = await connect(server);
    await client.query("CREATE TABLE ledger (id int)");

    storage.failNext = new Error("down");
    await expect(client.query("INSERT INTO ledger VALUES (1); INSERT INTO ledger VALUES (2)")).rejects.toMatchObject({
      code: "58030",
    });
    expect((await client.query("SELECT count(*)::int AS n FROM ledger")).rows).toEqual([{ n: 0 }]);

    storage.failNext = new Error("down");
    await expect(client.query("CREATE DATABASE app")).rejects.toMatchObject({ code: "58030" });
    expect(server.databaseNames()).toEqual(["postgres"]);
    await client.query("CREATE DATABASE app");
    expect(server.databaseNames()).toEqual(["app", "postgres"]);

    storage.failNext = new Error("down");
    await expect(client.query("DROP DATABASE app")).rejects.toMatchObject({ code: "58030" });
    expect(server.databaseNames()).toEqual(["app", "postgres"]);
    expect(await afterRestart(storage, "SELECT datname FROM pg_database ORDER BY datname")).toEqual([
      { datname: "app" },
      { datname: "postgres" },
    ]);
  });
});

describe("behavior 4: the whole cluster is persisted", () => {
  test("databases, catalog objects, data, sequences and the random stream come back", async () => {
    const storage = new MemoryStorage();
    const server = await start(storage);
    const admin = await connect(server);
    await admin.query("CREATE DATABASE app");
    await admin.query("CREATE DATABASE scratch");
    await admin.query("CREATE DATABASE old_name");
    await admin.query("ALTER DATABASE old_name RENAME TO renamed");
    await admin.query("DROP DATABASE scratch");

    const app = await connect(server, "app");
    await app.query("CREATE SCHEMA billing");
    await app.query("CREATE TYPE billing.state AS ENUM ('open', 'paid')");
    await app.query(
      "CREATE TABLE billing.invoices (id serial PRIMARY KEY, state billing.state NOT NULL DEFAULT 'open', total numeric(10,2))",
    );
    await app.query("CREATE INDEX invoices_state ON billing.invoices (state)");
    await app.query("CREATE VIEW billing.open_invoices AS SELECT id, total FROM billing.invoices WHERE state = 'open'");
    await app.query("CREATE SEQUENCE billing.ticket START 100");
    await app.query("INSERT INTO billing.invoices (total) VALUES (10.50), (20.00)");
    await app.query("UPDATE billing.invoices SET state = 'paid' WHERE id = 2");
    expect((await app.query("SELECT nextval('billing.ticket')::int AS n")).rows).toEqual([{ n: 100 }]);
    const firstUuid = (await app.query("SELECT gen_random_uuid() AS id")).rows[0]?.id;
    await app.query("INSERT INTO billing.invoices (total) VALUES (30.00)");

    const restarted = await start(storage);
    expect(restarted.databaseNames()).toEqual(["app", "postgres", "renamed"]);
    const client = await connect(restarted, "app");
    expect((await client.query("SELECT id, state, total FROM billing.invoices ORDER BY id")).rows).toEqual([
      { id: 1, state: "open", total: "10.50" },
      { id: 2, state: "paid", total: "20.00" },
      { id: 3, state: "open", total: "30.00" },
    ]);
    expect((await client.query("SELECT id FROM billing.open_invoices ORDER BY id")).rows).toEqual([
      { id: 1 },
      { id: 3 },
    ]);
    expect(
      (await client.query("SELECT indexname FROM pg_indexes WHERE tablename = 'invoices' ORDER BY 1")).rows,
    ).toEqual([{ indexname: "invoices_pkey" }, { indexname: "invoices_state" }]);
    // Sequences and the deterministic random stream continue; they do not start over.
    expect((await client.query("INSERT INTO billing.invoices (total) VALUES (1) RETURNING id")).rows).toEqual([
      { id: 4 },
    ]);
    expect((await client.query("SELECT nextval('billing.ticket')::int AS n")).rows).toEqual([{ n: 101 }]);
    expect((await client.query("SELECT gen_random_uuid() AS id")).rows[0]?.id).not.toBe(firstUuid);
    // Sessions on the restored cluster are coordinated like any other.
    expect((await client.query("SELECT pg_try_advisory_lock(1) AS locked")).rows).toEqual([{ locked: true }]);
  });

  test("separate storages are isolated", async () => {
    const one = new MemoryStorage();
    const two = new MemoryStorage();
    const first = await connect(await start(one));
    const second = await connect(await start(two));
    await first.query("CREATE TABLE only_in_one (id int); INSERT INTO only_in_one VALUES (1)");
    await second.query("CREATE DATABASE only_in_two");

    expect(await afterRestart(one, "SELECT datname FROM pg_database ORDER BY 1")).toEqual([{ datname: "postgres" }]);
    expect(await afterRestart(one, "SELECT id FROM only_in_one")).toEqual([{ id: 1 }]);
    const restarted = await start(two);
    expect(restarted.databaseNames()).toEqual(["only_in_two", "postgres"]);
    const client = await connect(restarted);
    await expect(client.query("SELECT id FROM only_in_one")).rejects.toMatchObject({ code: "42P01" });
  });

  test("an empty storage is seeded from `database`; a populated one wins over it", async () => {
    const storage = new MemoryStorage();
    const seed = new Database();
    seed.exec("CREATE TABLE seeded (id int); INSERT INTO seeded VALUES (1)");
    const server = await start(storage, seed);
    expect(storage.writes).toBe(1);
    const client = await connect(server);
    await client.query("INSERT INTO seeded VALUES (2)");

    const other = new Database();
    other.exec("CREATE TABLE unused (id int)");
    const restarted = await start(storage, other);
    const again = await connect(restarted);
    expect((await again.query("SELECT id FROM seeded ORDER BY id")).rows).toEqual([{ id: 1 }, { id: 2 }]);
    await expect(again.query("SELECT * FROM unused")).rejects.toMatchObject({ code: "42P01" });
  });

  test("the restored databases keep the runtime of `database`", async () => {
    const storage = new MemoryStorage();
    const first = await connect(await start(storage, new Database({ now: "system" })));
    await first.query("CREATE TABLE stamped (at timestamptz DEFAULT now())");
    const restarted = await connect(await start(storage, new Database({ now: "system" })));
    const year = (await restarted.query("SELECT extract(year FROM now())::int AS year")).rows[0]?.year;
    expect(year).toBe(new Date().getUTCFullYear());
  });

  test("a storage without the default database is refused", async () => {
    const storage = new MemoryStorage();
    await start(storage);
    await expect(serve({ port: 0, durable: storage, databaseName: "app" })).rejects.toThrow(
      'durable storage holds no database "app"',
    );
  });

  test("persist() covers writes made outside a connection", async () => {
    const storage = new MemoryStorage();
    const server = await start(storage);
    server.database.exec("CREATE TABLE host_side (id int); INSERT INTO host_side VALUES (1)");
    const restartedEarly = await start(storage);
    expect(() => restartedEarly.database.query("SELECT * FROM host_side")).toThrow();
    await server.persist();
    expect(await afterRestart(storage, "SELECT id FROM host_side")).toEqual([{ id: 1 }]);
  });
});

describe("behavior 5: in-memory mode is unchanged", () => {
  const script = [
    "CREATE TABLE ledger (id serial PRIMARY KEY, token uuid DEFAULT gen_random_uuid(), at timestamptz DEFAULT now())",
    "INSERT INTO ledger DEFAULT VALUES",
    "SELECT random()",
    "BEGIN; INSERT INTO ledger DEFAULT VALUES; COMMIT",
  ];
  const run = async (server: PostgresServer): Promise<Uint8Array> => {
    const client = await connect(server);
    for (const sql of script) await client.query(sql);
    return server.snapshot().encode();
  };

  test("two in-memory servers are byte-for-byte identical, and persist() is a no-op", async () => {
    const one = await serve({ port: 0 });
    const two = await serve({ port: 0 });
    servers.push(one, two);
    const bytes = await run(one);
    expect(Buffer.from(await run(two)).equals(Buffer.from(bytes))).toBe(true);
    await one.persist();
  });

  test("durable mode reaches the same engine state as in-memory mode", async () => {
    const memory = await serve({ port: 0 });
    servers.push(memory);
    const storage = new MemoryStorage();
    const durable = await start(storage);
    const expected = Buffer.from(await run(memory));
    expect(Buffer.from(await run(durable)).equals(expected)).toBe(true);
    // ... and what storage holds is that same state, byte for byte.
    expect(Buffer.from(storage.image?.get("postgres") as Uint8Array).equals(expected)).toBe(true);
  });
});

describe("test controls", () => {
  test("pause before the acknowledgement: persisted, not yet acknowledged", async () => {
    const storage = new MemoryStorage();
    const hold = gate();
    const seen: DurableCommit[] = [];
    const server = await start({
      storage,
      beforeAcknowledge: (commit) => {
        seen.push(commit);
        return commit.sql.includes("'paused'") ? hold.promise : undefined;
      },
    });
    const client = await connect(server);
    await client.query("CREATE TABLE ledger (note text)");
    const insert = client.query("INSERT INTO ledger VALUES ('paused')");
    expect(await pending(insert)).toBe("pending");

    // Crash here: the client never saw the commit, and a restart has it (never the reverse).
    expect(await afterRestart(storage, "SELECT note FROM ledger")).toEqual([{ note: "paused" }]);
    hold.open();
    await insert;
    const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
    expect(seen.at(-1)).toEqual({ pid, database: "postgres", sql: "INSERT INTO ledger VALUES ('paused')" });
  });

  test("pause after the acknowledgement: the client has it and so does storage", async () => {
    const storage = new MemoryStorage();
    const hold = gate();
    const acknowledged: string[] = [];
    const server = await start({
      storage,
      afterAcknowledge: (commit) => {
        acknowledged.push(commit.sql);
        return hold.promise;
      },
    });
    const client = await connect(server);
    const create = client.query("CREATE TABLE ledger (note text)");
    await settle();
    expect(acknowledged).toEqual(["CREATE TABLE ledger (note text)"]);
    expect(await afterRestart(storage, "SELECT count(*)::int AS n FROM ledger")).toEqual([{ n: 0 }]);
    hold.open();
    await create;

    await client.query("BEGIN");
    await client.query("INSERT INTO ledger VALUES ('a')");
    await client.query("COMMIT");
    expect(acknowledged.at(-1)).toBe("COMMIT");
  });

  test("a connection lost while its commit is being persisted does not release the turn early", async () => {
    const storage = new MemoryStorage();
    const server = await start(storage);
    const doomed = await connect(server);
    const other = await connect(server);
    await doomed.query("CREATE TABLE ledger (id int)");

    const hold = gate();
    storage.gate = hold.promise;
    storage.failNext = new Error("down");
    const insert = doomed.query("INSERT INTO ledger VALUES (1)").catch(() => undefined);
    await settle();
    (doomed as unknown as { connection: { stream: { destroy(): void } } }).connection.stream.destroy();
    const write = other.query("INSERT INTO ledger VALUES (2)");
    expect(await pending(write)).toBe("pending");
    storage.gate = null;
    hold.open();
    await insert;
    await write;
    // The failed commit was undone before the other session's write was applied on top.
    expect((await other.query("SELECT id FROM ledger")).rows).toEqual([{ id: 2 }]);
    expect(await afterRestart(storage, "SELECT id FROM ledger")).toEqual([{ id: 2 }]);
  });
});
