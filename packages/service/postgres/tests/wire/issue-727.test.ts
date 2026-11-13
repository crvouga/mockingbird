import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import pg from "pg";
import { Database } from "../../src/index.ts";
import { type PostgresServer, serve } from "../../src/wire/index.ts";

// #727 over the wire, with a system clock: now() is frozen per transaction (per connection),
// clock_timestamp() advances, pg_sleep sleeps, statement_timeout cancels with 57014.

let server: PostgresServer;

const connect = async (): Promise<pg.Client> => {
  const client = new pg.Client({ connectionString: `postgres://postgres@${server.host}:${server.port}/postgres` });
  // timestamps as text, to keep their microseconds
  client.setTypeParser(1184, (value: string) => value);
  await client.connect();
  return client;
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const errorCode = async (run: Promise<unknown>): Promise<string | undefined> => {
  try {
    await run;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

beforeAll(async () => {
  server = await serve({ port: 0, database: new Database({ now: "system" }) });
});

afterAll(async () => {
  await server.close();
});

describe("transaction-frozen now() over the wire", () => {
  test("two now() in one BEGIN block return the transaction start; clock_timestamp() moves", async () => {
    const client = await connect();
    try {
      await client.query("BEGIN");
      const first = (await client.query("SELECT now()::text AS n, clock_timestamp()::text AS c")).rows[0];
      await pause(40);
      const second = (
        await client.query(
          "SELECT now()::text AS n, clock_timestamp()::text AS c, statement_timestamp() > now() AS moved, clock_timestamp() > now() AS clock",
        )
      ).rows[0];
      await client.query("COMMIT");
      expect(second.n).toBe(first.n);
      expect(second.c).not.toBe(first.c);
      expect(second.moved).toBe(true);
      expect(second.clock).toBe(true);
      const after = (await client.query("SELECT now()::text AS n")).rows[0];
      expect(after.n).not.toBe(first.n);
    } finally {
      await client.end();
    }
  });

  test("rows written with now() in a block commit with the value the block saw", async () => {
    const client = await connect();
    try {
      await client.query("CREATE TABLE stamped_727 (id int, at timestamptz)");
      await client.query("BEGIN");
      await client.query("INSERT INTO stamped_727 VALUES (1, now())");
      await pause(25);
      await client.query("INSERT INTO stamped_727 VALUES (2, now())");
      const seen = (await client.query("SELECT now()::text AS n")).rows[0].n;
      await pause(25);
      await client.query("COMMIT");
      const rows = (await client.query("SELECT DISTINCT at::text AS at FROM stamped_727")).rows;
      expect(rows).toEqual([{ at: seen }]);
    } finally {
      await client.end();
    }
  });

  test("each connection has its own transaction start", async () => {
    const a = await connect();
    const b = await connect();
    try {
      await a.query("BEGIN");
      const aNow = (await a.query("SELECT now()::text AS n")).rows[0].n;
      await pause(20);
      await b.query("BEGIN");
      const bNow = (await b.query("SELECT now()::text AS n")).rows[0].n;
      await pause(20);
      expect((await a.query("SELECT now()::text AS n")).rows[0].n).toBe(aNow);
      expect((await b.query("SELECT now()::text AS n")).rows[0].n).toBe(bNow);
      expect(bNow).not.toBe(aNow);
      await a.query("COMMIT");
      await b.query("COMMIT");
    } finally {
      await a.end();
      await b.end();
    }
  });

  test("pg_sleep sleeps", async () => {
    const client = await connect();
    try {
      const start = performance.now();
      await client.query("SELECT pg_sleep(0.05)");
      expect(performance.now() - start).toBeGreaterThanOrEqual(49);
    } finally {
      await client.end();
    }
  });
});

describe("statement_timeout over the wire", () => {
  const heavy = "SELECT count(*) FROM generate_series(1, 3000000) g WHERE g % 7 = 3";

  test("a long statement fails with 57014; the session goes on", async () => {
    const client = await connect();
    try {
      await client.query("SET statement_timeout = '1ms'");
      let error: { code?: string; message?: string } | undefined;
      try {
        await client.query(heavy);
      } catch (e) {
        error = e as typeof error;
      }
      expect(error?.code).toBe("57014");
      expect(error?.message).toBe("canceling statement due to statement timeout");
      expect((await client.query("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
      await client.query("SET statement_timeout = 50");
      const start = performance.now();
      expect(await errorCode(client.query("SELECT pg_sleep(2)"))).toBe("57014");
      expect(performance.now() - start).toBeLessThan(1500);
    } finally {
      await client.end();
    }
  });

  test("inside a block the timeout aborts the transaction (25P02 until ROLLBACK)", async () => {
    const client = await connect();
    const other = await connect();
    try {
      await client.query("CREATE TABLE timed_727 (g int)");
      await client.query("BEGIN");
      await client.query("INSERT INTO timed_727 VALUES (0)");
      await client.query("SET LOCAL statement_timeout = 1");
      expect(await errorCode(client.query("INSERT INTO timed_727 SELECT g FROM generate_series(1, 2000000) g"))).toBe(
        "57014",
      );
      expect(await errorCode(client.query("SELECT 1"))).toBe("25P02");
      // another connection is not affected
      expect((await other.query(heavy.replace("3000000", "1000"))).rows).toEqual([{ count: "143" }]);
      expect((await client.query("COMMIT")).command).toBe("ROLLBACK");
      expect((await client.query("SELECT count(*)::int AS c FROM timed_727")).rows).toEqual([{ c: 0 }]);
      expect((await client.query("SHOW statement_timeout")).rows).toEqual([{ statement_timeout: "0" }]);
    } finally {
      await client.end();
      await other.end();
    }
  });
});
