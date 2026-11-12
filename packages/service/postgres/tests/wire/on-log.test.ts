import { expect, test } from "bun:test";
import pg from "pg";
import { type ServerLog, serve } from "../../src/wire/index.ts";

const connect = async (options: { logParams?: boolean } = {}) => {
  const entries: ServerLog[] = [];
  const server = await serve({ port: 0, onLog: (entry) => entries.push(entry), ...options });
  const client = new pg.Client({ connectionString: `postgres://postgres@${server.host}:${server.port}/postgres` });
  await client.connect();
  const failure = (sql: string, params?: unknown[]) =>
    client.query(sql, params).then(
      () => {
        throw new Error(`expected ${sql} to fail`);
      },
      (error: { code: string; message: string }) => ({ code: error.code, message: error.message }),
    );
  const close = async () => {
    await client.end();
    await server.close();
  };
  const strip = () => entries.map(({ durationMs, pid, ...entry }) => entry);
  return { client, entries, failure, close, strip };
};

test("onLog reports a statement rejected at Parse with its message (#694)", async () => {
  const { client, failure, close, strip } = await connect();
  try {
    await client.query("CREATE TABLE t (x int, y int)");
    const syntax = await failure("SELECT FROM WHERE", [0]);
    const missing = await failure("SELECT nope()");
    const logged = strip();
    expect(logged).toContainEqual({
      sql: "SELECT FROM WHERE",
      status: syntax.code,
      phase: "parse",
      message: syntax.message,
    });
    // The extended-protocol failure is reported once, at the step the client saw fail.
    expect(logged.filter((entry) => entry.sql === "SELECT FROM WHERE")).toHaveLength(1);
    expect(logged).toContainEqual(
      expect.objectContaining({ sql: "SELECT nope()", status: missing.code, message: missing.message }),
    );
    expect(logged.filter((entry) => entry.sql === "SELECT nope()")).toHaveLength(1);
  } finally {
    await close();
  }
});

test("onLog carries the client's error message for Execute and simple-query failures (#694)", async () => {
  const { client, failure, close, strip } = await connect();
  try {
    await client.query("CREATE TABLE t (x int PRIMARY KEY)");
    await client.query("INSERT INTO t VALUES (1)");
    const duplicate = await failure("INSERT INTO t VALUES ($1)", [1]);
    const simple = await failure("INSERT INTO t VALUES (1)");
    const logged = strip();
    expect(duplicate.code).toBe("23505");
    expect(logged).toContainEqual({
      sql: "INSERT INTO t VALUES ($1)",
      status: "23505",
      phase: "describe",
      message: duplicate.message,
    });
    expect(logged).toContainEqual({
      sql: "INSERT INTO t VALUES (1)",
      status: "23505",
      phase: "simple",
      message: simple.message,
    });
  } finally {
    await close();
  }
});

test("onLog reports rowCount on success and parameters only when asked (#694)", async () => {
  const quiet = await connect();
  try {
    await quiet.client.query("CREATE TABLE t (x int)");
    await quiet.client.query("INSERT INTO t VALUES ($1), ($2)", [1, 2]);
    await quiet.client.query("SELECT x FROM t WHERE x > $1", [0]);
    const logged = quiet.strip();
    expect(logged).toContainEqual({ sql: "CREATE TABLE t (x int)", status: "ok", phase: "simple", rowCount: 0 });
    expect(logged).toContainEqual(
      expect.objectContaining({ sql: "INSERT INTO t VALUES ($1), ($2)", status: "ok", rowCount: 2 }),
    );
    expect(logged).toContainEqual(
      expect.objectContaining({ sql: "SELECT x FROM t WHERE x > $1", status: "ok", rowCount: 2 }),
    );
    expect(logged.some((entry) => "params" in entry)).toBe(false);
  } finally {
    await quiet.close();
  }

  const verbose = await connect({ logParams: true });
  try {
    await verbose.client.query("CREATE TABLE t (x int)");
    await verbose.client.query("SELECT $1::int + $2::int AS sum", [1, 2]);
    const failed = await verbose.failure("SELECT 'a' LIKE ANY NOPE ($1::text[])", [["a%"]]);
    const logged = verbose.strip();
    expect(logged).toContainEqual(
      expect.objectContaining({ sql: "SELECT $1::int + $2::int AS sum", status: "ok", params: ["1", "2"] }),
    );
    expect(logged).toContainEqual(
      expect.objectContaining({ phase: "parse", status: failed.code, message: failed.message, params: [] }),
    );
    expect(logged.find((entry) => entry.sql === "CREATE TABLE t (x int)")).not.toHaveProperty("params");
  } finally {
    await verbose.close();
  }
});
