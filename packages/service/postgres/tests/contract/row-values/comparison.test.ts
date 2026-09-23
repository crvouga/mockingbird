import { parity } from "../helpers.ts";

parity("row equality", [], "SELECT (1, 2) = (1, 2) AS a, (1, 2) = (1, 3) AS b");
parity("row inequality", [], "SELECT (1, 2) <> (1, 3) AS a, (1, 2) <> (1, 2) AS b");
parity("row less than lexicographic", [], "SELECT (1, 2) < (1, 3) AS a, (1, 2) < (2, 0) AS b, (2, 2) < (1, 9) AS c");
parity("row greater and equals variants", [], "SELECT (1, 2) >= (1, 2) AS a, (1, 3) > (1, 2) AS b");
parity("row equality with null yields null", [], "SELECT (1, NULL) = (1, 2) AS v");
parity("row equality null decided by first field", [], "SELECT (1, NULL) = (2, NULL) AS v");
parity("row comparison with mixed types", [], "SELECT (1, 'a') = (1, 'a') AS a, (1, 'a') < (1, 'b') AS b");
parity("row is distinct from", [], "SELECT (1, NULL) IS DISTINCT FROM (1, NULL) AS v");
parity("row is not distinct from", [], "SELECT (1, NULL) IS NOT DISTINCT FROM (1, NULL) AS v");
parity(
  "row comparison in where",
  ["CREATE TABLE t (a int, b int)", "INSERT INTO t VALUES (1, 1), (1, 2), (2, 1), (2, 2)"],
  "SELECT a, b FROM t WHERE (a, b) > (1, 1) ORDER BY a, b",
);
parity("explicit ROW keyword comparison", [], "SELECT ROW(1, 2) = ROW(1, 2) AS v");
