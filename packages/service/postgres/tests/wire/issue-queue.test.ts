import { expect, test } from "bun:test";
import pg from "pg";
import { Database } from "../../src/index.ts";
import { serve } from "../../src/wire/index.ts";

test("#462 wire xmin remains stable across workspace replay and commit", async () => {
  const server = await serve({ database: new Database() });
  const client = new pg.Client({ connectionString: server.connectionString });
  const observer = new pg.Client({ connectionString: server.connectionString });
  await client.connect();
  await observer.connect();
  try {
    await client.query("CREATE TABLE versions (id int PRIMARY KEY); INSERT INTO versions VALUES (1)");
    const read = async (connection: pg.Client) =>
      (await connection.query("SELECT v.xmin::text AS xmin FROM versions v ORDER BY id")).rows;
    const first = await read(client);
    await client.query("BEGIN; UPDATE versions SET id = id; INSERT INTO versions VALUES (2)");
    const pending = await read(client);
    expect(pending[0].xmin).toBe(pending[1].xmin);
    expect(pending[0].xmin).not.toBe(first[0].xmin);
    expect(await read(client)).toEqual(pending);
    expect(await read(observer)).toEqual(first);
    await client.query("COMMIT");
    expect(await read(observer)).toEqual(pending);
    await client.query("BEGIN; UPDATE versions SET id = id; ROLLBACK");
    expect(await read(observer)).toEqual(pending);
  } finally {
    await client.end();
    await observer.end();
    await server.close();
  }
});
