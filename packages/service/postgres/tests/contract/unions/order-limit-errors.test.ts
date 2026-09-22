import { parity, queryErrorParity } from "../helpers.ts";

// ORDER BY / LIMIT on set operations
parity("order by applies to whole union", [], "SELECT 3 AS v UNION SELECT 1 UNION SELECT 2 ORDER BY v");
parity("order by desc on union", [], "SELECT 1 AS v UNION SELECT 2 UNION SELECT 3 ORDER BY v DESC");
parity(
  "limit applies to whole union",
  [],
  "SELECT v FROM (VALUES (1), (2)) a(v) UNION ALL SELECT v FROM (VALUES (3), (4)) b(v) ORDER BY v LIMIT 3",
);
parity("offset on union", [], "SELECT v FROM (VALUES (1), (2), (3), (4)) t(v) UNION SELECT 5 ORDER BY v OFFSET 2");
parity("order by ordinal on union", [], "SELECT 2 AS a, 'x' AS b UNION SELECT 1, 'y' ORDER BY 1");
parity(
  "parenthesized branch with inner order and limit",
  ["CREATE TABLE t (v int)", "INSERT INTO t VALUES (5), (1), (9), (3)"],
  "(SELECT v FROM t ORDER BY v LIMIT 2) UNION ALL SELECT 100 ORDER BY v",
);
parity(
  "both branches parenthesized with limits",
  ["CREATE TABLE t (v int)", "INSERT INTO t VALUES (1), (2), (3)"],
  "(SELECT v FROM t ORDER BY v ASC LIMIT 1) UNION ALL (SELECT v FROM t ORDER BY v DESC LIMIT 1) ORDER BY v",
);
parity(
  "order by column name from first branch",
  [],
  "SELECT 1 AS total UNION SELECT 3 UNION SELECT 2 ORDER BY total DESC",
);

// errors
queryErrorParity("union column count mismatch", [], "SELECT 1, 2 UNION SELECT 3", "syntax");
queryErrorParity("union all column count mismatch", [], "SELECT 1 UNION ALL SELECT 1, 2", "syntax");
queryErrorParity("intersect column count mismatch", [], "SELECT 1, 2 INTERSECT SELECT 1", "syntax");
queryErrorParity("except column count mismatch", [], "SELECT 1 EXCEPT SELECT 1, 2", "syntax");
queryErrorParity(
  "order by references branch-only column",
  ["CREATE TABLE t (a int, b int)", "INSERT INTO t VALUES (1, 2)"],
  "SELECT a FROM t UNION SELECT a FROM t ORDER BY b",
  "undefined_column",
);
