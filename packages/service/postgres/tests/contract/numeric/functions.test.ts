import { parity } from "../helpers.ts";

parity("round half away from zero", [], "SELECT round(2.5) AS a, round(3.5) AS b, round(-2.5) AS c");
parity("round with scale", [], "SELECT round(1.2345, 2) AS a, round(1.2345, 3) AS b");
parity("round with negative scale", [], "SELECT round(12345.678, -2) AS a, round(12345.678, -5) AS b");
parity("trunc basic", [], "SELECT trunc(1.999) AS a, trunc(-1.999) AS b");
parity("trunc with scale", [], "SELECT trunc(1.2345, 2) AS a, trunc(-1.2345, 2) AS b");
parity("scale function", [], "SELECT scale(1.230) AS a, scale(100) AS b, scale(1::numeric) AS c");
parity("min_scale function", [], "SELECT min_scale(1.230) AS a, min_scale(100.000) AS b");
parity("trim_scale function", [], "SELECT trim_scale(1.230) AS a, trim_scale(100.000) AS b");
parity("div truncates toward zero", [], "SELECT div(9, 4) AS a, div(-9, 4) AS b, div(9.9, 3) AS c");
parity("mod numeric", [], "SELECT mod(9, 4) AS a, mod(-9, 4) AS b, mod(9.5, 3) AS c");
parity("sign numeric", [], "SELECT sign(-8.4) AS a, sign(0.0) AS b, sign(3.1) AS c");
parity("factorial function", [], "SELECT factorial(5) AS a, factorial(0) AS b, factorial(20) AS c");
parity("gcd integers", [], "SELECT gcd(12, 18) AS a, gcd(0, 5) AS b, gcd(0, 0) AS c, gcd(-12, 18) AS d");
parity("lcm integers", [], "SELECT lcm(4, 6) AS a, lcm(0, 5) AS b, lcm(-4, 6) AS c");
parity("width_bucket numeric", [], "SELECT width_bucket(5.35, 0.024, 10.06, 5) AS v");
