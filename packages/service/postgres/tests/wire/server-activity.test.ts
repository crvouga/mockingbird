import { expect, test } from "bun:test";
import pg from "pg";
import { Database } from "../../src/index.ts";
import { serve } from "../../src/wire/index.ts";

const outcome = async (client: pg.Client, sql: string, params: unknown[] = []): Promise<unknown> => {
  try {
    return (await client.query(sql, params)).rows;
  } catch (error) {
    return `ERROR ${(error as { code?: string }).code}: ${(error as Error).message}`;
  }
};

// #690: the expected answers for one session are what PostgreSQL 18 gives
test("#690 server-activity functions answer for the wire server's sessions", async () => {
  const server = await serve({ database: new Database() });
  const a = new pg.Client({ connectionString: server.connectionString, application_name: "first" });
  const b = new pg.Client({ connectionString: server.connectionString, application_name: "second" });
  await a.connect();
  await b.connect();
  b.on("error", () => {});
  try {
    expect(await outcome(a, "SELECT cardinality(pg_blocking_pids(pg_backend_pid())) AS blockers")).toEqual([
      { blockers: 0 },
    ]);
    expect(await outcome(a, "SELECT pg_cancel_backend(999999) AS cancelled")).toEqual([{ cancelled: false }]);
    expect(await outcome(a, "SELECT pg_terminate_backend(999999) AS terminated")).toEqual([{ terminated: false }]);
    expect(await outcome(a, "SELECT pg_current_wal_lsn() IS NOT NULL AS has_lsn")).toEqual([{ has_lsn: true }]);

    const pidA = ((await a.query("SELECT pg_backend_pid() AS pid")).rows[0] as { pid: number }).pid;
    const pidB = ((await b.query("SELECT pg_backend_pid() AS pid")).rows[0] as { pid: number }).pid;
    expect(
      await outcome(
        a,
        `SELECT pid, application_name, state, backend_type FROM pg_stat_activity
         WHERE datname = current_database() ORDER BY pid`,
      ),
    ).toEqual([
      { pid: pidA, application_name: "first", state: "active", backend_type: "client backend" },
      { pid: pidB, application_name: "second", state: "idle", backend_type: "client backend" },
    ]);
    expect(await outcome(a, "SELECT numbackends FROM pg_stat_database WHERE datname = current_database()")).toEqual([
      { numbackends: 2 },
    ]);

    // b waits for an advisory lock a holds: a blocks b
    await a.query("SELECT pg_advisory_lock(42)");
    const waiting = b.query("SELECT pg_advisory_lock(42)");
    for (let i = 0; i < 50; i++) {
      const rows = (await a.query("SELECT cardinality(pg_blocking_pids($1)) AS n", [pidB])).rows as { n: number }[];
      if (rows[0]?.n === 1) break;
      await Bun.sleep(10);
    }
    expect(await outcome(a, "SELECT pg_blocking_pids($1)::text AS pids", [pidB])).toEqual([{ pids: `{${pidA}}` }]);
    expect(
      await outcome(
        a,
        `SELECT count(*) FILTER (WHERE backend_type = 'client backend' AND cardinality(pg_blocking_pids(pid)) > 0)::int AS blocked
         FROM pg_stat_activity WHERE datname = current_database()`,
      ),
    ).toEqual([{ blocked: 1 }]);

    // cancelling b's statement fails it with 57014; b stays connected
    expect(await outcome(a, "SELECT pg_cancel_backend($1) AS cancelled", [pidB])).toEqual([{ cancelled: true }]);
    await expect(waiting).rejects.toThrow("canceling statement due to user request");
    expect(await outcome(b, "SELECT 1 AS one")).toEqual([{ one: 1 }]);
    await a.query("SELECT pg_advisory_unlock(42)");

    // a session cancelling itself cancels its own statement
    expect(await outcome(a, "SELECT pg_cancel_backend(pg_backend_pid())")).toBe(
      "ERROR 57014: canceling statement due to user request",
    );

    // terminating b ends its connection
    expect(await outcome(a, "SELECT pg_terminate_backend($1) AS terminated", [pidB])).toEqual([{ terminated: true }]);
    for (let i = 0; i < 50; i++) {
      const rows = (await a.query("SELECT count(*)::int AS n FROM pg_stat_activity")).rows as { n: number }[];
      if (rows[0]?.n === 1) break;
      await Bun.sleep(10);
    }
    expect(await outcome(a, "SELECT count(*)::int AS n FROM pg_stat_activity")).toEqual([{ n: 1 }]);
    await expect(b.query("SELECT 1")).rejects.toThrow();
  } finally {
    await a.end();
    await b.end().catch(() => {});
    await server.close();
  }
});
