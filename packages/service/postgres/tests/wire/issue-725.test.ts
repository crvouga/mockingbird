import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Socket } from "node:net";
import pg from "pg";
import { type PostgresServer, serve } from "../../src/wire/index.ts";

// #725 over the wire: the connection's socket addresses, advisory locks in pg_locks, the _shared
// advisory lock functions and their conflicts across sessions, current_query() and is_superuser.

let server: PostgresServer;

const connect = async (): Promise<pg.Client> => {
  const client = new pg.Client({ connectionString: `postgres://postgres@${server.host}:${server.port}/postgres` });
  await client.connect();
  return client;
};

const withClients = async (n: number, fn: (...clients: pg.Client[]) => Promise<void>): Promise<void> => {
  const clients = await Promise.all(Array.from({ length: n }, connect));
  try {
    await fn(...clients);
  } finally {
    await Promise.all(clients.map((c) => c.end()));
  }
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

const localPort = (client: pg.Client): number =>
  ((client as unknown as { connection: { stream: Socket } }).connection.stream as Socket).localPort!;

beforeAll(async () => {
  server = await serve({ port: 0 });
});

afterAll(async () => {
  await server.close();
});

describe("#725 inet_server_addr / inet_server_port / inet_client_addr / inet_client_port", () => {
  test("a TCP connection reports both ends of its socket", async () => {
    await withClients(1, async (c) => {
      const { rows } = await c.query(
        `SELECT host(inet_server_addr()) AS sa, inet_server_port() AS sp, host(inet_client_addr()) AS ca,
                inet_client_port() AS cp, pg_typeof(inet_server_addr())::text AS t, pg_typeof(inet_server_port())::text AS pt`,
      );
      expect(rows).toEqual([
        { sa: "127.0.0.1", sp: server.port, ca: "127.0.0.1", cp: localPort(c), t: "inet", pt: "integer" },
      ]);
      // inet output carries the host mask
      expect((await c.query("SELECT inet_server_addr()::text AS a")).rows).toEqual([{ a: "127.0.0.1/32" }]);
    });
  });

  test("each session sees its own client port, and pg_stat_activity lists it", async () => {
    await withClients(2, async (a, b) => {
      const portA = (await a.query("SELECT inet_client_port() AS p")).rows[0].p;
      const portB = (await b.query("SELECT inet_client_port() AS p")).rows[0].p;
      expect(portA).toBe(localPort(a));
      expect(portB).toBe(localPort(b));
      expect(portA).not.toBe(portB);
      const { rows } = await a.query(
        "SELECT host(client_addr) AS addr, client_port FROM pg_stat_activity WHERE pid = pg_backend_pid()",
      );
      expect(rows).toEqual([{ addr: "127.0.0.1", client_port: portA }]);
    });
  });

  test("a connection without a socket (web streams) answers NULL, as over a Unix socket", async () => {
    const db = server.database;
    // the engine handle itself has no session socket
    expect(db.query("SELECT inet_server_addr() AS a, inet_client_port() AS p")).toEqual([{ a: null, p: null }]);
  });
});

describe("#725 advisory locks across sessions", () => {
  const lockRows = (client: pg.Client) =>
    client
      .query(
        `SELECT locktype, classid::int AS classid, objid::int AS objid, objsubid, mode, granted, pid
         FROM pg_locks WHERE locktype = 'advisory' ORDER BY objid, objsubid, pid, mode`,
      )
      .then((r) => r.rows);
  const pidOf = async (client: pg.Client): Promise<number> =>
    (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;

  test("shared locks are compatible with each other and conflict with an exclusive lock", async () => {
    await withClients(3, async (a, b, c) => {
      const [pa, pb, pc] = [await pidOf(a), await pidOf(b), await pidOf(c)];
      await a.query("SELECT pg_advisory_lock_shared(725)");
      expect((await b.query("SELECT pg_try_advisory_lock_shared(725) AS got")).rows).toEqual([{ got: true }]);
      expect((await c.query("SELECT pg_try_advisory_lock(725) AS got")).rows).toEqual([{ got: false }]);
      expect(await lockRows(c)).toEqual([
        {
          locktype: "advisory",
          classid: 0,
          objid: 725,
          objsubid: 1,
          mode: "ShareLock",
          granted: true,
          pid: Math.min(pa, pb),
        },
        {
          locktype: "advisory",
          classid: 0,
          objid: 725,
          objsubid: 1,
          mode: "ShareLock",
          granted: true,
          pid: Math.max(pa, pb),
        },
      ]);
      // an exclusive request waits for both shared holders
      const waiting = c.query("SELECT pg_advisory_lock(725)");
      const raced = await Promise.race([waiting.then(() => "acquired"), settle().then(() => "blocked")]);
      expect(raced).toBe("blocked");
      const pending = await lockRows(a);
      expect(pending.filter((r: { granted: boolean }) => !r.granted)).toEqual([
        { locktype: "advisory", classid: 0, objid: 725, objsubid: 1, mode: "ExclusiveLock", granted: false, pid: pc },
      ]);
      expect((await a.query("SELECT pg_advisory_unlock_shared(725) AS ok")).rows).toEqual([{ ok: true }]);
      const still = await Promise.race([waiting.then(() => "acquired"), settle().then(() => "blocked")]);
      expect(still).toBe("blocked");
      expect((await b.query("SELECT pg_advisory_unlock_shared(725) AS ok")).rows).toEqual([{ ok: true }]);
      await waiting;
      // now exclusive: a shared request fails
      expect((await a.query("SELECT pg_try_advisory_lock_shared(725) AS got")).rows).toEqual([{ got: false }]);
      expect((await c.query("SELECT pg_advisory_unlock(725) AS ok")).rows).toEqual([{ ok: true }]);
      expect((await a.query("SELECT pg_try_advisory_lock_shared(725) AS got")).rows).toEqual([{ got: true }]);
      await a.query("SELECT pg_advisory_unlock_all()");
    });
  });

  test("the (int4, int4) form, and unlocking a lock another session holds", async () => {
    await withClients(2, async (a, b) => {
      await a.query("SELECT pg_advisory_lock(7, 25)");
      expect((await b.query("SELECT pg_try_advisory_lock_shared(7, 25) AS got")).rows).toEqual([{ got: false }]);
      // the bigint key 7 is a different lock from (7, 25)
      expect((await b.query("SELECT pg_try_advisory_lock(7) AS got")).rows).toEqual([{ got: true }]);
      expect((await b.query("SELECT pg_advisory_unlock(7, 25) AS ok")).rows).toEqual([{ ok: false }]);
      const rows = await lockRows(b);
      expect(
        rows.map((r: { classid: number; objid: number; objsubid: number }) => [r.classid, r.objid, r.objsubid]),
      ).toEqual([
        [0, 7, 1],
        [7, 25, 2],
      ]);
      expect((await a.query("SELECT pg_advisory_unlock(7, 25) AS ok")).rows).toEqual([{ ok: true }]);
      expect((await b.query("SELECT pg_advisory_unlock(7) AS ok, pg_advisory_unlock(7) AS again")).rows).toEqual([
        { ok: true, again: false },
      ]);
    });
  });

  test("transaction-level shared locks end with the transaction", async () => {
    await withClients(2, async (a, b) => {
      await a.query("BEGIN");
      await a.query("SELECT pg_advisory_xact_lock_shared(9)");
      expect((await b.query("SELECT pg_try_advisory_xact_lock_shared(9) AS got")).rows).toEqual([{ got: true }]);
      expect((await b.query("SELECT pg_try_advisory_xact_lock(9) AS got")).rows).toEqual([{ got: false }]);
      await a.query("COMMIT");
      expect((await b.query("SELECT pg_try_advisory_lock(9) AS got")).rows).toEqual([{ got: true }]);
      expect(await lockRows(a)).toEqual([
        {
          locktype: "advisory",
          classid: 0,
          objid: 9,
          objsubid: 1,
          mode: "ExclusiveLock",
          granted: true,
          pid: await pidOf(b),
        },
      ]);
      await b.query("SELECT pg_advisory_unlock(9)");
    });
  });

  test("a closed session's advisory locks are gone from pg_locks", async () => {
    const a = await connect();
    await a.query("SELECT pg_advisory_lock_shared(11)");
    await a.end();
    await withClients(1, async (b) => {
      await settle();
      expect(await lockRows(b)).toEqual([]);
    });
  });
});

describe("#725 current_query and is_superuser per session", () => {
  test("current_query() is the text the client sent", async () => {
    await withClients(1, async (c) => {
      expect((await c.query("SELECT current_query() AS q")).rows).toEqual([{ q: "SELECT current_query() AS q" }]);
      expect((await c.query({ text: "SELECT current_query() AS q, $1::int AS n", values: [1] })).rows).toEqual([
        { q: "SELECT current_query() AS q, $1::int AS n", n: 1 },
      ]);
    });
  });

  test("is_superuser follows SET ROLE in that session only", async () => {
    await withClients(2, async (a, b) => {
      await a.query("CREATE ROLE wire725");
      await a.query("SET ROLE wire725");
      expect((await a.query("SHOW is_superuser")).rows).toEqual([{ is_superuser: "off" }]);
      expect((await b.query("SELECT current_setting('is_superuser') AS s")).rows).toEqual([{ s: "on" }]);
      await a.query("RESET ROLE");
      expect((await a.query("SHOW is_superuser")).rows).toEqual([{ is_superuser: "on" }]);
      await a.query("DROP ROLE wire725");
    });
  });
});

describe("#725 pg_db_role_setting over the wire", () => {
  test("ALTER DATABASE ... SET / RESET reaches the engine instead of the cluster's database DDL", async () => {
    await withClients(1, async (c) => {
      const result = await c.query("ALTER DATABASE postgres SET work_mem = '2MB'");
      expect(result.command).toBe("ALTER");
      expect((await c.query("SELECT setdatabase, setrole, setconfig FROM pg_db_role_setting")).rows).toEqual([
        { setdatabase: 5, setrole: 0, setconfig: ["work_mem=2MB"] },
      ]);
      await c.query("ALTER DATABASE postgres RESET work_mem");
      expect((await c.query("SELECT count(*)::int AS n FROM pg_db_role_setting")).rows).toEqual([{ n: 0 }]);
      await expect(c.query("ALTER DATABASE nope SET work_mem = '2MB'")).rejects.toMatchObject({ code: "3D000" });
    });
  });
});
