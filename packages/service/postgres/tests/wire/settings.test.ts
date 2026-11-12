import { expect, test } from "bun:test";
import pg from "pg";
import { Database } from "../../src/index.ts";
import { serve } from "../../src/wire/index.ts";

const outcome = async (client: pg.Client, sql: string): Promise<unknown> => {
  try {
    return (await client.query(sql)).rows;
  } catch (error) {
    return `ERROR ${(error as { code?: string }).code}: ${(error as Error).message}`;
  }
};

// #677: the expected answers are what PostgreSQL 18 (PGlite) gives to the same statements
test("#677 READ ONLY transactions refuse writes over the wire, and the read-only settings exist", async () => {
  const server = await serve({ database: new Database() });
  const client = new pg.Client({ connectionString: server.connectionString });
  await client.connect();
  try {
    const run = (sql: string) => outcome(client, sql);
    await run("CREATE TABLE t (x int)");
    expect(await run("SHOW transaction_read_only")).toEqual([{ transaction_read_only: "off" }]);
    expect(await run("SELECT current_setting('transaction_read_only') AS v")).toEqual([{ v: "off" }]);
    expect(await run("SHOW default_transaction_read_only")).toEqual([{ default_transaction_read_only: "off" }]);
    expect(await run("SET default_transaction_read_only = off")).toEqual([]);
    expect(
      await run(
        "SELECT pg_is_in_recovery() AS in_recovery, current_setting('transaction_read_only') AS transaction_read_only",
      ),
    ).toEqual([{ in_recovery: false, transaction_read_only: "off" }]);

    expect(await run("BEGIN TRANSACTION READ ONLY")).toEqual([]);
    expect(await run("SHOW transaction_read_only")).toEqual([{ transaction_read_only: "on" }]);
    expect(await run("INSERT INTO t VALUES (1)")).toBe("ERROR 25006: cannot execute INSERT in a read-only transaction");
    await run("COMMIT");

    await run("BEGIN");
    expect(await run("SET TRANSACTION READ ONLY")).toEqual([]);
    expect(await run("INSERT INTO t VALUES (2)")).toBe("ERROR 25006: cannot execute INSERT in a read-only transaction");
    await run("COMMIT");

    await run("BEGIN");
    expect(await run("SET LOCAL transaction_read_only = on")).toEqual([]);
    expect(await run("UPDATE t SET x = 3")).toBe("ERROR 25006: cannot execute UPDATE in a read-only transaction");
    await run("ROLLBACK");

    // a temporary table stays writable in a read-only transaction
    await run("CREATE TEMP TABLE scratch (x int)");
    await run("BEGIN READ ONLY");
    expect(await run("INSERT INTO scratch VALUES (1)")).toEqual([]);
    expect(await run("SELECT count(*)::int AS n FROM scratch")).toEqual([{ n: 1 }]);
    await run("COMMIT");
    expect(await run("SELECT count(*)::int AS n FROM scratch")).toEqual([{ n: 1 }]);

    // the session default makes every transaction read-only, including single statements
    await run("SET default_transaction_read_only = on");
    expect(await run("INSERT INTO t VALUES (4)")).toBe("ERROR 25006: cannot execute INSERT in a read-only transaction");
    await run("BEGIN READ WRITE");
    expect(await run("INSERT INTO t VALUES (5)")).toEqual([]);
    await run("COMMIT");
    await run("RESET default_transaction_read_only");

    expect(await run("SELECT x FROM t ORDER BY x")).toEqual([{ x: 5 }]);
  } finally {
    await client.end();
    await server.close();
  }
});

test("#678 run-time parameters are accepted at connection start and reported in pg_settings", async () => {
  const server = await serve({ database: new Database() });
  const client = new pg.Client({
    connectionString: server.connectionString,
    options: "-c work_mem=8MB -c jit=off",
  });
  await client.connect();
  try {
    const run = (sql: string) => outcome(client, sql);
    expect(await run("SHOW work_mem")).toEqual([{ work_mem: "8MB" }]);
    expect(await run("SELECT setting, unit, source FROM pg_settings WHERE name = 'work_mem'")).toEqual([
      { setting: "8192", unit: "kB", source: "client" },
    ]);
    expect(await run("SET work_mem = '16MB'")).toEqual([]);
    expect(await run("RESET work_mem")).toEqual([]);
    expect(await run("SHOW work_mem")).toEqual([{ work_mem: "8MB" }]);
    expect(await run("SELECT setting FROM pg_settings WHERE name = 'max_connections'")).toEqual([{ setting: "100" }]);
  } finally {
    await client.end();
    await server.close();
  }
});

test("#678 a parameter fixed at server start is refused at connection start", async () => {
  const server = await serve({ database: new Database() });
  const client = new pg.Client({ connectionString: server.connectionString, options: "-c max_connections=5" });
  try {
    await expect(client.connect()).rejects.toThrow(
      'parameter "max_connections" cannot be changed without restarting the server',
    );
  } finally {
    await client.end().catch(() => {});
    await server.close();
  }
});
