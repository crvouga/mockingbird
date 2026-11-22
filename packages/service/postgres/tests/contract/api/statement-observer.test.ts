import { describe, expect, test } from "bun:test";
import { Database, type StatementEvent } from "../../../src/index.ts";

// #898: a host can find the statement that blocked the (synchronous) engine.

const SLOW_MS = 30;

/** A database with `spin(ms)`, a function that holds the thread for `ms` milliseconds. */
function database(options: ConstructorParameters<typeof Database>[0] = {}): Database {
  const db = new Database(options);
  db.registerFunction({
    name: "spin",
    args: ["int4"],
    returns: "int4",
    fn: (ms) => {
      const end = performance.now() + Number(ms);
      while (performance.now() < end) {}
      return Number(ms);
    },
  });
  db.exec("CREATE TABLE users (id int PRIMARY KEY, email text)");
  return db;
}

describe("#898 statement observer", () => {
  test("reports a slow statement with its text, duration and row count", () => {
    const events: StatementEvent[] = [];
    const db = database({ onStatement: (event) => events.push(event), slowStatementMs: SLOW_MS });
    db.exec("INSERT INTO users VALUES (1, 'a@example.com'), (2, 'b@example.com')");
    db.query("SELECT id FROM users WHERE id = $1", [1]);
    expect(events).toEqual([]);

    const sql = `SELECT spin(${SLOW_MS * 2}) AS ms, id FROM users WHERE email LIKE $1`;
    expect(db.query(sql, ["%@example.com"])).toHaveLength(2);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event!.sql).toBe(sql);
    expect(event!.durationMs).toBeGreaterThanOrEqual(SLOW_MS);
    expect(event!.rows).toBe(2);
    expect(event!.command).toBe("SELECT");
    // parameter values stay out unless the host opts in
    expect(event).not.toHaveProperty("params");
    expect(event).not.toHaveProperty("error");
  });

  test("slowStatementMs 0 (the default) reports every statement; a script one statement at a time", () => {
    const events: StatementEvent[] = [];
    const db = database({ onStatement: (event) => events.push(event) });
    events.length = 0;
    db.exec("INSERT INTO users VALUES (1, 'a'); UPDATE users SET email = 'b' WHERE id = 1; SELECT 1");
    expect(events.map(({ sql, rows, command }) => ({ sql, rows, command }))).toEqual([
      { sql: "INSERT INTO users VALUES (1, 'a')", rows: 1, command: "INSERT" },
      { sql: "UPDATE users SET email = 'b' WHERE id = 1", rows: 1, command: "UPDATE" },
      { sql: "SELECT 1", rows: 1, command: "SELECT" },
    ]);
    for (const event of events) expect(event.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("includeParams opts in to parameter values", () => {
    const events: StatementEvent[] = [];
    const db = database({ onStatement: (event) => events.push(event), includeParams: true });
    db.prepare("INSERT INTO users VALUES ($1, $2)").run(7, "c@example.com");
    expect(events.at(-1)).toMatchObject({ sql: "INSERT INTO users VALUES ($1, $2)", params: [7, "c@example.com"] });
  });

  test("a failing statement is reported with its error, which still reaches the caller", () => {
    const events: StatementEvent[] = [];
    const db = database({ onStatement: (event) => events.push(event) });
    db.exec("INSERT INTO users VALUES (1, 'a')");
    expect(() => db.exec("INSERT INTO users VALUES (1, 'again')")).toThrow(/duplicate key/);
    const failed = events.at(-1)!;
    expect(failed.sql).toBe("INSERT INTO users VALUES (1, 'again')");
    expect(failed.rows).toBe(0);
    expect((failed.error as { sqlState?: string }).sqlState).toBe("23505");
  });

  test("observeStatements adds observers with their own threshold, and stops", () => {
    const db = database();
    const all: string[] = [];
    const slow: string[] = [];
    const stopAll = db.observeStatements((event) => all.push(event.sql));
    db.observeStatements((event) => slow.push(event.sql), { slowStatementMs: SLOW_MS });
    db.query("SELECT 1");
    db.query(`SELECT spin(${SLOW_MS * 2})`);
    stopAll();
    db.query("SELECT 2");
    expect(all).toEqual(["SELECT 1", `SELECT spin(${SLOW_MS * 2})`]);
    expect(slow).toEqual([`SELECT spin(${SLOW_MS * 2})`]);
  });

  test("an observer that throws does not fail the statement", () => {
    const db = database({
      onStatement: () => {
        throw new Error("observer bug");
      },
    });
    expect(db.query("SELECT 1 AS one")).toEqual([{ one: 1 }]);
  });

  test("a negative threshold is rejected", () => {
    expect(() => new Database({ onStatement: () => {}, slowStatementMs: -1 })).toThrow(RangeError);
  });
});
