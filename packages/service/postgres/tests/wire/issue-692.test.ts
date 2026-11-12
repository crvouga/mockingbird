import { afterAll, beforeAll, expect, test } from "bun:test";
import pg from "pg";
import { type PostgresServer, serve } from "../../src/wire/index.ts";

// #692 over the wire: cursors (per session, with WITH HOLD across commits), SET ROLE with row-level
// security per connection, and partitioned tables.

let server: PostgresServer;

beforeAll(async () => {
  server = await serve({ port: 0 });
});

afterAll(async () => {
  await server.close();
});

async function connect(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: `postgres://postgres@${server.host}:${server.port}/postgres` });
  await client.connect();
  return client;
}

test("DECLARE / FETCH / MOVE / CLOSE in a transaction block", async () => {
  const client = await connect();
  try {
    await client.query("BEGIN");
    await client.query("DECLARE cur CURSOR FOR SELECT generate_series(1, 5) AS n");
    const first = await client.query("FETCH 2 FROM cur");
    expect(first.command).toBe("FETCH");
    expect(first.rowCount).toBe(2);
    expect(first.rows).toEqual([{ n: 1 }, { n: 2 }]);
    expect((await client.query("MOVE 1 FROM cur")).command).toBe("MOVE");
    expect((await client.query("FETCH ALL FROM cur")).rows).toEqual([{ n: 4 }, { n: 5 }]);
    // the extended protocol too (a parameterized FETCH is not possible; a named statement is)
    expect((await client.query({ text: "FETCH ALL FROM cur", name: "f" })).rows).toEqual([]);
    expect((await client.query("SELECT name FROM pg_cursors")).rows).toEqual([{ name: "cur" }]);
    await client.query("CLOSE cur");
    await client.query("COMMIT");
  } finally {
    await client.end();
  }
});

test("DECLARE outside a transaction block is 25P01; WITH HOLD cursors belong to their session", async () => {
  const a = await connect();
  const b = await connect();
  try {
    await expect(a.query("DECLARE c CURSOR FOR SELECT 1")).rejects.toMatchObject({ code: "25P01" });
    await a.query("DECLARE h CURSOR WITH HOLD FOR SELECT g FROM generate_series(1, 3) g");
    expect((await a.query("FETCH 1 FROM h")).rows).toEqual([{ g: 1 }]);
    await expect(b.query("FETCH 1 FROM h")).rejects.toMatchObject({ code: "34000" });
    // a held cursor keeps its position across later transactions of the session
    await a.query("BEGIN");
    expect((await a.query("FETCH 1 FROM h")).rows).toEqual([{ g: 2 }]);
    await a.query("COMMIT");
    expect((await a.query("FETCH 1 FROM h")).rows).toEqual([{ g: 3 }]);
    await a.query("BEGIN");
    await a.query("DECLARE h2 CURSOR WITH HOLD FOR SELECT 'x' AS v");
    await a.query("COMMIT");
    expect((await a.query("FETCH ALL FROM h2")).rows).toEqual([{ v: "x" }]);
    await a.query("CLOSE ALL");
  } finally {
    await a.end();
    await b.end();
  }
});

test("SET ROLE and row-level security are per connection", async () => {
  const admin = await connect();
  const app = await connect();
  try {
    await admin.query("CREATE TABLE notes (owner text, body text)");
    await admin.query("INSERT INTO notes VALUES ('alice', 'a1'), ('bob', 'b1')");
    await admin.query("CREATE ROLE alice");
    await admin.query("GRANT SELECT ON notes TO alice");
    await admin.query("ALTER TABLE notes ENABLE ROW LEVEL SECURITY");
    await admin.query("CREATE POLICY mine ON notes USING (owner = current_user)");
    await app.query("SET ROLE alice");
    expect((await app.query("SELECT current_user AS u, body FROM notes")).rows).toEqual([{ u: "alice", body: "a1" }]);
    expect((await admin.query("SELECT current_user AS u, count(*)::int AS n FROM notes")).rows).toEqual([
      { u: "postgres", n: 2 },
    ]);
    await app.query("RESET ROLE");
    expect((await app.query("SELECT count(*)::int AS n FROM notes")).rows).toEqual([{ n: 2 }]);
  } finally {
    await admin.end();
    await app.end();
  }
});

test("partitioned tables, composite types and JSON_TABLE over the wire", async () => {
  const client = await connect();
  try {
    await client.query("CREATE TABLE m (d date, v int) PARTITION BY RANGE (d)");
    await client.query("CREATE TABLE m1 PARTITION OF m FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')");
    await client.query("INSERT INTO m VALUES ($1, $2)", ["2024-06-01", 7]);
    expect((await client.query("SELECT tableoid::regclass::text AS part, v FROM m")).rows).toEqual([
      { part: "m1", v: 7 },
    ]);
    await client.query("CREATE TYPE pair AS (a int, b text)");
    expect((await client.query("SELECT ROW(1, 'x')::pair::text AS p")).rows).toEqual([{ p: "(1,x)" }]);
    const jt = await client.query(
      `SELECT * FROM JSON_TABLE('[{"a":1},{"a":2}]'::jsonb, '$[*]' COLUMNS (a int PATH '$.a')) jt`,
    );
    expect(jt.rows).toEqual([{ a: 1 }, { a: 2 }]);
  } finally {
    await client.end();
  }
});
