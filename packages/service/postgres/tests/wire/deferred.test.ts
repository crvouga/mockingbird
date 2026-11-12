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

test("wire transaction checks deferred foreign keys at commit (#683)", async () => {
  const server = await serve({ port: 0 });
  const client = new pg.Client({ connectionString: `postgres://postgres@${server.host}:${server.port}/postgres` });
  await client.connect();
  try {
    await client.query("CREATE TABLE parent (id int PRIMARY KEY)");
    await client.query("CREATE TABLE child (pid int REFERENCES parent (id) DEFERRABLE INITIALLY DEFERRED)");
    await client.query("BEGIN");
    await client.query("INSERT INTO child VALUES (1)");
    await client.query("INSERT INTO parent VALUES (1)");
    await client.query("COMMIT");
    expect((await client.query("SELECT count(*)::int AS children FROM child")).rows).toEqual([{ children: 1 }]);

    await client.query("CREATE TABLE child2 (pid int REFERENCES parent (id) DEFERRABLE INITIALLY IMMEDIATE)");
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query("INSERT INTO child2 VALUES (2)");
    await client.query("INSERT INTO parent VALUES (2)");
    await client.query("COMMIT");
    expect((await client.query("SELECT count(*)::int AS children FROM child2")).rows).toEqual([{ children: 1 }]);

    await client.query("BEGIN");
    await client.query("INSERT INTO child VALUES (3)");
    await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23503" });
    expect((await client.query("SELECT count(*)::int AS children FROM child")).rows).toEqual([{ children: 1 }]);
  } finally {
    await client.end();
    await server.close();
  }
});
