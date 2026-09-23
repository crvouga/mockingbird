import { parity } from "../helpers.ts";

// arithmetic and precedence
parity("arithmetic precedence", [], "SELECT 2 + 3 * 4 AS v");
parity("parenthesized arithmetic", [], "SELECT (2 + 3) * 4 AS v");
parity("integer division truncates", [], "SELECT 7 / 2 AS v");
parity("modulo", [], "SELECT 7 % 3 AS v");
parity("unary minus", [], "SELECT -(2 + 3) AS v");
parity("exponent operator", [], "SELECT 2 ^ 10 AS v");
parity("numeric division", [], "SELECT 7.0 / 2 AS v");

// comparison and boolean logic
parity("comparison operators", [], "SELECT 1 < 2 AS a, 2 <= 2 AS b, 3 > 2 AS c, 3 >= 4 AS d, 1 = 1 AS e, 1 <> 2 AS f");
parity("not-equals bang form", [], "SELECT 1 != 2 AS v");
parity("and or not", [], "SELECT true AND false AS a, true OR false AS b, NOT true AS c");
parity("null propagation in comparison", [], "SELECT NULL = 1 AS a, NULL <> 1 AS b, NULL AND true AS c");
parity("is null / is not null", [], "SELECT NULL IS NULL AS a, 1 IS NULL AS b, NULL IS NOT NULL AS c");
parity(
  "is distinct from",
  [],
  "SELECT NULL IS DISTINCT FROM NULL AS a, 1 IS DISTINCT FROM NULL AS b, 1 IS NOT DISTINCT FROM 1 AS c",
);
parity("is true / is false", [], "SELECT NULL IS TRUE AS a, true IS TRUE AS b, false IS NOT TRUE AS c");

// CASE
parity("simple case", [], "SELECT CASE 2 WHEN 1 THEN 'one' WHEN 2 THEN 'two' ELSE 'many' END AS v");
parity("searched case", [], "SELECT CASE WHEN 1 > 2 THEN 'a' WHEN 2 > 1 THEN 'b' END AS v");
parity("case without else yields null", [], "SELECT CASE WHEN false THEN 1 END AS v");
parity(
  "case over rows",
  ["CREATE TABLE t (n int)", "INSERT INTO t VALUES (1), (2), (3)"],
  "SELECT n, CASE WHEN n % 2 = 0 THEN 'even' ELSE 'odd' END AS parity FROM t ORDER BY n",
);

// conditional functions
parity("coalesce", [], "SELECT coalesce(NULL, NULL, 3) AS v");
parity("nullif", [], "SELECT nullif(1, 1) AS a, nullif(1, 2) AS b");
parity("greatest and least", [], "SELECT greatest(1, 5, 3) AS g, least(1, 5, 3) AS l");
parity("greatest with nulls", [], "SELECT greatest(NULL, 2, NULL) AS g, least(NULL, 2) AS l");

// string expressions
parity("string concat operator", [], "SELECT 'foo' || 'bar' AS v");
parity("between", [], "SELECT 5 BETWEEN 1 AND 10 AS a, 5 BETWEEN 6 AND 10 AS b, 5 NOT BETWEEN 6 AND 10 AS c");
parity("in list", [], "SELECT 2 IN (1, 2, 3) AS a, 5 IN (1, 2, 3) AS b, 5 NOT IN (1, 2, 3) AS c");
parity("in list with null", [], "SELECT 5 IN (1, NULL) AS a, 1 IN (1, NULL) AS b");
parity("like and ilike", [], "SELECT 'hello' LIKE 'he%' AS a, 'HELLO' ILIKE 'he%' AS b, 'hello' NOT LIKE 'x%' AS c");

// casts
parity("cast syntax variants", [], "SELECT CAST('42' AS int) AS a, '42'::int AS b, int '42' AS c");
parity("cast to text", [], "SELECT 42::text AS v");
parity("cast numeric to int rounds", [], "SELECT 2.5::int AS a, 3.5::int AS b, (-2.5)::int AS c");
parity("cast bool to text", [], "SELECT true::text AS a, false::text AS b");
