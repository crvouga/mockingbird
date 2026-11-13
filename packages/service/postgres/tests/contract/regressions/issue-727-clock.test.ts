import { describe, expect, test } from "bun:test";
import { InMemoryAdapter } from "../../adapters/in-memory.ts";
import { Database } from "../../../src/index.ts";
import { expectParity } from "../../harness/assert.ts";
import { createOracleAdapter } from "../../harness/oracle.ts";
import type { ContractDb } from "../../harness/types.ts";

// #727: with `{ now: "system" }`, now() is frozen at transaction start, statement_timestamp() at
// statement start, clock_timestamp() advances on every call; pg_sleep sleeps; statement_timeout cancels.
// #728: timeofday().

/** PGlite boots per test; slow under load. */
const ORACLE_TIMEOUT_MS = 60_000;

const DAY = "(Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
const MONTH = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
const TIMEOFDAY = `^${DAY} ${MONTH} [0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{6} [0-9]{4} `;

function busyWait(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // spin
  }
}

/** A timestamptz as the API returns it (`2026-11-13 20:11:31.432294+00`), in unix ms. */
function at(text: string): number {
  const iso = text
    .replace(" ", "T")
    .replace(/(\.\d{3})\d*/, "$1")
    .replace(/\+00$/, "Z");
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`unparsed timestamptz ${text}`);
  return ms;
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

function sqlState(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { sqlState?: string }).sqlState;
  }
  return undefined;
}

describe("oracle: a system clock behaves like PostgreSQL's", () => {
  async function both(fn: (db: ContractDb) => Promise<unknown>): Promise<void> {
    const memory = new InMemoryAdapter({ now: "system" });
    const postgres = createOracleAdapter();
    try {
      await fn(memory);
      await fn(postgres);
    } finally {
      await memory.close();
      await postgres.close();
    }
  }

  test(
    "now() is the transaction start; statement_timestamp() and clock_timestamp() move",
    async () => {
      const memory = new InMemoryAdapter({ now: "system" });
      const postgres = createOracleAdapter();
      try {
        for (const sql of [
          "CREATE TABLE stamps (n timestamptz, s timestamptz)",
          "BEGIN",
          "INSERT INTO stamps SELECT now(), statement_timestamp()",
          "SELECT pg_sleep(0.03)",
        ]) {
          const a = await memory.exec(sql);
          const b = await postgres.exec(sql);
          expect(a.ok, `${sql}: ${a.error?.message}`).toBe(true);
          expect(b.ok, `${sql}: ${b.error?.message}`).toBe(true);
        }
        const probe = `SELECT (SELECT n FROM stamps) = now() AS frozen,
          (SELECT n FROM stamps) = transaction_timestamp() AS tx,
          (SELECT n FROM stamps) = current_timestamp AS cur,
          (SELECT n FROM stamps)::timestamp = localtimestamp AS local,
          statement_timestamp() > (SELECT s FROM stamps) AS statement_moved,
          clock_timestamp() > now() AS clock_moved,
          clock_timestamp() >= statement_timestamp() AS clock_after_statement,
          pg_typeof(clock_timestamp())::text AS clock_type`;
        expectParity(await memory.query(probe), await postgres.query(probe), { ignoreWriteCounters: true });
        await memory.exec("COMMIT");
        await postgres.exec("COMMIT");
        const single = "SELECT now() = statement_timestamp() AS same, now() = transaction_timestamp() AS tx";
        expectParity(await memory.query(single), await postgres.query(single), { ignoreWriteCounters: true });
      } finally {
        await memory.close();
        await postgres.close();
      }
    },
    ORACLE_TIMEOUT_MS,
  );

  test(
    "pg_sleep, pg_sleep_for and pg_sleep_until wait and return void",
    async () => {
      const sql = `SELECT pg_typeof(pg_sleep(0.02))::text AS a, pg_typeof(pg_sleep_for('20 ms'))::text AS b,
        pg_typeof(pg_sleep_until(clock_timestamp() + interval '20 ms'))::text AS c,
        pg_sleep(NULL) IS NULL AS strict, pg_sleep(-1)::text AS negative,
        pg_sleep_for(NULL) IS NULL AS for_null, pg_sleep_until(NULL) IS NULL AS until_null`;
      const memory = new InMemoryAdapter({ now: "system" });
      const postgres = createOracleAdapter();
      try {
        let start = performance.now();
        const a = await memory.query(sql);
        const memoryMs = performance.now() - start;
        start = performance.now();
        const b = await postgres.query(sql);
        const postgresMs = performance.now() - start;
        expectParity(a, b, { ignoreWriteCounters: true });
        expect(memoryMs).toBeGreaterThanOrEqual(55);
        expect(postgresMs).toBeGreaterThanOrEqual(55);
      } finally {
        await memory.close();
        await postgres.close();
      }
    },
    ORACLE_TIMEOUT_MS,
  );

  test(
    "timeofday() is text in PostgreSQL's format, with the session time zone's abbreviation",
    async () => {
      await both(async (db) => {
        const result = await db.query(
          `SELECT pg_typeof(timeofday())::text AS t, timeofday() ~ '${TIMEOFDAY}UTC$' AS utc`,
        );
        expect(result.ok, result.error?.message).toBe(true);
        expect(result.rows).toEqual([{ t: "text", utc: "t" }]);
        await db.exec("SET TimeZone = 'America/Los_Angeles'");
        const pacific = await db.query(`SELECT timeofday() ~ '${TIMEOFDAY}(PST|PDT)$' AS ok`);
        expect(pacific.rows).toEqual([{ ok: "t" }]);
        await db.exec("SET TimeZone = 'Asia/Kolkata'");
        const india = await db.query(`SELECT timeofday() ~ '${TIMEOFDAY}IST$' AS ok`);
        expect(india.rows).toEqual([{ ok: "t" }]);
      });
    },
    ORACLE_TIMEOUT_MS,
  );
});

