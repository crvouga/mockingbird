import { describe, expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { InMemoryAdapter } from "../../adapters/in-memory.ts";
import { expectParity } from "../../harness/assert.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { setupBoth } from "../helpers.ts";

matrixBoth("multi-statement exec runs DDL and DML together", async (memory, postgres) => {
  const script = `
    CREATE TABLE users (id serial PRIMARY KEY, name text);
    INSERT INTO users (name) VALUES ('Ada');
    INSERT INTO users (name) VALUES ('Bob');
  `;
  expect((await memory.exec(script)).ok).toBe(true);
  expect((await postgres.exec(script)).ok).toBe(true);
  expectParity(
    await memory.query("SELECT id, name FROM users ORDER BY id"),
    await postgres.query("SELECT id, name FROM users ORDER BY id"),
  );
});

matrixBoth("prepare bind run all get reuse a statement", async (memory, postgres) => {
  await setupBoth(memory, postgres, [
    "CREATE TABLE t (id serial PRIMARY KEY, name text)",
    "INSERT INTO t (name) VALUES ('a'), ('b'), ('c')",
  ]);
  expectParity(
    await memory.query("SELECT id, name FROM t WHERE id = $1", [2]),
    await postgres.query("SELECT id, name FROM t WHERE id = $1", [2]),
  );
  expectParity(
    await memory.query("SELECT id, name FROM t WHERE id = $1", [1]),
    await postgres.query("SELECT id, name FROM t WHERE id = $1", [1]),
  );
  expectParity(
    await memory.exec("INSERT INTO t (name) VALUES ($1)", ["d"]),
    await postgres.exec("INSERT INTO t (name) VALUES ($1)", ["d"]),
  );
  expectParity(
    await memory.query("SELECT name FROM t ORDER BY id"),
    await postgres.query("SELECT name FROM t ORDER BY id"),
  );
});

matrixBoth("transaction commits successful work", async (memory, postgres) => {
  await setupBoth(memory, postgres, [
    "CREATE TABLE t (id serial PRIMARY KEY, name text)",
    "BEGIN",
    "INSERT INTO t (name) VALUES ('ok')",
    "COMMIT",
  ]);
  expectParity(await memory.query("SELECT name FROM t"), await postgres.query("SELECT name FROM t"));
});

matrixBoth("explicit ROLLBACK discards work", async (memory, postgres) => {
  await setupBoth(memory, postgres, [
    "CREATE TABLE t (id serial PRIMARY KEY, name text)",
    "INSERT INTO t (name) VALUES ('seed')",
    "BEGIN",
    "INSERT INTO t (name) VALUES ('x')",
    "ROLLBACK",
  ]);
  expectParity(
    await memory.query("SELECT name FROM t ORDER BY id"),
    await postgres.query("SELECT name FROM t ORDER BY id"),
  );
});

describe("api memory-only", () => {
  test("run reports rowCount and command tag", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (id serial PRIMARY KEY, name text)");
    const ins = db.prepare("INSERT INTO t (name) VALUES ($1), ($2)").run("a", "b");
    expect(ins).toEqual({ rowCount: 2, command: "INSERT" });
    const upd = db.prepare("UPDATE t SET name = 'z' WHERE id = 1").run();
    expect(upd).toEqual({ rowCount: 1, command: "UPDATE" });
    expect(db.changes).toBe(1);
    const del = db.prepare("DELETE FROM t").run();
    expect(del).toEqual({ rowCount: 2, command: "DELETE" });
  });

  test("statement.get returns first row or undefined", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (id int)");
    db.exec("INSERT INTO t VALUES (1), (2)");
    const stmt = db.prepare("SELECT id FROM t WHERE id = $1");
    expect(stmt.get(2)).toEqual({ id: 2 });
    expect(stmt.get(99)).toBeUndefined();
  });

  test("statement.result exposes column metadata for zero-row results", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (id int4, name text)");
    const res = db.prepare("SELECT id, name FROM t").result();
    expect(res.columns).toEqual(["id", "name"]);
    expect(res.columnTypes).toEqual(["int4", "text"]);
    expect(res.rows).toEqual([]);
    expect(res.command).toBe("SELECT");
  });

  test("statement.textResult renders canonical PostgreSQL text", () => {
    const db = new Database();
    const res = db.prepare("SELECT 1.50::numeric(10,2) AS n, true AS b, NULL::int AS z, ARRAY[1, 2] AS a").textResult();
    expect(res.rows).toEqual([["1.50", "t", null, "{1,2}"]]);
  });

  test("now() uses the fixed default clock and injectable clock", () => {
    const fixed = new Database();
    expect(fixed.query<{ d: string }>("SELECT current_date::text AS d")[0]).toEqual({ d: "2000-01-01" });
    const injected = new Database({ now: new Date("2012-06-15T12:34:56.000Z") });
    expect(injected.query<{ ts: string }>("SELECT localtimestamp::text AS ts")[0]).toEqual({
      ts: "2012-06-15 12:34:56",
    });
  });

  test("transaction() commits on success and rolls back on throw", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (id serial PRIMARY KEY, name text)");
    db.transaction(() => {
      db.exec("INSERT INTO t (name) VALUES ('ok')");
    });
    expect(() =>
      db.transaction(() => {
        db.exec("INSERT INTO t (name) VALUES ('x')");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.query("SELECT name FROM t ORDER BY id")).toEqual([{ name: "ok" }]);
  });

  test("nested transaction() uses savepoints", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (id serial PRIMARY KEY, name text)");
    db.transaction(() => {
      db.exec("INSERT INTO t (name) VALUES ('outer')");
      expect(() =>
        db.transaction(() => {
          db.exec("INSERT INTO t (name) VALUES ('inner')");
          throw new Error("inner boom");
        }),
      ).toThrow("inner boom");
    });
    expect(db.query("SELECT name FROM t ORDER BY id")).toEqual([{ name: "outer" }]);
  });
});

describe("closed database", () => {
  test("rejects operations after close", async () => {
    const db = new InMemoryAdapter();
    await db.close();
    const res = await db.exec("SELECT 1");
    expect(res.ok).toBe(false);
    expect(res.error?.category).toBe("misuse");
  });
});
