import { parity } from "../helpers.ts";

parity("row in list match", [], "SELECT (1, 2) IN ((1, 2), (3, 4)) AS v");
parity("row in list no match", [], "SELECT (1, 9) IN ((1, 2), (3, 4)) AS v");
parity("row not in list", [], "SELECT (1, 2) NOT IN ((1, 2), (3, 4)) AS a, (9, 9) NOT IN ((1, 2), (3, 4)) AS b");
parity("row in with mismatching first field", [], "SELECT (5, NULL) IN ((1, 2)) AS v");
parity(
  "row in used in where clause",
  ["CREATE TABLE t (a int, b text)", "INSERT INTO t VALUES (1, 'x'), (2, 'y'), (3, 'z')"],
  "SELECT a FROM t WHERE (a, b) IN ((1, 'x'), (3, 'z')) ORDER BY a",
);
parity("row between via comparisons", [], "SELECT (2, 0) >= (1, 9) AND (2, 0) <= (3, 0) AS v");
