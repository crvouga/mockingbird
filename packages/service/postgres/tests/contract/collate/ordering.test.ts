import { parity } from "../helpers.ts";

parity(
  "order by lowercase ascii",
  ["CREATE TABLE t (v text)", "INSERT INTO t VALUES ('banana'), ('apple'), ('cherry')"],
  "SELECT v FROM t ORDER BY v",
);
parity(
  "order by mixed case with collate c",
  ["CREATE TABLE t (v text)", "INSERT INTO t VALUES ('Banana'), ('apple'), ('Cherry'), ('banana')"],
  'SELECT v FROM t ORDER BY v COLLATE "C"',
);
parity(
  "order by digits and letters collate c",
  ["CREATE TABLE t (v text)", "INSERT INTO t VALUES ('a1'), ('1a'), ('A1'), ('11')"],
  'SELECT v FROM t ORDER BY v COLLATE "C"',
);
parity(
  "order by desc collate c",
  ["CREATE TABLE t (v text)", "INSERT INTO t VALUES ('x'), ('X'), ('y')"],
  'SELECT v FROM t ORDER BY v COLLATE "C" DESC',
);
parity(
  "order by length ties broken by text",
  ["CREATE TABLE t (v text)", "INSERT INTO t VALUES ('bb'), ('aa'), ('c')"],
  'SELECT v FROM t ORDER BY length(v), v COLLATE "C"',
);
parity(
  "order by prefix shorter first",
  ["CREATE TABLE t (v text)", "INSERT INTO t VALUES ('abc'), ('ab'), ('abcd')"],
  "SELECT v FROM t ORDER BY v",
);
parity(
  "order by with empty string",
  ["CREATE TABLE t (v text)", "INSERT INTO t VALUES ('a'), (''), ('b')"],
  "SELECT v FROM t ORDER BY v",
);
parity(
  "min max text collate c",
  ["CREATE TABLE t (v text)", "INSERT INTO t VALUES ('pear'), ('fig'), ('apple')"],
  "SELECT min(v) AS lo, max(v) AS hi FROM t",
);
