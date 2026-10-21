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

// #529: the wire layer's row-lock probe dropped the FROM / USING items, so a WHERE naming them failed with 42703
describe("UPDATE ... FROM and DELETE ... USING over the wire", () => {
  test("the row-lock probe keeps the FROM / USING items", () => {
    expect(lockedMutationQuery("UPDATE a SET v = b.v FROM b WHERE a.id = b.id")).toBe(
      "SELECT a.* FROM a, b WHERE a.id = b.id",
    );
    expect(
      lockedMutationQuery(
        "UPDATE s.m x SET n = sub.n FROM (SELECT DISTINCT ON (k) k, n FROM s.p WHERE st IN ('A', 'B') ORDER BY k) sub WHERE x.id = sub.k RETURNING x.id;",
      ),
    ).toBe(
      "SELECT x.* FROM s.m AS x, (SELECT DISTINCT ON (k) k, n FROM s.p WHERE st IN ('A', 'B') ORDER BY k) sub WHERE x.id = sub.k",
    );
    expect(lockedMutationQuery("DELETE FROM a AS t USING b WHERE t.id = b.id RETURNING t.id")).toBe(
      "SELECT t.* FROM a AS t, b WHERE t.id = b.id",
    );
    // unchanged shapes
    expect(lockedMutationQuery("UPDATE t AS ap SET v = 1 WHERE ap.id = $1")).toBe(
      "SELECT * FROM t AS ap WHERE ap.id = $1",
    );
    expect(lockedMutationQuery("DELETE FROM t")).toBe("SELECT * FROM t");
    // `IS DISTINCT FROM` in the SET list is not a FROM clause
    expect(lockedMutationQuery("UPDATE t SET v = CASE WHEN a IS DISTINCT FROM b THEN 1 ELSE 2 END WHERE id = 1")).toBe(
      "SELECT * FROM t WHERE id = 1",
    );
    expect(lockedMutationQuery("SELECT 1")).toBeNull();
  });

  test("the reported statements run", async () => {
    const client = await connect();
    try {
      await client.query("CREATE TABLE uf_a (id int PRIMARY KEY, v int)");
      await client.query("CREATE TABLE uf_b (id int PRIMARY KEY, v int)");
      await client.query("INSERT INTO uf_a VALUES (1, NULL), (2, NULL)");
      await client.query("INSERT INTO uf_b VALUES (1, 10), (2, 20)");
      expect((await client.query("UPDATE uf_a SET v = uf_b.v FROM uf_b WHERE uf_a.id = uf_b.id")).rowCount).toBe(2);
      expect(
        (await client.query("UPDATE uf_a SET v = s.v + 1 FROM (SELECT id, v FROM uf_b) s WHERE s.id = uf_a.id"))
          .rowCount,
      ).toBe(2);
      expect((await client.query("SELECT id, v FROM uf_a ORDER BY id")).rows).toEqual([
        { id: 1, v: 11 },
        { id: 2, v: 21 },
      ]);
      expect((await client.query("UPDATE uf_a SET v = 0 FROM uf_b WHERE uf_a.id = 1")).rowCount).toBe(1);
      expect(
        (
          await client.query(
            "UPDATE uf_a AS x SET v = sub.v FROM (SELECT DISTINCT ON (id) id, v FROM uf_b WHERE v > $1 ORDER BY id, v DESC) sub WHERE x.id = sub.id RETURNING x.id",
            [5],
          )
        ).rows,
      ).toEqual([{ id: 1 }, { id: 2 }]);
      expect((await client.query("DELETE FROM uf_a USING uf_b WHERE uf_a.id = uf_b.id AND uf_b.v = 20")).rowCount).toBe(
        1,
      );
      expect((await client.query("SELECT id, v FROM uf_a ORDER BY id")).rows).toEqual([{ id: 1, v: 10 }]);
    } finally {
      await client.end();
    }
  });

  test("UPDATE ... FROM still takes the row locks of the rows it writes", async () => {
    const a = await connect();
    const b = await connect();
    try {
      await a.query("CREATE TABLE uf_lock (id int PRIMARY KEY, v int)");
      await a.query("CREATE TABLE uf_src (id int PRIMARY KEY, v int)");
      await a.query("INSERT INTO uf_lock VALUES (1, 0)");
      await a.query("INSERT INTO uf_src VALUES (1, 5)");
      await a.query("BEGIN");
      await a.query("UPDATE uf_lock SET v = uf_src.v FROM uf_src WHERE uf_lock.id = uf_src.id");
      let settled = false;
      const waiting = b.query("UPDATE uf_lock SET v = v + 1 WHERE id = 1").then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);
      await a.query("COMMIT");
      await waiting;
      expect((await b.query("SELECT v FROM uf_lock")).rows).toEqual([{ v: 6 }]);
    } finally {
      await a.end();
      await b.end();
    }
  });
});

// #530: the locking clause may precede LIMIT; the limit counts rows that were not skipped as locked
describe("FOR UPDATE SKIP LOCKED followed by LIMIT over the wire", () => {
  test("the claim-one-row idiom returns the first unlocked row", async () => {
    const a = await connect();
    const b = await connect();
    try {
      await a.query("CREATE TABLE claim_q (id int PRIMARY KEY, status text)");
      await a.query("INSERT INTO claim_q VALUES (1, 'pending'), (2, 'pending'), (3, 'done')");
      await a.query("BEGIN");
      expect(
        (await a.query("SELECT id FROM claim_q WHERE status = 'pending' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1"))
          .rows,
      ).toEqual([{ id: 1 }]);
      expect(
        (await b.query("SELECT id FROM claim_q WHERE status = 'pending' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1"))
          .rows,
      ).toEqual([{ id: 2 }]);
      expect(
        (await b.query("SELECT id FROM claim_q WHERE status = 'pending' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1"))
          .rows,
      ).toEqual([{ id: 2 }]);
      await a.query("ROLLBACK");
    } finally {
      await a.end();
      await b.end();
    }
  });
});
