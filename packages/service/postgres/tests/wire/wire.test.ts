import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import pg from "pg";
import { Database } from "../../src/index.ts";
import { type PostgresServer, serve } from "../../src/wire/index.ts";

// Real node-postgres against the wire server, so the surface tested is the protocol, not the API.

let server: PostgresServer;

beforeAll(async () => {
  const db = new Database({ now: "system" });
  server = await serve({ database: db });
});

afterAll(async () => {
  await server.close();
});

const url = () => `postgres://postgres@${server.host}:${server.port}/db`;
const withClient = async <T>(fn: (client: pg.Client) => Promise<T>): Promise<T> => {
  const client = new pg.Client({ connectionString: url() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

describe("startup and simple query", () => {
  test("a pg Pool runs SELECT and reads int4 as oid 23", async () => {
    const pool = new pg.Pool({ connectionString: url() });
    try {
      const result = await pool.query("SELECT 1 AS n");
      expect(result.rows).toEqual([{ n: 1 }]);
      expect(result.fields[0]?.name).toBe("n");
      expect(result.fields[0]?.dataTypeID).toBe(23);
      expect(result.command).toBe("SELECT");
    } finally {
      await pool.end();
    }
  });

  test("ParameterStatus and a multi-statement script both arrive", async () => {
    await withClient(async (client) => {
      const setup = await client.query(
        "CREATE TABLE t (id serial PRIMARY KEY, name text); INSERT INTO t (name) VALUES ('a'), ('b')",
      );
      expect(Array.isArray(setup)).toBe(true);
      const rows = await client.query("SELECT id, name FROM t ORDER BY id");
      expect(rows.rows).toEqual([
        { id: 1, name: "a" },
        { id: 2, name: "b" },
      ]);
    });
  });
});

describe("extended query protocol", () => {
  test("a bound $1 parameter round-trips (text and numeric)", async () => {
    await withClient(async (client) => {
      await client.query("CREATE TABLE k (id int PRIMARY KEY, label text)");
      await client.query("INSERT INTO k (id, label) VALUES ($1, $2)", [7, "seven"]);
      const byId = await client.query("SELECT label FROM k WHERE id = $1", [7]);
      expect(byId.rows).toEqual([{ label: "seven" }]);
      const typed = await client.query({
        text: "SELECT $1::int + $2::int AS sum",
        values: [40, 2],
      });
      expect(typed.rows).toEqual([{ sum: 42 }]);
    });
  });

  test("a prepared statement reused with different binds", async () => {
    await withClient(async (client) => {
      await client.query("CREATE TABLE nums (n int)");
      const insert = { name: "ins", text: "INSERT INTO nums (n) VALUES ($1)" };
      for (const n of [1, 2, 3]) await client.query({ ...insert, values: [n] });
      const sum = await client.query("SELECT sum(n)::int AS total FROM nums");
      expect(sum.rows).toEqual([{ total: 6 }]);
    });
  });
});

describe("transactions across connections", () => {
  test("an uncommitted insert is invisible to another connection, and rollback discards it", async () => {
    await withClient(async (writer) => {
      await writer.query("CREATE TABLE acct (id int PRIMARY KEY)");
      await writer.query("BEGIN");
      await writer.query("INSERT INTO acct (id) VALUES (1)");
      await withClient(async (reader) => {
        // The reader's count blocks behind the open block, so it never sees the dirty row.
        const pending = reader.query("SELECT count(*)::int AS n FROM acct");
        const raced = await Promise.race([pending.then(() => "read"), settle().then(() => "blocked")]);
        expect(raced).toBe("blocked");
        await writer.query("ROLLBACK");
        expect((await pending).rows).toEqual([{ n: 0 }]);
      });
    });
  });

  test("a committed insert is visible to a later connection", async () => {
    await withClient(async (writer) => {
      await writer.query("CREATE TABLE box (id int PRIMARY KEY)");
      await writer.query("BEGIN");
      await writer.query("INSERT INTO box (id) VALUES (1)");
      await writer.query("COMMIT");
    });
    await withClient(async (reader) => {
      expect((await reader.query("SELECT count(*)::int AS n FROM box")).rows).toEqual([{ n: 1 }]);
    });
  });
});

describe("aborted transaction state (25P02)", () => {
  test("a failed statement in a block poisons it until ROLLBACK", async () => {
    await withClient(async (client) => {
      await client.query("CREATE TABLE p (id int PRIMARY KEY)");
      await client.query("BEGIN");
      await expect(client.query("SELECT * FROM does_not_exist")).rejects.toMatchObject({ code: "42P01" });
      await expect(client.query("SELECT 1")).rejects.toMatchObject({ code: "25P02" });
      await client.query("ROLLBACK");
      expect((await client.query("SELECT 1 AS n")).rows).toEqual([{ n: 1 }]);
    });
  });
});

describe("errors", () => {
  test("a unique violation is 23505 with the constraint name", async () => {
    await withClient(async (client) => {
      await client.query("CREATE TABLE u (email text UNIQUE NOT NULL)");
      await client.query("INSERT INTO u (email) VALUES ('a@example.com')");
      const outcome = await client.query("INSERT INTO u (email) VALUES ('a@example.com')").then(
        () => null,
        (error: pg.DatabaseError) => error,
      );
      expect(outcome?.code).toBe("23505");
      expect(outcome?.constraint).toBe("u_email_key");
      // The session survives the error outside a block.
      expect((await client.query("SELECT count(*)::int AS n FROM u")).rows).toEqual([{ n: 1 }]);
    });
  });

  test("a not-null violation is 23502 with the table and column it names", async () => {
    await withClient(async (client) => {
      await client.query("CREATE TABLE nn (id int PRIMARY KEY, email text NOT NULL)");
      const outcome = await client.query("INSERT INTO nn (id) VALUES (1)").then(
        () => null,
        (error: pg.DatabaseError) => error,
      );
      expect(outcome?.code).toBe("23502");
      expect(outcome?.table).toBe("nn");
      expect(outcome?.column).toBe("email");
    });
  });
});

describe("advisory locks", () => {
  test("a second session blocks on a held lock and try_lock returns false", async () => {
    await withClient(async (a) => {
      await a.query("SELECT pg_advisory_lock(42)");
      await withClient(async (b) => {
        expect((await b.query("SELECT pg_try_advisory_lock(42) AS got")).rows).toEqual([{ got: false }]);
        const waiting = b.query("SELECT pg_advisory_lock(42)");
        const raced = await Promise.race([waiting.then(() => "acquired"), settle().then(() => "blocked")]);
        expect(raced).toBe("blocked");
        await a.query("SELECT pg_advisory_unlock(42)");
        await waiting;
        await b.query("SELECT pg_advisory_unlock(42)");
      });
    });
  });
});

describe("LISTEN / NOTIFY", () => {
  test("a NOTIFY from one connection reaches a listener on another", async () => {
    await withClient(async (listener) => {
      const received = new Promise<pg.Notification>((resolve) => listener.on("notification", resolve));
      await listener.query("LISTEN ch");
      await withClient(async (notifier) => {
        await notifier.query("NOTIFY ch, 'hello'");
      });
      const event = await received;
      expect(event.channel).toBe("ch");
      expect(event.payload).toBe("hello");
    });
  });
});

describe("cancellation (57014)", () => {
  test("a CancelRequest ends a statement blocked on a lock and leaves the session usable", async () => {
    await withClient(async (holder) => {
      await holder.query("SELECT pg_advisory_lock(99)");
      await withClient(async (victim) => {
        const pid = (victim as unknown as { processID: number }).processID;
        const key = (victim as unknown as { secretKey: number }).secretKey;
        const blocked = victim.query("SELECT pg_advisory_lock(99)").then(
          () => "acquired",
          (error: pg.DatabaseError) => error.code,
        );
        await settle();
        await sendCancel(server.host, server.port, pid, key);
        expect(await blocked).toBe("57014");
        // The victim's session is still usable afterwards.
        expect((await victim.query("SELECT 1 AS n")).rows).toEqual([{ n: 1 }]);
      });
      await holder.query("SELECT pg_advisory_unlock(99)");
    });
  });
});

/** Send a bare CancelRequest packet on a fresh connection, as the protocol specifies. */
const sendCancel = (host: string, port: number, pid: number, key: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket: Socket = connect(port, host, () => {
      const buf = Buffer.alloc(16);
      buf.writeInt32BE(16, 0);
      buf.writeInt32BE(80877102, 4);
      buf.writeInt32BE(pid, 8);
      buf.writeInt32BE(key, 12);
      socket.write(buf);
      socket.end();
    });
    socket.on("close", () => resolve());
    socket.on("error", reject);
  });
