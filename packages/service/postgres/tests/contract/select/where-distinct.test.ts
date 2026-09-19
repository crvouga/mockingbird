import { parity, queryErrorParity } from "../helpers.ts";

// WHERE combinations
parity(
  "where equality",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'a')"],
  "SELECT id FROM t WHERE v = 'a' ORDER BY id",
);
parity(
  "where and / or combination",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd')"],
  "SELECT id FROM t WHERE (id > 1 AND id < 4) OR v = 'd' ORDER BY id",
);
parity(
  "where not",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1), (2), (3)"],
  "SELECT id FROM t WHERE NOT (id = 2) ORDER BY id",
);
parity(
  "where null comparison excludes rows",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (2, NULL)"],
  "SELECT id FROM t WHERE v = v ORDER BY id",
);
parity(
  "where is null",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (2, NULL), (3, NULL)"],
  "SELECT id FROM t WHERE v IS NULL ORDER BY id",
);
parity(
  "where in list",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1), (2), (3), (4), (5)"],
  "SELECT id FROM t WHERE id IN (2, 4, 99) ORDER BY id",
);
parity(
  "where between",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1), (2), (3), (4), (5)"],
  "SELECT id FROM t WHERE id BETWEEN 2 AND 4 ORDER BY id",
);
parity(
  "where like",
  ["CREATE TABLE t (v text)", "INSERT INTO t VALUES ('apple'), ('banana'), ('apricot')"],
  "SELECT v FROM t WHERE v LIKE 'ap%' ORDER BY v",
);
parity("where false literal", ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"], "SELECT id FROM t WHERE false");
parity(
  "where boolean column",
  ["CREATE TABLE t (id int, flag boolean)", "INSERT INTO t VALUES (1, true), (2, false), (3, NULL)"],
  "SELECT id FROM t WHERE flag ORDER BY id",
);

// DISTINCT
parity(
  "distinct single column",
  ["CREATE TABLE t (v text)", "INSERT INTO t VALUES ('a'), ('b'), ('a'), ('c'), ('b')"],
  "SELECT DISTINCT v FROM t ORDER BY v",
);
parity(
  "distinct multiple columns",
  ["CREATE TABLE t (a int, b int)", "INSERT INTO t VALUES (1, 1), (1, 2), (1, 1), (2, 1)"],
  "SELECT DISTINCT a, b FROM t ORDER BY a, b",
);
parity(
  "distinct treats nulls as equal",
  ["CREATE TABLE t (v int)", "INSERT INTO t VALUES (1), (NULL), (NULL), (1)"],
  "SELECT DISTINCT v FROM t ORDER BY v NULLS LAST",
);
parity(
  "distinct on expression",
  ["CREATE TABLE t (n int)", "INSERT INTO t VALUES (1), (2), (3), (4)"],
  "SELECT DISTINCT n % 2 AS m FROM t ORDER BY m",
);
parity(
  "select all keyword",
  ["CREATE TABLE t (v int)", "INSERT INTO t VALUES (1), (1)"],
  "SELECT ALL v FROM t ORDER BY v",
);

// errors
queryErrorParity(
  "undefined column in where",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
  "SELECT id FROM t WHERE nope = 1",
  "undefined_column",
);
queryErrorParity(
  "undefined column in target list",
  ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
  "SELECT nope FROM t",
  "undefined_column",
);
queryErrorParity("undefined table", [], "SELECT * FROM no_such_table", "undefined_table");
