import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as sqliteMem from "../../../src/index.ts";
import { Database, SqliteError } from "../../../src/index.ts";
import { expectParity, matrixBoth } from "../../harness/index.ts";

describe("public API exports", () => {
  test("main entry runtime keys are exactly Database, Snapshot, Statement, SqliteError", () => {
    expect(Object.keys(sqliteMem).sort()).toEqual(["Database", "Snapshot", "SqliteError", "Statement"]);
  });

  test("package.json exports only . and ./unstable", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../../package.json"), "utf8")) as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(pkg.exports).sort()).toEqual([".", "./unstable"]);
  });

  test("deep package subpaths are not exported", async () => {
    await expect(import("@crvouga/sqlite-mem/dist/api/database.js")).rejects.toBeDefined();
  });
});

describe("exec parameters", () => {
  test("exec rejects a second argument at runtime", () => {
    const db = new Database();
    expect(() => {
      (db.exec as (sql: string, params?: unknown) => void)("SELECT 1", [1]);
    }).toThrow(SqliteError);
    try {
      (db.exec as (sql: string, params?: unknown) => void)("SELECT 1", [1]);
    } catch (err) {
      expect(err).toBeInstanceOf(SqliteError);
      expect((err as SqliteError).category).toBe("misuse");
      expect((err as SqliteError).message).toBe("exec() does not accept parameters; use prepare() or query()");
      expect((err as SqliteError).sqliteCode).toBe("SQLITE_ERROR");
      expect((err as SqliteError).code).toBe("SQLITE_ERROR");
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
      try {
        db.prepare(sql);
      } catch (err) {
        expect(err).toBeInstanceOf(SqliteError);
        expect((err as SqliteError).category).toBe("misuse");
      }
    }
    expect(db.query("SELECT 1;")).toEqual([{ "1": 1 }]);
    db.exec("CREATE TABLE t(id INTEGER); INSERT INTO t VALUES (1); INSERT INTO t VALUES (2);");
    expect(db.query("SELECT COUNT(*) AS c FROM t")).toEqual([{ c: 2 }]);
    db.close();
  });

  for (const sql of ["", "   ", ";", "-- comment", "/* c */", "/* c */;"]) {
    matrixBoth(`prepare fails for ${JSON.stringify(sql)}`, (memory, sqlite) => {
      let memFailed = false;
      let realFailed = false;
      try {
        memory.prepare(sql);
      } catch {
        memFailed = true;
      }
      try {
        sqlite.prepare(sql);
      } catch {
        realFailed = true;
      }
      expect(memFailed).toBe(true);
      expect(realFailed).toBe(true);
    });
  }
});

describe("ResultSet.values", () => {
  test("values is always an array including zero-row SELECT and DML", () => {
    const db = new Database();
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)");
    const emptySelect = db.prepare("SELECT id, name FROM t WHERE 0").result();
    expect(emptySelect.columns).toEqual(["id", "name"]);
    expect(emptySelect.rows).toEqual([]);
    expect(emptySelect.values).toEqual([]);
    const dml = db.prepare("INSERT INTO t(name) VALUES (?)").result("Ada");
    expect(Array.isArray(dml.values)).toBe(true);
    expect(dml.values).toEqual([]);
    const rows = db.prepare("SELECT id, name FROM t").result();
    expect(rows.values).toEqual([[1, "Ada"]]);
    db.close();
  });
});

