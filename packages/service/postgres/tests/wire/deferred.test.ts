import { expect, test } from "bun:test";
import pg from "pg";
import { serve } from "../../src/wire/index.ts";

test("wire transaction defers constraint triggers until final commit (#432)", async () => {
  const server = await serve({ port: 0 });
  const client = new pg.Client({ connectionString: `postgres://postgres@${server.host}:${server.port}/postgres` });
  await client.connect();
  try {
    await client.query("CREATE TABLE entries(id int)");
    await client.query(
      "CREATE FUNCTION check_entries() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM entries WHERE id < 0) THEN RAISE EXCEPTION 'invalid entries'; END IF; RETURN NEW; END $$",
    );
    await client.query(
      "CREATE CONSTRAINT TRIGGER validate_entry AFTER INSERT OR UPDATE OR DELETE ON entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entries()",
    );
    await client.query("BEGIN");
    await client.query("INSERT INTO entries VALUES (-1)");
    await client.query("UPDATE entries SET id = 1");
    await client.query("COMMIT");
    expect((await client.query("SELECT * FROM entries")).rows).toEqual([{ id: 1 }]);
    await client.query("BEGIN");
    await client.query("INSERT INTO entries VALUES (-2)");
    await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "P0001" });
    expect((await client.query("SELECT * FROM entries")).rows).toEqual([{ id: 1 }]);
    await client.query("BEGIN");
    await client.query("INSERT INTO entries VALUES (-3)");
    await expect(client.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toMatchObject({ code: "P0001" });
    await client.query("ROLLBACK");
  } finally {
    await client.end();
    await server.close();
  }
});
