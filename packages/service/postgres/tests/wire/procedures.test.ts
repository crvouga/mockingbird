import { afterAll, beforeAll, expect, test } from "bun:test";
import pg from "pg";
import { splitStatements } from "../../src/wire/split.ts";
import { type PostgresServer, serve } from "../../src/wire/index.ts";

let server: PostgresServer;

beforeAll(async () => {
  server = await serve({ port: 0 });
});

afterAll(async () => {
  await server.close();
});

const connect = async (): Promise<pg.Client> => {
  const client = new pg.Client({ connectionString: `postgres://postgres@${server.host}:${server.port}/postgres` });
  await client.connect();
  return client;
};

// #682: the issue's reproduction, over the wire
test("BEGIN ATOMIC bodies, CREATE PROCEDURE and CALL over the wire", async () => {
  const client = await connect();
  try {
    await client.query("CREATE TABLE c (a int)");
    await client.query("INSERT INTO c VALUES (4), (5)");
    await client.query("CREATE FUNCTION f9(a int) RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT a + 1; END");
    expect((await client.query("SELECT f9(1) AS begin_atomic")).rows).toEqual([{ begin_atomic: 2 }]);
    await client.query("CREATE PROCEDURE p1(n int) LANGUAGE plpgsql AS $$ BEGIN INSERT INTO c VALUES (n); END $$");
    expect((await client.query("CALL p1(9)")).command).toBe("CALL");
    expect((await client.query("SELECT count(*)::int AS rows FROM c")).rows).toEqual([{ rows: 3 }]);
    await client.query("CREATE PROCEDURE p2(INOUT x int) LANGUAGE plpgsql AS $$ BEGIN x := x * 2; END $$");
    expect((await client.query("CALL p2(21)")).rows).toEqual([{ x: 42 }]);
    // a simple-query script whose BEGIN ATOMIC body holds semicolons
    await client.query(
      "CREATE FUNCTION f10(a int) RETURNS int LANGUAGE sql BEGIN ATOMIC INSERT INTO c VALUES (a); SELECT CASE WHEN a > 0 THEN a ELSE 0 END; END; SELECT 1",
    );
    expect((await client.query("SELECT f10(3) AS v")).rows).toEqual([{ v: 3 }]);
  } finally {
    await client.end();
  }
});

test("a procedure's COMMIT over the wire keeps what it committed when it fails later", async () => {
  const client = await connect();
  try {
    await client.query("CREATE TABLE tc_log (a int)");
    await client.query(
      "CREATE PROCEDURE tc() LANGUAGE plpgsql AS $$ BEGIN INSERT INTO tc_log VALUES (1); COMMIT; INSERT INTO tc_log VALUES (2); ROLLBACK; INSERT INTO tc_log VALUES (3); COMMIT; INSERT INTO tc_log VALUES (4); RAISE EXCEPTION 'boom'; END $$",
    );
    await expect(client.query("CALL tc()")).rejects.toMatchObject({ code: "P0001" });
    expect((await client.query("SELECT a FROM tc_log ORDER BY a")).rows).toEqual([{ a: 1 }, { a: 3 }]);
    await client.query("BEGIN");
    await expect(client.query("CALL tc()")).rejects.toMatchObject({ code: "2D000" });
    await client.query("ROLLBACK");
    expect((await client.query("SELECT count(*)::int AS n FROM tc_log")).rows).toEqual([{ n: 2 }]);
  } finally {
    await client.end();
  }
});

test("the wire splitter keeps a BEGIN ATOMIC body (with CASE ... END) in one statement", () => {
  expect(
    splitStatements(
      "CREATE OR REPLACE PROCEDURE p() LANGUAGE sql BEGIN ATOMIC SELECT CASE WHEN true THEN 1 END; SELECT 2; END; BEGIN; SELECT 3; END;",
    ),
  ).toEqual([
    "CREATE OR REPLACE PROCEDURE p() LANGUAGE sql BEGIN ATOMIC SELECT CASE WHEN true THEN 1 END; SELECT 2; END",
    "BEGIN",
    "SELECT 3",
    "END",
  ]);
  expect(splitStatements("SELECT E'a;b'; SELECT 'end'; SELECT 1")).toEqual([
    "SELECT E'a;b'",
    "SELECT 'end'",
    "SELECT 1",
  ]);
});