describe("Statement bind surface", () => {
  test("Statement has no bind method", () => {
    const db = new Database();
    const stmt = db.prepare("SELECT 1");
    expect("bind" in stmt).toBe(false);
    expect((stmt as { bind?: unknown }).bind).toBeUndefined();
    db.close();
  });

  matrixBoth("missing bind parameters match bun:sqlite failure", (memory, sqlite) => {
    memory.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    sqlite.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    // Zero args → unbound params are NULL → NOT NULL constraint (both engines).
    const mem = memory.prepare("INSERT INTO t(name) VALUES (?)").run();
    const real = sqlite.prepare("INSERT INTO t(name) VALUES (?)").run();
    expectParity(mem, real);
    expect(mem.ok).toBe(false);
  });

  matrixBoth("too many bind parameters match bun:sqlite failure", (memory, sqlite) => {
    const mem = memory.prepare("SELECT ? AS x").get(1, 2);
    const real = sqlite.prepare("SELECT ? AS x").get(1, 2);
    expectParity(mem, real);
    expect(mem.ok).toBe(false);
  });

  matrixBoth("partial non-zero bind count match bun:sqlite failure", (memory, sqlite) => {
    const mem = memory.prepare("SELECT ? AS a, ? AS b").get(1);
    const real = sqlite.prepare("SELECT ? AS a, ? AS b").get(1);
    expectParity(mem, real);
    expect(mem.ok).toBe(false);
  });

  test("rejects DataView and non-Uint8Array typed arrays", () => {
    const db = new Database();
    const stmt = db.prepare("SELECT ? AS b");
    expect(() => stmt.get(new DataView(new ArrayBuffer(4)))).toThrow(SqliteError);
    expect(() => stmt.get(new Int8Array([1, 2]))).toThrow(/Int8Array/);
    expect(() => stmt.get(new Uint16Array([1]))).toThrow(/Uint16Array/);
    try {
      stmt.get(new DataView(new ArrayBuffer(1)));
    } catch (err) {
      expect((err as SqliteError).category).toBe("misuse");
    }
    expect(stmt.get(new Uint8Array([1, 2]))).toEqual({ b: new Uint8Array([1, 2]) });
    expect(stmt.get(new ArrayBuffer(2))).toEqual({ b: new Uint8Array(2) });
    db.close();
  });
});

describe("SqliteError contract", () => {
  test("sqliteCode and code are always set", () => {
    const db = new Database();
    try {
      db.exec("SELECT * FROM missing");
    } catch (err) {
      expect(err).toBeInstanceOf(SqliteError);
      expect((err as SqliteError).sqliteCode).toBe("SQLITE_ERROR");
      expect((err as SqliteError).code).toBe("SQLITE_ERROR");
      expect((err as SqliteError).category).toBe("no_such_table");
    }
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, email TEXT UNIQUE)");
    db.exec("INSERT INTO t VALUES (1, 'a@b.c')");
    try {
      db.exec("INSERT INTO t VALUES (2, 'a@b.c')");
    } catch (err) {
      expect(err).toBeInstanceOf(SqliteError);
      expect((err as SqliteError).sqliteCode).toBe("SQLITE_CONSTRAINT_UNIQUE");
      expect((err as SqliteError).code).toBe("SQLITE_CONSTRAINT_UNIQUE");
      expect((err as SqliteError).category).toBe("constraint_unique");
    }
    db.close();
  });
});

describe("Symbol.dispose", () => {
  test("dispose closes the database when Symbol.dispose exists", () => {
    const disposeKey = (Symbol as unknown as { dispose?: symbol }).dispose;
    if (typeof disposeKey !== "symbol") {
      return;
    }
    const db = new Database();
    db.exec("CREATE TABLE t(id INTEGER)");
    (db as unknown as Record<symbol, () => void>)[disposeKey]();
    expect(() => db.exec("SELECT 1")).toThrow(/closed/);
  });
});

describe("close inside transaction()", () => {
  test("throws misuse", () => {
    const db = new Database();
    expect(() => {
      db.transaction(() => {
        db.close();
      });
    }).toThrow(/cannot close database inside transaction\(\)/);
    try {
      db.transaction(() => {
        db.close();
      });
    } catch (err) {
      expect(err).toBeInstanceOf(SqliteError);
      expect((err as SqliteError).category).toBe("misuse");
    }
    // Database remains open after the failed close attempt.
    db.exec("CREATE TABLE t(id INTEGER)");
    db.close();
  });
});

matrixBoth("changes after multi-statement exec match bun:sqlite", (memory, sqlite) => {
  memory.exec("CREATE TABLE t(id INTEGER)");
  sqlite.exec("CREATE TABLE t(id INTEGER)");
  memory.exec("INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); INSERT INTO t VALUES (3);");
  sqlite.exec("INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); INSERT INTO t VALUES (3);");
  expectParity(memory.query("SELECT changes() AS c"), sqlite.query("SELECT changes() AS c"));
  memory.exec("INSERT INTO t VALUES (4); INSERT INTO t VALUES (5);");
  sqlite.exec("INSERT INTO t VALUES (4); INSERT INTO t VALUES (5);");
  expectParity(memory.query("SELECT changes() AS c"), sqlite.query("SELECT changes() AS c"));
});
