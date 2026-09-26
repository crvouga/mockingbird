import { parity, parityTyped } from "../helpers.ts";

// type resolution across branches
parityTyped("int and numeric resolve to numeric", [], "SELECT 1 AS v UNION ALL SELECT 2.5 ORDER BY v");
parityTyped("int and bigint resolve to bigint", [], "SELECT 1 AS v UNION ALL SELECT 2::bigint ORDER BY v");
parityTyped("text branches stay text", [], "SELECT 'a' AS v UNION ALL SELECT 'b' ORDER BY v");
parity("numeric widening result values", [], "SELECT 1 AS v UNION ALL SELECT 1.5 ORDER BY v");
parity("union dedupe across numeric types", [], "SELECT 1 AS v UNION SELECT 1.0 ORDER BY v");

// nesting and precedence
parity("intersect binds tighter than union", [], "SELECT 1 AS v UNION SELECT 2 INTERSECT SELECT 2 ORDER BY v");
parity(
  "parentheses change set-op grouping",
  [],
  "SELECT * FROM ((SELECT 1 AS v UNION SELECT 2) INTERSECT SELECT 2) s ORDER BY v",
);
parity(
  "except is left associative",
  [],
  "SELECT v FROM (VALUES (1), (2), (3)) t(v) EXCEPT SELECT 2 EXCEPT SELECT 3 ORDER BY v",
);
parity(
  "nested parenthesized except",
  [],
  "SELECT v FROM (VALUES (1), (2), (3)) t(v) EXCEPT (SELECT 2 EXCEPT SELECT 2) ORDER BY v",
);
parity("three-way chained union all", [], "SELECT 1 AS v UNION ALL SELECT 2 UNION ALL SELECT 3 ORDER BY v");
parity(
  "union inside subquery",
  ["CREATE TABLE t (v int)", "INSERT INTO t VALUES (5)"],
  "SELECT * FROM (SELECT v FROM t UNION SELECT 6) s ORDER BY v",
);
parity(
  "union branch with where and join",
  [
    "CREATE TABLE a (id int, v text)",
    "CREATE TABLE b (id int, v text)",
    "INSERT INTO a VALUES (1, 'x'), (2, 'y')",
    "INSERT INTO b VALUES (2, 'y'), (3, 'z')",
  ],
  "SELECT a.v FROM a JOIN b ON a.id = b.id UNION SELECT v FROM b WHERE id = 3 ORDER BY v",
);
