import { parity } from "../helpers.ts";

parity("like percent wildcard", [], "SELECT 'abc' LIKE 'a%' AS a, 'abc' LIKE '%c' AS b, 'abc' LIKE '%b%' AS c");
parity("like underscore wildcard", [], "SELECT 'abc' LIKE 'a_c' AS a, 'abc' LIKE '___' AS b, 'abc' LIKE '____' AS c");
parity("like exact match no wildcards", [], "SELECT 'abc' LIKE 'abc' AS a, 'abc' LIKE 'ABC' AS b");
parity("not like", [], "SELECT 'abc' NOT LIKE 'a%' AS a, 'abc' NOT LIKE 'x%' AS b");
parity("ilike case insensitive", [], "SELECT 'ABC' ILIKE 'a%' AS a, 'abc' ILIKE 'A_C' AS b");
parity("not ilike", [], "SELECT 'ABC' NOT ILIKE 'a%' AS a, 'ABC' NOT ILIKE 'x%' AS b");
parity("like default backslash escape", [], "SELECT '50%' LIKE '50\\%' AS a, '50x' LIKE '50\\%' AS b");
parity("like escaped underscore", [], "SELECT 'a_c' LIKE 'a\\_c' AS a, 'abc' LIKE 'a\\_c' AS b");
parity("like custom escape clause", [], "SELECT '50%' LIKE '50#%' ESCAPE '#' AS a, '50x' LIKE '50#%' ESCAPE '#' AS b");
parity("like empty pattern and empty input", [], "SELECT '' LIKE '' AS a, 'a' LIKE '' AS b, '' LIKE '%' AS c");
parity("like with null", [], "SELECT 'abc' LIKE NULL AS a, NULL LIKE 'a%' AS b");
parity("like operator forms", [], "SELECT 'abc' ~~ 'a%' AS a, 'abc' !~~ 'a%' AS b, 'ABC' ~~* 'a%' AS c");
parity(
  "like in where clause",
  ["CREATE TABLE t (v text)", "INSERT INTO t VALUES ('apple'), ('banana'), ('cherry'), ('avocado')"],
  "SELECT v FROM t WHERE v LIKE 'a%' ORDER BY v",
);
parity("like percent matches empty", [], "SELECT 'abc' LIKE 'abc%' AS a, 'abc' LIKE '%abc' AS b");
