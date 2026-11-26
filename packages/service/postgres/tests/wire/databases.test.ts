import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import pg from "pg";
import { type PostgresServer, serve } from "../../src/wire/index.ts";

let server: PostgresServer;

const url = (database: string) => `postgres://postgres@${server.host}:${server.port}/${encodeURIComponent(database)}`;

const connect = async (database: string): Promise<pg.Client> => {
  const client = new pg.Client({ connectionString: url(database) });
  await client.connect();
  return client;
};

beforeAll(async () => {
  server = await serve({ port: 0 });
});

afterAll(async () => {
  await server.close();
});

describe("wire database cluster", () => {
  test("creates isolated databases and exposes pg_database", async () => {
    const admin = await connect("postgres");
    await admin.query("CREATE DATABASE demo_test");
    await admin.query("CREATE DATABASE medplum_test");

    const demo = await connect("demo_test");
    const medplum = await connect("medplum_test");
    try {
      await demo.query("CREATE TABLE items (id int); INSERT INTO items VALUES (1)");
      await medplum.query("CREATE TABLE items (id int); INSERT INTO items VALUES (2)");
      expect((await demo.query("SELECT * FROM items")).rows).toEqual([{ id: 1 }]);
      expect((await medplum.query("SELECT * FROM items")).rows).toEqual([{ id: 2 }]);
      expect((await demo.query("SELECT current_database() AS name")).rows).toEqual([{ name: "demo_test" }]);

      const catalog = await admin.query("SELECT datname FROM pg_database ORDER BY datname");
      expect(catalog.rows.map((row) => row.datname)).toEqual(["demo_test", "medplum_test", "postgres"]);
    } finally {
      await demo.end();
      await medplum.end();
      await admin.end();
    }
  });

  test("clones a template through the copy-on-write snapshot path", async () => {
    const admin = await connect("postgres");
    await admin.query("CREATE DATABASE template_seed");
    const template = await connect("template_seed");
    await template.query("CREATE TABLE seed (id int); INSERT INTO seed VALUES (7)");
    await template.end();

    await admin.query("CREATE DATABASE suite_42 TEMPLATE template_seed");
    const suite = await connect("suite_42");
    try {
      expect((await suite.query("SELECT * FROM seed")).rows).toEqual([{ id: 7 }]);
      await suite.query("INSERT INTO seed VALUES (8)");
    } finally {
      await suite.end();
    }
    const original = await connect("template_seed");
    try {
      expect((await original.query("SELECT * FROM seed ORDER BY id")).rows).toEqual([{ id: 7 }]);
    } finally {
      await original.end();
      await admin.end();
    }
  });

  test("enforces active-connection and startup SQLSTATEs", async () => {
    const admin = await connect("postgres");
    await admin.query("CREATE DATABASE lifecycle_test");
    const active = await connect("lifecycle_test");
    await expect(admin.query("DROP DATABASE lifecycle_test")).rejects.toMatchObject({ code: "55006" });
    await active.end();
    await admin.query("ALTER DATABASE lifecycle_test RENAME TO renamed_test");
    await expect(connect("lifecycle_test")).rejects.toMatchObject({ code: "3D000" });
    const renamed = await connect("renamed_test");
    await renamed.end();
    await admin.query("DROP DATABASE renamed_test");
    await expect(connect("renamed_test")).rejects.toMatchObject({ code: "3D000" });
    await admin.end();
  });
});
