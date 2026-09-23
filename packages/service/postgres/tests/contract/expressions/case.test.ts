import { parity, parityTyped } from "../helpers.ts";

parity("searched case basic", [], "SELECT CASE WHEN 1 < 2 THEN 'yes' ELSE 'no' END AS v");
parity("searched case first match wins", [], "SELECT CASE WHEN true THEN 'a' WHEN true THEN 'b' END AS v");
parity("searched case no else yields null", [], "SELECT CASE WHEN false THEN 'x' END AS v");
parity("simple case basic", [], "SELECT CASE 2 WHEN 1 THEN 'one' WHEN 2 THEN 'two' ELSE 'many' END AS v");
parity("simple case falls to else", [], "SELECT CASE 9 WHEN 1 THEN 'one' ELSE 'many' END AS v");
parity("simple case null never matches", [], "SELECT CASE NULL::int WHEN 1 THEN 'one' ELSE 'other' END AS v");
parity("nested case", [], "SELECT CASE WHEN 1 = 1 THEN CASE WHEN 2 = 2 THEN 'inner' END ELSE 'outer' END AS v");
parity(
  "case with column input",
  ["CREATE TABLE t (v int)", "INSERT INTO t VALUES (1), (2), (3)"],
  "SELECT v, CASE WHEN v % 2 = 0 THEN 'even' ELSE 'odd' END AS parity FROM t ORDER BY v",
);
parity("case type resolution int and numeric", [], "SELECT CASE WHEN true THEN 1 ELSE 2.5 END AS v");
parityTyped("case result type numeric", [], "SELECT CASE WHEN false THEN 1 ELSE 2.5 END AS v");
parity("case short circuits division", [], "SELECT CASE WHEN 0 = 0 THEN 1 ELSE 1 / 0 END AS v");
parity(
  "case in where clause",
  ["CREATE TABLE t (v int)", "INSERT INTO t VALUES (1), (2), (3)"],
  "SELECT v FROM t WHERE CASE WHEN v > 1 THEN true ELSE false END ORDER BY v",
);
parity(
  "case with null branches",
  [],
  "SELECT CASE WHEN false THEN NULL ELSE 'val' END AS a, CASE WHEN true THEN NULL ELSE 'val' END AS b",
);
