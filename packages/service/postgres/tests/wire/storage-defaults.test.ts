import { expect, test } from "bun:test";
import pg from "pg";
import { serve } from "../../src/wire/index.ts";

test("dump defaults and local set_config persist across wire transaction statements (#430)", async () => {
  const server = await serve({ port: 0 });
  const client = new pg.Client({ connectionString: `postgres://postgres@${server.host}:${server.port}/postgres` });
  await client.connect();
  try {
    await client.query(
      "SET default_tablespace = ''; SET default_table_access_method = heap; CREATE TABLE dump_rows(id int)",
    );
    await client.query("SET default_tablespace = pg_default");
    await client.query("BEGIN");
    await client.query("SELECT set_config('default_tablespace', '', true)");
    expect((await client.query("SHOW default_tablespace")).rows).toEqual([{ default_tablespace: "" }]);
    await client.query("ROLLBACK");
    expect((await client.query("SHOW default_tablespace")).rows).toEqual([{ default_tablespace: "pg_default" }]);
    await client.query("RESET default_tablespace");
    expect((await client.query("SHOW default_tablespace")).rows).toEqual([{ default_tablespace: "" }]);
  } finally {
    await client.end();
    await server.close();
  }
});
