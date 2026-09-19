import { parity } from "../helpers.ts";

// table aliases
parity(
  "table alias",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (2, 'b')"],
  "SELECT x.id, x.v FROM t AS x ORDER BY x.id",
);
parity(
  "table alias without AS keyword",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (3)"],
  "SELECT x.id FROM t x",
);
parity(
  "table alias with column aliases",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (2, 'b')"],
  "SELECT a, b FROM t AS x(a, b) ORDER BY a",
);
parity(
  "alias hides original name",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
  "SELECT x.id FROM t AS x WHERE x.id = 1",
);

// VALUES lists
parity("values single row", [], "SELECT * FROM (VALUES (1, 'a')) AS v(n, s)");
parity("values multiple rows", [], "SELECT * FROM (VALUES (1, 'a'), (2, 'b'), (3, 'c')) AS v(n, s) ORDER BY n");
parity("values default column names", [], "SELECT column1, column2 FROM (VALUES (10, 20)) AS v");
parity("bare values statement", [], "VALUES (1, 'x'), (2, 'y') ORDER BY 1");
parity("values with expressions", [], "SELECT * FROM (VALUES (1 + 1, upper('a'))) AS v(n, s)");
parity(
  "values with nulls type resolution",
  [],
  "SELECT * FROM (VALUES (1, NULL), (NULL, 'b')) AS v(n, s) ORDER BY n NULLS LAST",
);

// subquery in FROM
parity(
  "subquery in from",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')"],
  "SELECT * FROM (SELECT id * 10 AS big, v FROM t) AS sub ORDER BY big",
);
parity(
  "subquery in from with column aliases",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1), (2)"],
  "SELECT n FROM (SELECT id FROM t) AS sub(n) ORDER BY n",
);
parity(
  "nested subqueries in from",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1), (2), (3)"],
  "SELECT * FROM (SELECT * FROM (SELECT id FROM t WHERE id > 1) AS inner1) AS outer1 ORDER BY id",
);
parity(
  "subquery in from with where outside",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')"],
  "SELECT v FROM (SELECT id, v FROM t) AS s WHERE s.id >= 2 ORDER BY v",
);
parity("from-less subquery", [], "SELECT * FROM (SELECT 1 AS a, 2 AS b) AS s");

// multiple FROM items (implicit cross join)
parity(
  "comma-separated from items",
  [
    "CREATE TABLE a (x int)",
    "CREATE TABLE b (y int)",
    "INSERT INTO a VALUES (1), (2)",
    "INSERT INTO b VALUES (10), (20)",
  ],
  "SELECT x, y FROM a, b ORDER BY x, y",
);
