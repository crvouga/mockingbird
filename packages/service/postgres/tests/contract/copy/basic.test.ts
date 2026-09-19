import { describe, expect, test } from "bun:test";
import { Database, PostgresError } from "../../../src/index.ts";

function freshTable(): Database {
  const db = new Database();
  db.exec("CREATE TABLE t (a int, b text)");
  return db;
}

describe("COPY FROM STDIN (text format)", () => {
  test("loads tab-separated rows and returns the row count", () => {
    const db = freshTable();
    const n = db.copyFrom("COPY t (a, b) FROM STDIN", "1\tx\n2\ty\n");
    expect(n).toBe(2);
    expect(db.query("SELECT a, b FROM t ORDER BY a")).toEqual([
      { a: 1, b: "x" },
      { a: 2, b: "y" },
    ]);
  });

  test("\\N is NULL and escapes decode", () => {
    const db = freshTable();
    db.copyFrom("COPY t (a, b) FROM STDIN", "1\t\\N\n2\tline\\nbreak\n3\ttab\\there\n4\tback\\\\slash\n");
    expect(db.query("SELECT a, b FROM t ORDER BY a")).toEqual([
      { a: 1, b: null },
      { a: 2, b: "line\nbreak" },
      { a: 3, b: "tab\there" },
      { a: 4, b: "back\\slash" },
    ]);
  });

  test("\\. terminates the stream", () => {
    const db = freshTable();
    const n = db.copyFrom("COPY t (a, b) FROM STDIN", "1\tx\n\\.\n2\tignored\n");
    expect(n).toBe(1);
    expect(db.query("SELECT count(*)::int AS c FROM t")[0]).toEqual({ c: 1 });
  });

  test("column list may reorder and omit columns (defaults apply)", () => {
    const db = new Database();
    db.exec("CREATE TABLE s (id serial, a int, b text DEFAULT 'dflt')");
    db.copyFrom("COPY s (a) FROM STDIN", "10\n20\n");
    expect(db.query("SELECT id, a, b FROM s ORDER BY id")).toEqual([
      { id: 1, a: 10, b: "dflt" },
      { id: 2, a: 20, b: "dflt" },
    ]);
    db.copyFrom("COPY s (b, a) FROM STDIN", "swapped\t30\n");
    expect(db.query("SELECT a, b FROM s WHERE a = 30")).toEqual([{ a: 30, b: "swapped" }]);
  });

  test("values pass through column type input and constraints", () => {
    const db = new Database();
    db.exec("CREATE TABLE c (a int CHECK (a > 0))");
    expect(() => db.copyFrom("COPY c (a) FROM STDIN", "nope\n")).toThrow(/invalid input syntax for type integer/);
    expect(() => db.copyFrom("COPY c (a) FROM STDIN", "-5\n")).toThrow(/check/i);
  });
});

describe("COPY FROM STDIN (csv format)", () => {
  test("quoted fields, embedded delimiters, and doubled quotes", () => {
    const db = freshTable();
    db.copyFrom("COPY t (a, b) FROM STDIN WITH (FORMAT csv)", '1,"hello, world"\n2,"say ""hi"""\n');
    expect(db.query("SELECT a, b FROM t ORDER BY a")).toEqual([
      { a: 1, b: "hello, world" },
      { a: 2, b: 'say "hi"' },
    ]);
  });

  test("empty unquoted field is NULL; quoted empty string is not", () => {
    const db = freshTable();
    db.copyFrom("COPY t (a, b) FROM STDIN WITH (FORMAT csv)", '1,\n2,""\n');
    expect(db.query("SELECT a, b FROM t ORDER BY a")).toEqual([
      { a: 1, b: null },
      { a: 2, b: "" },
    ]);
  });

  test("HEADER skips the first line; DELIMITER and NULL are honored", () => {
    const db = freshTable();
    db.copyFrom("COPY t (a, b) FROM STDIN WITH (FORMAT csv, HEADER, DELIMITER ';', NULL 'NA')", "a;b\n1;x\n2;NA\n");
    expect(db.query("SELECT a, b FROM t ORDER BY a")).toEqual([
      { a: 1, b: "x" },
      { a: 2, b: null },
    ]);
  });
});

describe("COPY TO STDOUT", () => {
  test("text format renders canonical text with \\N nulls and escapes", () => {
    const db = freshTable();
    db.exec("INSERT INTO t VALUES (1, 'x'), (2, NULL), (3, e'multi\\nline')");
    const lines = db.query<{ copy: string }>("COPY t TO STDOUT").map((r) => r.copy);
    expect(lines).toEqual(["1\tx", "2\t\\N", "3\tmulti\\nline"]);
  });

  test("csv format quotes only when needed", () => {
    const db = freshTable();
    db.exec("INSERT INTO t VALUES (1, 'plain'), (2, 'a,b'), (3, NULL)");
    const lines = db.query<{ copy: string }>("COPY t TO STDOUT WITH (FORMAT csv)").map((r) => r.copy);
    expect(lines).toEqual(["1,plain", '2,"a,b"', "3,"]);
  });

  test("COPY (query) TO STDOUT supports arbitrary queries", () => {
    const db = freshTable();
    db.exec("INSERT INTO t VALUES (2, 'b'), (1, 'a')");
    const lines = db
      .query<{ copy: string }>("COPY (SELECT a * 10 AS a10, upper(b) FROM t ORDER BY a) TO STDOUT")
      .map((r) => r.copy);
    expect(lines).toEqual(["10\tA", "20\tB"]);
  });

  test("column subset respects the column list", () => {
    const db = freshTable();
    db.exec("INSERT INTO t VALUES (1, 'x')");
    const lines = db.query<{ copy: string }>("COPY t (b) TO STDOUT").map((r) => r.copy);
    expect(lines).toEqual(["x"]);
  });
});

describe("copyFrom misuse", () => {
  test("rejects non-COPY statements", () => {
    const db = freshTable();
    for (const sql of ["SELECT 1", "COPY t TO STDOUT", "COPY t FROM STDIN; COPY t FROM STDIN"]) {
      try {
        db.copyFrom(sql, "");
        expect.unreachable(`expected copyFrom to throw for: ${sql}`);
      } catch (err) {
        expect(err).toBeInstanceOf(PostgresError);
        expect((err as PostgresError).category).toBe("misuse");
      }
    }
  });

  test("COPY ... FROM STDIN via exec (no data channel) fails loud", () => {
    const db = freshTable();
    expect(() => db.exec("COPY t FROM STDIN")).toThrow(PostgresError);
  });

  test("round-trips: COPY TO output feeds COPY FROM", () => {
    const source = new Database();
    source.exec("CREATE TABLE r (a int, b text, c numeric(10,2))");
    source.exec("INSERT INTO r VALUES (1, e'tabs\\tand\\nnewlines', 1.50), (2, NULL, NULL)");
    const dump = `${source
      .query<{ copy: string }>("COPY r TO STDOUT")
      .map((row) => row.copy)
      .join("\n")}\n`;
    const dest = new Database();
    dest.exec("CREATE TABLE r (a int, b text, c numeric(10,2))");
    expect(dest.copyFrom("COPY r FROM STDIN", dump)).toBe(2);
    expect(dest.query("SELECT * FROM r ORDER BY a")).toEqual(source.query("SELECT * FROM r ORDER BY a"));
  });
});
