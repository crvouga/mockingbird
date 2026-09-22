import { parity } from "../helpers.ts";

parity("row constructor text output", [], "SELECT ROW(1, 'a') AS v");
parity("row output with null field", [], "SELECT ROW(1, NULL) AS v");
parity("row output quotes comma text", [], "SELECT ROW('a,b') AS v");
parity("row output quotes parens text", [], "SELECT ROW('(x)') AS v");
parity("row output escapes quotes", [], "SELECT ROW('say \"hi\"') AS v");
parity("row output empty string quoted", [], "SELECT ROW('') AS v");
parity("nested row output", [], "SELECT ROW(1, ROW(2, 3)) AS v");
parity("row with boolean and numeric", [], "SELECT ROW(true, 1.50) AS v");
parity("row single field", [], "SELECT ROW(42) AS v");
parity(
  "row constructor from columns",
  ["CREATE TABLE t (a int, b text)", "INSERT INTO t VALUES (1, 'x')"],
  "SELECT ROW(a, b) AS v FROM t",
);
parity(
  "whole row reference output",
  ["CREATE TABLE t (a int, b text)", "INSERT INTO t VALUES (1, 'x'), (2, NULL)"],
  "SELECT t FROM t ORDER BY a",
);
