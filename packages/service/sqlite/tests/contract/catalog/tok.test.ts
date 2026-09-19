import { expect } from "bun:test";
import { runCatalog } from "./run.ts";

runCatalog("TOK", [
  { id: "TOK-01", kind: "parity", sql: "sElEcT 1 AS x" },
  {
    id: "TOK-02",
    kind: "parity",
    setup: ['CREATE TABLE "d"("c" INT)', 'INSERT INTO "d"("c") VALUES (1)'],
    sql: 'SELECT "c" FROM "d"',
  },
  {
    id: "TOK-03",
    kind: "parity",
    setup: ["CREATE TABLE t(`c` INT)", "INSERT INTO t(`c`) VALUES (2)"],
    sql: "SELECT `c` FROM t",
  },
  {
    id: "TOK-04",
    kind: "parity",
    setup: ["CREATE TABLE [t]([c] INT)", "INSERT INTO [t]([c]) VALUES (3)"],
    sql: "SELECT [c] FROM [t]",
  },
  {
    id: "TOK-05",
    kind: "parity",
    setup: ['CREATE TABLE "a""b"(x INT)', 'INSERT INTO "a""b" VALUES (4)'],
    sql: 'SELECT x FROM "a""b"',
  },
  {
    id: "TOK-06",
    kind: "parity",
    setup: ['CREATE TABLE "select"("order" INT)', 'INSERT INTO "select"("order") VALUES (5)'],
    sql: 'SELECT "order" FROM "select"',
  },
  {
    id: "TOK-07",
    kind: "divergence",
    fn: (db) => {
      expect(() => db.query('SELECT "not_a_column" AS v')).toThrow();
    },
  },
  { id: "TOK-08", kind: "parity", sql: "SELECT 'O''Reilly' AS v" },
  { id: "TOK-09", kind: "parity", sql: "SELECT 'a\nb' AS v" },
  { id: "TOK-10", kind: "parity", sql: "SELECT '' AS v" },
  { id: "TOK-11", kind: "parity", sql: "SELECT hex(x'610062') AS v" },
  { id: "TOK-12", kind: "parity", sql: "SELECT hex(x'') AS v" },
  { id: "TOK-13", kind: "parity", sql: "SELECT hex(X'ABCD') AS v" },
  {
    id: "TOK-14",
    kind: "error",
    sql: "SELECT X'ABC'",
    query: true,
    messageTier: "B",
    notes: "odd-hex wording varies by tokenizer",
  },
  { id: "TOK-15", kind: "parity", sql: "SELECT hex(x'abcd') AS v" },
  { id: "TOK-16", kind: "parity", sql: "SELECT 1 AS v, typeof(1) AS t" },
  { id: "TOK-17", kind: "parity", sql: "SELECT -1 AS v" },
  { id: "TOK-18", kind: "parity", sql: "SELECT 1.5 AS v, typeof(1.5) AS t" },
  { id: "TOK-19", kind: "parity", sql: "SELECT .5 AS v" },
  { id: "TOK-20", kind: "parity", sql: "SELECT 5. AS v" },
  { id: "TOK-21", kind: "parity", sql: "SELECT 1e10 AS v" },
  { id: "TOK-22", kind: "parity", sql: "SELECT 1E-10 AS v" },
  { id: "TOK-23", kind: "parity", sql: "SELECT 26 AS v" },
  { id: "TOK-24", kind: "parity", sql: "SELECT typeof(1e20) AS t" },
  { id: "TOK-25", kind: "parity", sql: "SELECT 007 AS v" },
  { id: "TOK-26", kind: "parity", sql: "SELECT typeof(9223372036854775807) AS t" },
  { id: "TOK-27", kind: "parity", sql: "SELECT typeof(1e19) AS t" },
  { id: "TOK-28", kind: "parity", sql: "SELECT 9e999 AS v, typeof(9e999) AS t" },
  {
    id: "TOK-29",
    kind: "sequence",
    setup: ["CREATE TABLE t(id INTEGER)"],
    steps: [{ sql: "-- comment\nINSERT INTO t VALUES (1)" }, { sql: "SELECT id FROM t", query: true }],
  },
  { id: "TOK-30", kind: "parity", sql: "SELECT 1 /* block */ AS v" },
  { id: "TOK-31", kind: "parity", sql: "SELECT 1 /* terminated */ AS v" },
  { id: "TOK-32", kind: "parity", sql: "SELECT /* mid */ 1 AS v" },
  { id: "TOK-33", kind: "parity", sql: "SELECT 1 /* comments around */ AS v" },
  {
    id: "TOK-34",
    kind: "parity",
    setup: ['CREATE TABLE t("αβ" INT)', 'INSERT INTO t("αβ") VALUES (1)'],
    sql: 'SELECT "αβ" FROM t',
  },
  { id: "TOK-35", kind: "parity", sql: "SELECT 'héllo 世界' AS v" },
  {
    id: "TOK-36",
    kind: "parity",
    setup: ['CREATE TABLE t("$x" INT, _y INT)', 'INSERT INTO t("$x", _y) VALUES (1,2)'],
    sql: 'SELECT "$x", _y FROM t',
  },
  { id: "TOK-37", kind: "parity", sql: "SELECT 1 AS v;" },
  {
    id: "TOK-38",
    kind: "sequence",
    setup: ["CREATE TABLE t(id INTEGER)"],
    steps: [{ sql: ";;INSERT INTO t VALUES (1);;" }, { sql: "SELECT id FROM t", query: true }],
  },
  {
    id: "TOK-39",
    kind: "sequence",
    setup: ["CREATE TABLE t(id INTEGER)"],
    steps: [{ sql: ";INSERT INTO t VALUES (1)" }, { sql: "SELECT id FROM t", query: true }],
  },
  {
    id: "TOK-40",
    kind: "divergence",
    fn: (db) => {
      expect(() => db.prepare("")).toThrow();
      expect(() => db.query("")).toThrow();
      db.exec("");
    },
  },
  { id: "TOK-41", kind: "parity", sql: "SELECT\t1 AS v" },
  { id: "TOK-42", kind: "parity", sql: "SELECT\r\n1 AS v" },
  { id: "TOK-43", kind: "parity", sql: "SELECT\f1 AS v" },
  { id: "TOK-44", kind: "parity", sql: "SELECT\v1 AS v" },
]);
