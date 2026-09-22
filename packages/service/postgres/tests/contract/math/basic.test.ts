import { parity, rankParity } from "../helpers.ts";

parity("abs variants", [], "SELECT abs(-5) AS a, abs(5) AS b, abs(-5.5) AS c, abs(-5.5::float8) AS d");
parity("ceil and ceiling", [], "SELECT ceil(1.1) AS a, ceiling(1.1) AS b, ceil(-1.1) AS c, ceil(2.0) AS d");
parity("floor", [], "SELECT floor(1.9) AS a, floor(-1.1) AS b, floor(2.0) AS c");
parity("ceil floor on float8", [], "SELECT ceil(1.1::float8) AS a, floor(-1.1::float8) AS b");
parity("sign on int and float", [], "SELECT sign(-3) AS a, sign(0) AS b, sign(2.5::float8) AS c");
parity("trunc float8", [], "SELECT trunc(1.7::float8) AS a, trunc(-1.7::float8) AS b");
parity("pi constant", [], "SELECT pi() AS v");
parity("degrees and radians", [], "SELECT degrees(pi()) AS a, radians(180::float8) AS b");
parity("greatest least numeric", [], "SELECT greatest(1, 2.5, 0) AS a, least(1, 2.5, 0) AS b");
parity("square root operator", [], "SELECT |/ 25.0 AS v");
// Same libm drift as cbrt(): native PG ||/ 27 is not bit-exact 3.0.
rankParity("cube root operator", [], "SELECT ||/ 27.0 AS v");
parity("float8 exponent operator", [], "SELECT 2.0::float8 ^ 10 AS a, 4.0::float8 ^ 0.5 AS b");
parity("round on int is identity", [], "SELECT round(5) AS a, ceil(5) AS b, floor(5) AS c");
