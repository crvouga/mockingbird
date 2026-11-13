import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import pg from "pg";
import { type PostgresServer, serve } from "../../src/wire/index.ts";
import { lockedMutationQuery } from "../../src/wire/lock-probe.ts";

let server: PostgresServer;

const connect = async (): Promise<pg.Client> => {
  const client = new pg.Client({ connectionString: `postgres://postgres@${server.host}:${server.port}/postgres` });
  await client.connect();
  return client;
};

beforeAll(async () => {
  server = await serve({ port: 0 });
});

afterAll(async () => {
  await server.close();
});

// #726: a NO SCROLL cursor walked with FETCH inside a transaction (0A000 on an older release)
describe("DECLARE ... NO SCROLL CURSOR / FETCH / MOVE / CLOSE over the wire", () => {
  test("FETCH n, FETCH FORWARD n, MOVE, FETCH ALL and CLOSE", async () => {
    const client = await connect();
    try {
      await client.query("CREATE TABLE cur726 AS SELECT g AS id FROM generate_series(1, 250) g");
      await client.query("BEGIN");
      await client.query("DECLARE c NO SCROLL CURSOR FOR SELECT id FROM cur726 ORDER BY id");
      const first = await client.query("FETCH 100 FROM c");
      expect(first.rows.length).toBe(100);
      expect(first.rows[0]).toEqual({ id: 1 });
      expect(first.rows[99]).toEqual({ id: 100 });
      const forward = await client.query("FETCH FORWARD 3 FROM c");
      expect(forward.rows.map((r) => r.id)).toEqual([101, 102, 103]);
      const moved = await client.query("MOVE 50 IN c");
      expect(moved.command).toBe("MOVE");
      expect(moved.rowCount).toBe(50);
      const rest = await client.query("FETCH ALL FROM c");
      expect(rest.rows.length).toBe(97);
      expect(rest.rows[0]).toEqual({ id: 154 });
      expect((await client.query("FETCH 100 FROM c")).rows).toEqual([]);
      await client.query("CLOSE c");
      await client.query("COMMIT");
    } finally {
      await client.end();
    }
  });

  test("a streaming loop of FETCH 100 reads 1000 rows in order", async () => {
    const client = await connect();
    try {
      await client.query(
        "CREATE TABLE stream726 AS SELECT g AS id, 'row ' || g AS label FROM generate_series(1, 1000) g",
      );
      await client.query("BEGIN");
      await client.query("DECLARE s NO SCROLL CURSOR FOR SELECT id, label FROM stream726 ORDER BY id");
      const seen: number[] = [];
      let batches = 0;
      for (;;) {
        const batch = await client.query("FETCH 100 FROM s");
        if (batch.rows.length === 0) break;
        batches++;
        for (const row of batch.rows) seen.push(row.id);
      }
      await client.query("CLOSE s");
      await client.query("COMMIT");
      expect(batches).toBe(10);
      expect(seen.length).toBe(1000);
      expect(seen.every((id, i) => id === i + 1)).toBe(true);
    } finally {
      await client.end();
    }
  });
});

// #726: CREATE TEMP TABLE ... ON COMMIT DROP AS SELECT
describe("CREATE TEMP TABLE ... ON COMMIT DROP AS over the wire", () => {
  test("the table is readable in the transaction and gone after COMMIT", async () => {
    const client = await connect();
    try {
      await client.query("BEGIN");
      await client.query("CREATE TEMP TABLE x726 ON COMMIT DROP AS SELECT 1 AS a");
      expect((await client.query("SELECT * FROM x726")).rows).toEqual([{ a: 1 }]);
      await client.query("COMMIT");
      const left = await client.query("SELECT count(*)::int AS n FROM pg_class WHERE relname = 'x726'");
      expect(left.rows).toEqual([{ n: 0 }]);
    } finally {
      await client.end();
    }
  });
});

// #728: RETURNING reads the FROM / USING tables (the row-lock probe only looks at the target)
describe("UPDATE ... FROM / DELETE ... USING RETURNING over the wire", () => {
  test("the lock probe ignores RETURNING", () => {
    expect(lockedMutationQuery("UPDATE c SET v = 'q' FROM t WHERE t.id = c.tid RETURNING t.name, c.id")).toBe(
      "SELECT c.* FROM c, t WHERE t.id = c.tid",
    );
  });

  test("RETURNING t.name, c.id and t.name, c.*", async () => {
    const client = await connect();
    try {
      await client.query("CREATE TABLE t728 (id int, name text)");
      await client.query("CREATE TABLE c728 (id int, tid int, v text)");
      await client.query("INSERT INTO t728 VALUES (1, 'a'), (2, 'b')");
      await client.query("INSERT INTO c728 VALUES (10, 1, 'z'), (11, 2, 'y'), (12, 3, 'x')");
      const updated = await client.query(
        "UPDATE c728 SET v = 'q' FROM t728 WHERE t728.id = c728.tid RETURNING t728.name, c728.id",
      );
      expect(updated.rows).toEqual([
        { name: "a", id: 10 },
        { name: "b", id: 11 },
      ]);
      await client.query("BEGIN");
      const deleted = await client.query(
        "DELETE FROM c728 USING t728 WHERE t728.id = c728.tid AND t728.id = 1 RETURNING t728.name, c728.*",
      );
      expect(deleted.rows).toEqual([{ name: "a", id: 10, tid: 1, v: "q" }]);
      await client.query("COMMIT");
    } finally {
      await client.end();
    }
  });
});
