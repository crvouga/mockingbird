import { parity } from "../helpers.ts";

parity("null in arithmetic", [], "SELECT NULL + 1 AS a, 1 - NULL::int AS b, NULL::int * 0 AS c");
parity("null in division", [], "SELECT NULL / 0 AS v");
parity("null in string concat", [], "SELECT 'a' || NULL AS a, NULL || 'b' AS b");
parity("null in comparisons", [], "SELECT NULL::int = 1 AS a, NULL::int <> 1 AS b, NULL::int < 1 AS c");
parity("null compared to null", [], "SELECT NULL::int = NULL::int AS v");
parity(
  "string functions of null",
  [],
  "SELECT length(NULL::text) AS a, upper(NULL::text) AS b, substr(NULL::text, 1) AS c",
);
parity("math functions of null", [], "SELECT abs(NULL::int) AS a, sqrt(NULL::float8) AS b, round(NULL::numeric) AS c");
parity("null in like", [], "SELECT NULL LIKE 'a%' AS a, 'abc' LIKE NULL AS b");
parity("null in between", [], "SELECT NULL::int BETWEEN 1 AND 2 AS v");
parity("null cast propagates", [], "SELECT NULL::int::text AS a, NULL::text::numeric AS b");
parity("concat function treats null as empty", [], "SELECT concat('a', NULL, 'b') AS v");
parity("null with case", [], "SELECT CASE WHEN NULL THEN 'yes' ELSE 'no' END AS v");
parity("null boolean logic does not propagate absorbing", [], "SELECT NULL AND false AS a, NULL OR true AS b");