describe("engine: transaction-frozen now() with a system clock", () => {
  test("two now() in one BEGIN block are equal; clock_timestamp() advances", () => {
    const db = new Database({ now: "system" });
    db.exec("BEGIN");
    const first = db.query<{ n: string; c: string; s: string }>(
      "SELECT now() AS n, clock_timestamp() AS c, statement_timestamp() AS s",
    )[0]!;
    busyWait(30);
    const second = db.query<{ n: string; c: string; s: string; d: string; t: string; lt: string }>(
      "SELECT now() AS n, clock_timestamp() AS c, statement_timestamp() AS s, current_date::text AS d, current_time::text AS t, localtimestamp::text AS lt",
    )[0]!;
    db.exec("COMMIT");
    expect(second.n).toBe(first.n);
    expect(`${second.lt}+00`).toBe(first.n);
    expect(`${second.d} ${second.t.replace(/\+00$/, "")}+00`).toBe(first.n);
    expect(at(second.s) - at(first.s)).toBeGreaterThanOrEqual(29);
    expect(at(second.c) - at(first.c)).toBeGreaterThanOrEqual(29);
    // after COMMIT, now() moves again
    const after = db.query<{ n: string }>("SELECT now() AS n")[0]!;
    expect(at(after.n)).toBeGreaterThan(at(first.n));
  });

  test("now() is the BEGIN time, the same in every statement and in written rows", () => {
    const db = new Database({ now: "system" });
    db.exec("CREATE TABLE log (at timestamptz)");
    db.exec("BEGIN");
    const begun = Date.now();
    busyWait(20);
    db.exec("INSERT INTO log VALUES (now())");
    busyWait(20);
    db.exec("INSERT INTO log SELECT now()");
    db.exec("COMMIT");
    const rows = db.query<{ c: number; at: string }>("SELECT count(DISTINCT at)::int AS c, min(at) AS at FROM log");
    expect(rows[0]!.c).toBe(1);
    expect(at(rows[0]!.at)).toBeLessThanOrEqual(begun + 1);
  });

  test("a multi-statement script is one implicit transaction", () => {
    const db = new Database({ now: "system" });
    db.exec("CREATE TABLE log (at timestamptz)");
    db.exec("INSERT INTO log VALUES (now()); SELECT pg_sleep(0.02); INSERT INTO log VALUES (now())");
    expect(db.query<{ c: number }>("SELECT count(DISTINCT at)::int AS c FROM log")[0]!.c).toBe(1);
  });

  test("savepoints and rollback to them keep the transaction start", () => {
    const db = new Database({ now: "system" });
    db.exec("BEGIN");
    const first = db.query<{ n: string }>("SELECT now() AS n")[0]!.n;
    db.exec("SAVEPOINT a");
    busyWait(10);
    db.exec("ROLLBACK TO SAVEPOINT a");
    busyWait(10);
    expect(db.query<{ n: string }>("SELECT now() AS n")[0]!.n).toBe(first);
    db.exec("ROLLBACK");
  });

  test("db.transaction() freezes now() too", () => {
    const db = new Database({ now: "system" });
    const values = db.transaction(() => {
      const a = db.query<{ n: string }>("SELECT now() AS n")[0]!.n;
      busyWait(15);
      const b = db.query<{ n: string }>("SELECT now() AS n")[0]!.n;
      return [a, b];
    });
    expect(values[0]).toBe(values[1]);
  });

  test("clock_timestamp() advances within one statement, with microsecond precision", () => {
    const db = new Database({ now: "system" });
    const row = db.query<{ distinct: number; sub_ms: number; ordered: boolean }>(
      `SELECT count(DISTINCT c)::int AS distinct,
         count(*) FILTER (WHERE extract(microseconds FROM c)::int8 % 1000 <> 0)::int AS sub_ms,
         bool_and(c >= now()) AS ordered
       FROM (SELECT clock_timestamp() AS c FROM generate_series(1, 2000)) s`,
    )[0]!;
    expect(row.distinct).toBeGreaterThan(1);
    expect(row.sub_ms).toBeGreaterThan(0);
    expect(row.ordered).toBe(true);
  });

  test("a fixed clock keeps every function at the fixed instant", () => {
    const db = new Database();
    db.exec("BEGIN");
    const row = db.query<Record<string, string>>(
      `SELECT now()::text AS n, clock_timestamp()::text AS c, statement_timestamp()::text AS s,
         transaction_timestamp()::text AS t, timeofday() AS tod`,
    )[0]!;
    db.exec("COMMIT");
    expect(row).toEqual({
      n: "2000-01-01 00:00:00+00",
      c: "2000-01-01 00:00:00+00",
      s: "2000-01-01 00:00:00+00",
      t: "2000-01-01 00:00:00+00",
      tod: "Sat Jan 01 00:00:00.000000 2000 UTC",
    });
  });

  test("an injected clock is sampled at transaction start for now() and per call for clock_timestamp()", () => {
    let ms = Date.UTC(2024, 0, 1);
    const db = new Database({
      now: () => {
        ms += 1000;
        return new Date(ms);
      },
    });
    db.exec("BEGIN");
    const a = db.query<{ n: string; c1: string; c2: string }>(
      "SELECT now() AS n, clock_timestamp() AS c1, clock_timestamp() AS c2",
    )[0]!;
    const b = db.query<{ n: string }>("SELECT now() AS n")[0]!;
    db.exec("COMMIT");
    expect(b.n).toBe(a.n);
    expect(at(a.c2)).toBeGreaterThan(at(a.c1));
    expect(at(a.c1)).toBeGreaterThan(at(a.n));
  });
});

