import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as postgresMem from "../../../src/index.ts";
import { Database, PostgresError } from "../../../src/index.ts";

describe("public API exports", () => {
  test("main entry runtime keys are exactly Database, PostgresError, Snapshot, Statement", () => {
    expect(Object.keys(postgresMem).sort()).toEqual(["Database", "PostgresError", "Snapshot", "Statement"]);
  });

  test("package.json exports only . and ./unstable", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../../package.json"), "utf8")) as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(pkg.exports).sort()).toEqual([".", "./unstable"]);
  });
});

describe("exec parameters", () => {
  test("exec rejects a second argument at runtime", () => {
    const db = new Database();
    try {
      (db.exec as (sql: string, params?: unknown) => void)("SELECT 1", [1]);
      expect.unreachable("expected exec to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PostgresError);
      expect((err as PostgresError).category).toBe("misuse");
      expect((err as PostgresError).message).toBe("exec() does not accept parameters; use prepare() or query()");
    }
    db.close();
  });
});

describe("single-statement query/prepare", () => {
  test("query and prepare reject multiple statements", () => {
    const db = new Database();
    for (const sql of ["SELECT 1; SELECT 2", "SELECT 1; SELECT 2;"]) {
      expect(() => db.query(sql)).toThrow(/single statement/);
      expect(() => db.prepare(sql)).toThrow(/single statement/);
    }
    // trailing semicolon on a single statement is fine
    expect(db.query("SELECT 1 AS v;")).toEqual([{ v: 1 }]);
    db.close();
  });
});

describe("error shape", () => {
  test("PostgresError carries category and SQLSTATE code", () => {
    const db = new Database();
    try {
      db.query("SELECT * FROM missing_table");
      expect.unreachable("expected query to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PostgresError);
      const pg = err as PostgresError;
      expect(pg.category).toBe("undefined_table");
      expect(pg.code).toBe("42P01");
      expect(pg.message).toMatch(/relation "missing_table" does not exist/);
    }
    db.close();
  });

  test("close is idempotent and later use is misuse", () => {
    const db = new Database();
    db.close();
    db.close();
    try {
      db.query("SELECT 1");
      expect.unreachable("expected query to throw");
    } catch (err) {
      expect((err as PostgresError).category).toBe("misuse");
    }
  });
});
