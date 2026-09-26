import { parity } from "../helpers.ts";

parity("is null basics", [], "SELECT NULL IS NULL AS a, 1 IS NULL AS b, 'x' IS NULL AS c");
parity("is not null basics", [], "SELECT NULL IS NOT NULL AS a, 1 IS NOT NULL AS b");
parity("is null on expression result", [], "SELECT (NULL + 1) IS NULL AS a, (1 + 1) IS NULL AS b");
parity("is null on nullif", [], "SELECT nullif(1, 1) IS NULL AS v");
parity("row is null when all fields null", [], "SELECT ROW(NULL, NULL) IS NULL AS v");
parity("row is null when some fields null", [], "SELECT ROW(1, NULL) IS NULL AS a, ROW(1, NULL) IS NOT NULL AS b");
parity(
  "where is null filters",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (2, NULL), (3, 'c'), (4, NULL)"],
  "SELECT id FROM t WHERE v IS NULL ORDER BY id",
);
parity(
  "where is not null filters",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (2, NULL), (3, 'c')"],
  "SELECT id FROM t WHERE v IS NOT NULL ORDER BY id",
);
parity(
  "where equality drops nulls",
  ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (2, NULL)"],
  "SELECT id FROM t WHERE v = v ORDER BY id",
);
parity("coalesce with is null", [], "SELECT coalesce(NULL, NULL, 'x') IS NULL AS v");
