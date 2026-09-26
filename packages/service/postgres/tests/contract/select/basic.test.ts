import { parity, parityTyped } from "../helpers.ts";

// FROM-less selects
parity("select integer literal", [], "SELECT 42 AS v");
parity("select negative integer", [], "SELECT -17 AS v");
parity("select text literal", [], "SELECT 'abc' AS v");
parity("select null literal", [], "SELECT NULL AS v");
parity("select multiple columns", [], "SELECT 1 AS a, 'x' AS b, true AS c");
parity("select without alias", [], "SELECT 1");
parity("select expression without alias", [], "SELECT 1 + 1");
parity("select boolean literals", [], "SELECT true AS t, false AS f");
parity("select numeric literal", [], "SELECT 3.14 AS v");
parity("select scientific notation", [], "SELECT 1e3 AS v");
parity("select quoted identifier alias", [], 'SELECT 1 AS "Mixed Case"');

// simple table selects
parity(
  "select star",
  ["CREATE TABLE t (id int, name text)", "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')"],
  "SELECT * FROM t ORDER BY id",
);
parity(
  "select specific columns",
  ["CREATE TABLE t (id int, name text, age int)", "INSERT INTO t VALUES (1, 'a', 30), (2, 'b', 25)"],
  "SELECT name, age FROM t ORDER BY name",
);
parity(
  "select column reordering",
  ["CREATE TABLE t (a int, b int)", "INSERT INTO t VALUES (1, 2)"],
  "SELECT b, a FROM t",
);
parity(
  "select column repeated",
  ["CREATE TABLE t (a int)", "INSERT INTO t VALUES (5)"],
  "SELECT a, a, a AS again FROM t",
);
parity(
  "select qualified star",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'x')"],
  "SELECT t.* FROM t",
);
parity("select qualified column", ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (7)"], "SELECT t.id FROM t");
parity("select from empty table", ["CREATE TABLE t (id int, v text)"], "SELECT * FROM t");

// typed literals
parityTyped("typed int", [], "SELECT 1 AS v");
parityTyped("typed bigint cast", [], "SELECT 1::bigint AS v");
parityTyped("typed text", [], "SELECT 'a' AS v");
parityTyped("typed bool", [], "SELECT true AS v");
parityTyped("typed numeric", [], "SELECT 1.25 AS v");
