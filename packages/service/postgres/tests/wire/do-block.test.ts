import { afterAll, beforeAll, expect, test } from "bun:test";
import pg from "pg";
import { type PostgresServer, serve } from "../../src/wire/index.ts";

let server: PostgresServer;

beforeAll(async () => {
  server = await serve({ port: 0 });
});

afterAll(async () => {
  await server.close();
});

// #534: DO blocks execute over the wire
test("DO blocks run, report DO, and raise with the block's own SQLSTATE", async () => {
  const client = new pg.Client({ connectionString: `postgres://postgres@${server.host}:${server.port}/postgres` });
  await client.connect();
  try {
    const block = `DO $$ BEGIN CREATE TYPE retry_status AS ENUM ('pending'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`;
    expect((await client.query(block)).command).toBe("DO");
    expect((await client.query(block)).command).toBe("DO");
    expect((await client.query("SELECT count(*)::int AS n FROM pg_type WHERE typname = 'retry_status'")).rows).toEqual([
      { n: 1 },
    ]);
    await expect(client.query("DO $$ BEGIN RAISE EXCEPTION 'boom'; END $$")).rejects.toMatchObject({
      code: "P0001",
      message: "boom",
    });
    await expect(client.query("DO $$ BEGIN FOR i IN 1..3 LOOP NULL; END LOOP; END $$")).rejects.toMatchObject({
      code: "0A000",
    });
    await client.query("BEGIN");
    await client.query("DO $$ BEGIN CREATE TABLE in_tx (id int); END $$");
    await client.query("ROLLBACK");
    expect((await client.query("SELECT count(*)::int AS n FROM pg_class WHERE relname = 'in_tx'")).rows).toEqual([
      { n: 0 },
    ]);
  } finally {
    await client.end();
  }
});
