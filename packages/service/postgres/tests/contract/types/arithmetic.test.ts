import { parity, parityTyped } from "../helpers.ts";

parityTyped("int2 plus int2 result type", [], "SELECT 1::int2 + 2::int2 AS v");
parityTyped("int2 plus int4 is int4", [], "SELECT 1::int2 + 2::int4 AS v");
parityTyped("int4 plus int8 is int8", [], "SELECT 1::int4 + 2::int8 AS v");
parityTyped("int4 plus numeric is numeric", [], "SELECT 1 + 2.5 AS v");
parityTyped("int4 plus float8 is float8", [], "SELECT 1 + 2.5::float8 AS v");
parityTyped("float4 plus float8 is float8", [], "SELECT 1::float4 + 2::float8 AS v");
parityTyped("numeric plus float8 is float8", [], "SELECT 1.5 + 2::float8 AS v");
parityTyped("int division result type", [], "SELECT 7 / 2 AS v");
parityTyped("numeric division result type", [], "SELECT 7.0 / 2 AS v");
parity("integer division truncates", [], "SELECT 7 / 2 AS a, -7 / 2 AS b, 7 / -2 AS c, -7 / -2 AS d");
parity("integer modulo sign follows dividend", [], "SELECT 7 % 3 AS a, -7 % 3 AS b, 7 % -3 AS c, -7 % -3 AS d");
parityTyped("modulo result type", [], "SELECT 7 % 3 AS v");
parity("unary minus of parenthesized expression", [], "SELECT -(3 + 4) AS v");
parityTyped("power operator type", [], "SELECT 2 ^ 3 AS v");
parity("power operator value", [], "SELECT 2 ^ 3 AS a, 2 ^ 10 AS b");
parity("mixed precedence arithmetic", [], "SELECT 2 + 3 * 4 - 5 / 5 AS v");
parity("numeric division keeps scale", [], "SELECT 7.0 / 2 AS a, 1.0 / 4 AS b");