describe("engine: pg_sleep", () => {
  test("sleeps with a system clock", () => {
    const db = new Database({ now: "system" });
    expect(timed(() => db.query("SELECT pg_sleep(0.05)")).ms).toBeGreaterThanOrEqual(49);
    expect(timed(() => db.query("SELECT pg_sleep_for('50 milliseconds')")).ms).toBeGreaterThanOrEqual(49);
    expect(
      timed(() => db.query("SELECT pg_sleep_until(clock_timestamp() + interval '50 ms')")).ms,
    ).toBeGreaterThanOrEqual(45);
    expect(timed(() => db.query("SELECT pg_sleep_until(now() - interval '1 day')")).ms).toBeLessThan(200);
  });

  test("returns at once with the default fixed clock (deterministic tests stay fast)", () => {
    const db = new Database();
    const { value, ms } = timed(() =>
      db.query<{ a: string; b: string; c: string }>(
        "SELECT pg_sleep(5)::text AS a, pg_sleep_for('5 seconds')::text AS b, pg_sleep_until(now() + interval '1 hour')::text AS c",
      ),
    );
    expect(value).toEqual([{ a: "", b: "", c: "" }]);
    expect(ms).toBeLessThan(500);
  });
});

describe("engine: statement_timeout", () => {
  const heavy = "SELECT count(*) FROM generate_series(1, 1000000) g WHERE g % 7 = 3";

  test("cancels a long statement with 57014", () => {
    const db = new Database({ now: "system" });
    db.exec("SET statement_timeout = '1ms'");
    let error: unknown;
    try {
      db.query(heavy);
    } catch (e) {
      error = e;
    }
    expect((error as { sqlState?: string }).sqlState).toBe("57014");
    expect((error as Error).message).toBe("canceling statement due to statement timeout");
    db.exec("SET statement_timeout = 0");
    expect(db.query<{ count: bigint }>(heavy)[0]!.count).toBe(142857n);
  });

  test("applies with the default fixed clock too, and to every unit form", () => {
    const db = new Database();
    for (const value of ["1", "'1ms'", "'0.001s'", "'2 ms'"]) {
      db.exec(`SET statement_timeout = ${value}`);
      expect(sqlState(() => db.query(heavy))).toBe("57014");
    }
    db.exec("SET statement_timeout = '1min'");
    expect(sqlState(() => db.query("SELECT count(*) FROM generate_series(1, 1000)"))).toBeUndefined();
  });

  test("cuts pg_sleep short", () => {
    const db = new Database({ now: "system" });
    db.exec("SET statement_timeout = 50");
    const { value, ms } = timed(() => sqlState(() => db.query("SELECT pg_sleep(2)")));
    expect(value).toBe("57014");
    expect(ms).toBeGreaterThanOrEqual(45);
    expect(ms).toBeLessThan(1000);
  });

  test("covers scans, joins, sorts and aggregates", () => {
    const db = new Database();
    db.exec("CREATE TABLE big AS SELECT g AS id, g % 100 AS k FROM generate_series(1, 200000) g");
    db.exec("SET statement_timeout = 1");
    for (const sql of [
      "SELECT * FROM big",
      "SELECT * FROM big ORDER BY k DESC, id",
      "SELECT k, count(*), sum(id) FROM big GROUP BY k",
      "SELECT count(*) FROM big a JOIN big b ON a.id = b.id",
      "SELECT count(*) FROM (SELECT * FROM big LIMIT 3000) a, (SELECT * FROM big LIMIT 3000) b WHERE a.k = b.k",
    ]) {
      expect(
        sqlState(() => db.query(sql)),
        sql,
      ).toBe("57014");
    }
  });

  test("a timed-out write leaves no rows; the session keeps working", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (g int)");
    db.exec("BEGIN");
    db.exec("INSERT INTO t VALUES (0)");
    db.exec("SET LOCAL statement_timeout = 1");
    expect(sqlState(() => db.exec("INSERT INTO t SELECT g FROM generate_series(1, 2000000) g"))).toBe("57014");
    db.exec("COMMIT");
    expect(db.query<{ c: number }>("SELECT count(*)::int AS c FROM t")[0]!.c).toBe(1);
    expect(db.query("SHOW statement_timeout")).toEqual([{ statement_timeout: "0" }]);
  });

  test("lock_timeout and idle_in_transaction_session_timeout are accepted", () => {
    const db = new Database();
    db.exec("SET lock_timeout = '1ms'; SET idle_in_transaction_session_timeout = '1ms'");
    expect(db.query("SELECT count(*)::int AS c FROM generate_series(1, 300000)")).toEqual([{ c: 300000 }]);
  });
});
