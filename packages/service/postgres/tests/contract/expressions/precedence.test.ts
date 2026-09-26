import { parity } from "../helpers.ts";

parity("multiplication before addition", [], "SELECT 2 + 3 * 4 AS a, (2 + 3) * 4 AS b");
parity("division and modulo left to right", [], "SELECT 100 / 10 / 2 AS a, 100 % 30 % 7 AS b");
parity("mixed multiplicative left to right", [], "SELECT 8 / 4 * 2 AS a, 8 * 4 / 2 AS b");
parity("subtraction left associative", [], "SELECT 10 - 4 - 3 AS v");
parity("exponent binds tighter than unary minus", [], "SELECT -2 ^ 2 AS v");
parity("exponent left associative", [], "SELECT 2 ^ 3 ^ 2 AS v");
parity("parentheses override", [], "SELECT 2 ^ (3 ^ 2) AS v");
parity("comparison binds looser than arithmetic", [], "SELECT 1 + 1 = 2 AS a, 3 * 2 > 5 AS b");
parity("not binds tighter than and", [], "SELECT NOT true AND false AS v");
parity("and binds tighter than or", [], "SELECT true OR true AND false AS v");
parity("concat left associative", [], "SELECT 'a' || 'b' || 'c' AS v");
parity("between binds tighter than and", [], "SELECT 5 BETWEEN 1 AND 10 AND true AS v");
parity("is null binds tighter than equality context", [], "SELECT (NULL IS NULL) = true AS v");
parity("unary minus applies before comparison", [], "SELECT -3 < 2 AS v");
