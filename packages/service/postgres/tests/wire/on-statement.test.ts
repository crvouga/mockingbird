import { expect, test } from "bun:test";
import pg from "pg";
import { Database } from "../../src/index.ts";
import { type StatementEvent, serve } from "../../src/wire/index.ts";

// #898: serve() passes a statement observer through to every connection.

const spinning = (): Database => {
  const db = new Database();
  db.registerFunction({
    name: "spin",
    args: ["int4"],
    returns: "int4",
    fn: (ms) => {
      const end = performance.now() + Number(ms);
      while (performance.now() < end) {}
      return Number(ms);
    },
  });
  return db;
};

test("onStatement reports slow statements a client ran, without parameter values by default", async () => {
  const events: StatementEvent[] = [];
  const server = await serve({
    port: 0,
    database: spinning(),
    onStatement: (event) => events.push(event),
    slowStatementMs: 25,
  });
  const client = new pg.Client({ connectionString: `postgres://postgres@${server.host}:${server.port}/postgres` });
  await client.connect();
  try {
    await client.query("SELECT 1");
    await client.query("SELECT spin(50) AS ms WHERE $1::text IS NOT NULL", ["secret"]);
    await client.query("SELECT spin(40)");
    expect(events.map((event) => event.sql)).toEqual([
      "SELECT spin(50) AS ms WHERE $1::text IS NOT NULL",
      "SELECT spin(40)",
    ]);
    for (const event of events) {
      expect(event.durationMs).toBeGreaterThanOrEqual(25);
      expect(event.rows).toBe(1);
      expect(typeof event.pid).toBe("number");
      expect(event).not.toHaveProperty("params");
    }
  } finally {
    await client.end();
    await server.close();
  }
});

test("includeParams adds parameter values; errors are reported", async () => {
  const events: StatementEvent[] = [];
  const server = await serve({ port: 0, onStatement: (event) => events.push(event), includeParams: true });
  const client = new pg.Client({ connectionString: `postgres://postgres@${server.host}:${server.port}/postgres` });
  await client.connect();
  try {
    await client.query("SELECT $1::int AS n", [7]);
    await client.query("SELECT 1/0").catch(() => {});
    expect(events.find((event) => event.sql === "SELECT $1::int AS n")).toMatchObject({ params: ["7"], rows: 1 });
    const failed = events.find((event) => event.sql === "SELECT 1/0");
    expect((failed?.error as { sqlState?: string } | undefined)?.sqlState).toBe("22012");
  } finally {
    await client.end();
    await server.close();
  }
});
