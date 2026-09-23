import { parity } from "../helpers.ts";

parity("null in in-list yields null when no match", [], "SELECT 5 IN (1, 2, NULL) AS v");
parity("in list matches despite null", [], "SELECT 1 IN (1, NULL) AS v");
parity("not in with null is never true", [], "SELECT 5 NOT IN (1, 2, NULL) AS a, 1 NOT IN (1, NULL) AS b");
parity("null lhs of in", [], "SELECT NULL::int IN (1, 2) AS v");
parity(
  "count star counts nulls count col does not",
  ["CREATE TABLE t (v int)", "INSERT INTO t VALUES (1), (NULL), (3), (NULL)"],
  "SELECT count(*) AS a, count(v) AS b FROM t",
);
parity(
  "sum avg ignore nulls",
  ["CREATE TABLE t (v int)", "INSERT INTO t VALUES (2), (NULL), (4)"],
  "SELECT sum(v) AS s, avg(v) AS a FROM t",
);
parity(
  "min max ignore nulls",
  ["CREATE TABLE t (v int)", "INSERT INTO t VALUES (5), (NULL), (1)"],
  "SELECT min(v) AS lo, max(v) AS hi FROM t",
);
parity(
  "aggregates on all null column",
  ["CREATE TABLE t (v int)", "INSERT INTO t VALUES (NULL), (NULL)"],
  "SELECT count(v) AS c, sum(v) AS s, min(v) AS lo FROM t",
);
parity("sum over empty table is null", ["CREATE TABLE t (v int)"], "SELECT sum(v) AS s, count(*) AS c FROM t");
parity(
  "in subquery with nulls",
  ["CREATE TABLE t (v int)", "INSERT INTO t VALUES (1), (NULL)"],
  "SELECT 5 IN (SELECT v FROM t) AS a, 1 IN (SELECT v FROM t) AS b",
);
parity(
  "not in subquery with nulls",
  ["CREATE TABLE t (v int)", "INSERT INTO t VALUES (1), (NULL)"],
  "SELECT 5 NOT IN (SELECT v FROM t) AS v",
);
