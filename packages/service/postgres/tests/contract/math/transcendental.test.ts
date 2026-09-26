import { parity, rankParity } from "../helpers.ts";

parity("sqrt exact and inexact", [], "SELECT sqrt(4::float8) AS a, sqrt(2::float8) AS b");
// Native libm cbrt(27) is not exactly 3.0 (prints 3.0000000000000004); JS Math.cbrt is exact.
rankParity("cbrt", [], "SELECT cbrt(27::float8) AS a, cbrt(-8::float8) AS b");
parity("exp basics", [], "SELECT exp(0::float8) AS a, exp(1::float8) AS b");
parity("ln float8", [], "SELECT ln(1::float8) AS a, ln(exp(1::float8)) AS b");
parity("log base ten", [], "SELECT log(100::float8) AS a, log(1000::numeric) AS b");
parity("log10 function", [], "SELECT log10(100::float8) AS a");
parity("power float8", [], "SELECT power(2::float8, 10) AS a, power(2::float8, -1) AS b");
parity("power zero to zero", [], "SELECT power(0::float8, 0) AS v");
parity("trig at zero", [], "SELECT sin(0::float8) AS a, cos(0::float8) AS b, tan(0::float8) AS c");
parity("inverse trig", [], "SELECT asin(1::float8) AS a, acos(1::float8) AS b, atan(1::float8) AS c");
parity("atan2", [], "SELECT atan2(1::float8, 1::float8) AS a, atan2(0::float8, -1::float8) AS b");
parity("hyperbolic functions", [], "SELECT sinh(0::float8) AS a, cosh(0::float8) AS b, tanh(0::float8) AS c");
parity("sind cosd degree variants", [], "SELECT sind(30::float8) AS a, cosd(60::float8) AS b, tand(45::float8) AS c");
