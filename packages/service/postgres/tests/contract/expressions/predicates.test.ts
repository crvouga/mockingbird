import { parity, queryErrorParity } from "../helpers.ts";

parity("is distinct from basics", [], "SELECT 1 IS DISTINCT FROM 2 AS a, 1 IS DISTINCT FROM 1 AS b");
parity("is distinct from with nulls", [], "SELECT NULL IS DISTINCT FROM NULL AS a, 1 IS DISTINCT FROM NULL AS b");
parity("is not distinct from", [], "SELECT NULL IS NOT DISTINCT FROM NULL AS a, 1 IS NOT DISTINCT FROM 1 AS b");
parity("between basic", [], "SELECT 5 BETWEEN 1 AND 10 AS a, 0 BETWEEN 1 AND 10 AS b, 1 BETWEEN 1 AND 10 AS c");
parity("between reversed bounds is false", [], "SELECT 5 BETWEEN 10 AND 1 AS v");
parity("between symmetric", [], "SELECT 5 BETWEEN SYMMETRIC 10 AND 1 AS a, 0 BETWEEN SYMMETRIC 10 AND 1 AS b");
parity("not between", [], "SELECT 5 NOT BETWEEN 1 AND 10 AS a, 15 NOT BETWEEN 1 AND 10 AS b");
parity("between with null bound", [], "SELECT 5 BETWEEN 1 AND NULL AS a, 0 BETWEEN 1 AND NULL AS b");
parity("between on text", [], "SELECT 'bb' BETWEEN 'aa' AND 'cc' AS v");
parity("in list basic", [], "SELECT 2 IN (1, 2, 3) AS a, 9 IN (1, 2, 3) AS b");
parity("not in list", [], "SELECT 2 NOT IN (1, 2, 3) AS a, 9 NOT IN (1, 2, 3) AS b");
parity("in list with expressions", [], "SELECT 4 IN (1 + 1, 2 * 2) AS v");
parity("in list of texts", [], "SELECT 'b' IN ('a', 'b') AS a, 'z' IN ('a', 'b') AS b");
parity("operator precedence multiplication before comparison", [], "SELECT 2 + 3 * 4 = 14 AS v");
parity("exponent precedence", [], "SELECT 2 ^ 3 ^ 2 AS v, -2 ^ 2 AS w");
parity("unary minus precedence with multiplication", [], "SELECT -2 * 3 AS a, 2 * -3 AS b");
queryErrorParity("boolean plus integer is invalid", [], "SELECT true + 1", "undefined_function");
