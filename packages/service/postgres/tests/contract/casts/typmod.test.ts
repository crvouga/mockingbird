import { errorParity, parity } from "../helpers.ts";

parity("varchar(3) cast truncates silently", [], "SELECT 'abcdef'::varchar(3) AS v");
parity("char(3) cast truncates silently", [], "SELECT 'abcdef'::char(3) AS v");
parity("char(5) pads with spaces", [], "SELECT 'ab'::char(5) || '|' AS v");
parity("char length ignores padding", [], "SELECT length('ab'::char(5)) AS v");
parity("varchar cast keeps short values", [], "SELECT 'ab'::varchar(5) || '|' AS v");
parity("numeric typmod rounds to scale", [], "SELECT 123.456::numeric(5, 2) AS v");
parity("numeric typmod pads scale", [], "SELECT 123::numeric(5, 2) AS v");
parity("numeric typmod exact half rounds up", [], "SELECT 1.005::numeric(4, 2) AS v");
parity("numeric precision only drops fraction", [], "SELECT 12.7::numeric(3) AS v");
parity("varchar(3) allows trailing space trim on insert", ["CREATE TABLE t (v varchar(3))"], "SELECT 1 AS ok");
errorParity(
  "insert too long varchar errors",
  ["CREATE TABLE t (v varchar(3))"],
  "INSERT INTO t VALUES ('abcd')",
  "data_exception",
);
errorParity(
  "insert too long char errors",
  ["CREATE TABLE t (v char(3))"],
  "INSERT INTO t VALUES ('abcd')",
  "data_exception",
);
errorParity(
  "numeric field overflow on insert",
  ["CREATE TABLE t (v numeric(3, 1))"],
  "INSERT INTO t VALUES (100.0)",
  "numeric_out_of_range",
);
parity(
  "insert with trailing spaces trims to fit varchar",
  ["CREATE TABLE t (v varchar(3))", "INSERT INTO t VALUES ('abc   ')"],
  "SELECT v || '|' AS v FROM t",
);
