import { expect } from "bun:test";
import { CPY_SECTION } from "../../../compat/sections/cpy.ts";
import { PostgresError } from "../../../src/index.ts";
import { runCatalog } from "./run.ts";

runCatalog(CPY_SECTION, [
  {
    id: "CPY-from-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (a int, b text)");
      expect(db.copyFrom("COPY t (a, b) FROM STDIN", "1\tx\n2\ty\n")).toBe(2);
      expect(db.query("SELECT a, b FROM t ORDER BY a")).toEqual([
        { a: 1, b: "x" },
        { a: 2, b: "y" },
      ]);
    },
  },
  {
    id: "CPY-from-02",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (a int, b text)");
      db.copyFrom("COPY t (a, b) FROM STDIN", "1\t\\N\n2\tline\\nbreak\n3\ttab\\there\n4\tback\\\\slash\n");
      expect(db.query("SELECT a, b FROM t ORDER BY a")).toEqual([
        { a: 1, b: null },
        { a: 2, b: "line\nbreak" },
        { a: 3, b: "tab\there" },
        { a: 4, b: "back\\slash" },
      ]);
    },
  },
  {
    id: "CPY-from-03",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (a int, b text)");
      expect(db.copyFrom("COPY t (a, b) FROM STDIN", "1\tx\n\\.\n2\tignored\n")).toBe(1);
      expect(db.query("SELECT count(*)::int AS c FROM t")[0]).toEqual({ c: 1 });
    },
  },
  {
    id: "CPY-from-04",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE s (id serial, a int, b text DEFAULT 'dflt')");
      db.copyFrom("COPY s (a) FROM STDIN", "10\n20\n");
      expect(db.query("SELECT id, a, b FROM s ORDER BY id")).toEqual([
        { id: 1, a: 10, b: "dflt" },
        { id: 2, a: 20, b: "dflt" },
      ]);
      db.copyFrom("COPY s (b, a) FROM STDIN", "swapped\t30\n");
      expect(db.query("SELECT a, b FROM s WHERE a = 30")).toEqual([{ a: 30, b: "swapped" }]);
    },
  },
  {
    id: "CPY-from-05",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE c (a int CHECK (a > 0))");
      expect(() => db.copyFrom("COPY c (a) FROM STDIN", "nope\n")).toThrow(/invalid input syntax for type integer/);
      expect(() => db.copyFrom("COPY c (a) FROM STDIN", "-5\n")).toThrow(/check/i);
    },
  },
  {
    id: "CPY-csv-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (a int, b text)");
      db.copyFrom("COPY t (a, b) FROM STDIN WITH (FORMAT csv)", '1,"hello, world"\n2,"say ""hi"""\n');
      expect(db.query("SELECT a, b FROM t ORDER BY a")).toEqual([
        { a: 1, b: "hello, world" },
        { a: 2, b: 'say "hi"' },
      ]);
    },
  },
  {
    id: "CPY-csv-02",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (a int, b text)");
      db.copyFrom("COPY t (a, b) FROM STDIN WITH (FORMAT csv)", '1,\n2,""\n');
      expect(db.query("SELECT a, b FROM t ORDER BY a")).toEqual([
        { a: 1, b: null },
        { a: 2, b: "" },
      ]);
    },
  },
  {
    id: "CPY-csv-03",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (a int, b text)");
      db.copyFrom("COPY t (a, b) FROM STDIN WITH (FORMAT csv, HEADER, DELIMITER ';', NULL 'NA')", "a;b\n1;x\n2;NA\n");
      expect(db.query("SELECT a, b FROM t ORDER BY a")).toEqual([
        { a: 1, b: "x" },
        { a: 2, b: null },
      ]);
    },
  },
  {
    id: "CPY-to-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (a int, b text)");
      db.exec("INSERT INTO t VALUES (1, 'x'), (2, NULL), (3, e'multi\\nline')");
      const lines = db.query<{ copy: string }>("COPY t TO STDOUT").map((r) => r.copy);
      expect(lines).toEqual(["1\tx", "2\t\\N", "3\tmulti\\nline"]);
    },
  },
  {
    id: "CPY-to-02",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (a int, b text)");
      db.exec("INSERT INTO t VALUES (1, 'plain'), (2, 'a,b'), (3, NULL)");
      const lines = db.query<{ copy: string }>("COPY t TO STDOUT WITH (FORMAT csv)").map((r) => r.copy);
      expect(lines).toEqual(["1,plain", '2,"a,b"', "3,"]);
    },
  },
  {
    id: "CPY-to-03",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (a int, b text)");
      db.exec("INSERT INTO t VALUES (2, 'b'), (1, 'a')");
      const lines = db
        .query<{ copy: string }>("COPY (SELECT a * 10 AS a10, upper(b) FROM t ORDER BY a) TO STDOUT")
        .map((r) => r.copy);
      expect(lines).toEqual(["10\tA", "20\tB"]);
    },
  },
  {
    id: "CPY-to-04",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (a int, b text)");
      db.exec("INSERT INTO t VALUES (1, 'x')");
      expect(db.query<{ copy: string }>("COPY t (b) TO STDOUT").map((r) => r.copy)).toEqual(["x"]);
    },
  },
  {
    id: "CPY-rt-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE r (a int, b text, c numeric(10,2))");
      db.exec("INSERT INTO r VALUES (1, e'tabs\\tand\\nnewlines', 1.50), (2, NULL, NULL)");
      const dump = `${db
        .query<{ copy: string }>("COPY r TO STDOUT")
        .map((row) => row.copy)
        .join("\n")}\n`;
      db.exec("CREATE TABLE r2 (a int, b text, c numeric(10,2))");
      expect(db.copyFrom("COPY r2 FROM STDIN", dump)).toBe(2);
      expect(db.query("SELECT * FROM r2 ORDER BY a")).toEqual(db.query("SELECT * FROM r ORDER BY a"));
    },
  },
  {
    id: "CPY-api-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (a int, b text)");
      for (const sql of ["SELECT 1", "COPY t TO STDOUT", "COPY t FROM STDIN; COPY t FROM STDIN"]) {
        try {
          db.copyFrom(sql, "");
          expect.unreachable(`expected copyFrom to throw for: ${sql}`);
        } catch (err) {
          expect(err).toBeInstanceOf(PostgresError);
          expect((err as PostgresError).category).toBe("misuse");
        }
      }
    },
  },
]);
