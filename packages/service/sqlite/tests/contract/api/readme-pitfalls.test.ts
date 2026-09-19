import { describe, expect, test } from "bun:test";
import { Database, SqliteError } from "../../../src/index.ts";

function expectCategory(fn: () => unknown, category: string): void {
  try {
    fn();
    expect.unreachable("expected SqliteError");
  } catch (error) {
    expect(error).toBeInstanceOf(SqliteError);
    expect((error as SqliteError).category).toBe(category);
  }
}

describe("README common pitfalls", () => {
  test("rejects non-SQL JavaScript bind values", () => {
    const db = new Database();
    try {
      const statement = db.prepare("SELECT ? AS value");
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined]) {
        expectCategory(() => statement.get(value as never), "datatype_mismatch");
      }
      expectCategory(() => statement.get(new Date("2024-01-01T00:00:00.000Z") as never), "datatype_mismatch");
    } finally {
      db.close();
    }
  });

  test("query and prepare reject multi-statement scripts", () => {
    const db = new Database();
    try {
      expectCategory(() => db.query("SELECT 1; SELECT 2"), "misuse");
      expectCategory(() => db.prepare("SELECT 1; SELECT 2"), "misuse");
      expectCategory(() => db.query("-- only a comment"), "misuse");
      expectCategory(() => db.prepare(""), "misuse");
    } finally {
      db.close();
    }
  });

  test("exec accepts scripts, returns void, and rejects parameters", () => {
    const db = new Database();
    try {
      expect(
        db.exec(`
          CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT);
          INSERT INTO t(name) VALUES ('Ada');
        `),
      ).toBeUndefined();
      expect(db.query("SELECT id, name FROM t")).toEqual([{ id: 1, name: "Ada" }]);
      expectCategory(
        () => (db.exec as (sql: string, value: unknown) => void)("INSERT INTO t(name) VALUES (?)", "Bob"),
        "misuse",
      );
    } finally {
      db.close();
    }
  });

  test("documented lifecycle misuse errors remain categorized", () => {
    const db = new Database();
    expectCategory(
      () =>
        db.transaction(() => {
          db.close();
        }),
      "misuse",
    );
    db.close();
    expectCategory(() => db.query("SELECT 1"), "misuse");
    expectCategory(() => db.prepare("SELECT 1"), "misuse");
    expectCategory(() => db.exec("SELECT 1"), "misuse");
  });

  test("default clock is year 2000; system and os options are accepted", () => {
    const fixed = new Database();
    expect(fixed.query<{ d: string }>("SELECT date('now') AS d")[0]!.d).toBe("2000-01-01");
    fixed.close();
    const live = new Database({ now: "system", random: "os" });
    expect(live.query<{ d: string }>("SELECT date('now') AS d")[0]!.d).toBe(new Date().toISOString().slice(0, 10));
    expect(live.query<{ t: string }>("SELECT typeof(random()) AS t")[0]!.t).toBe("integer");
    live.close();
  });
});
