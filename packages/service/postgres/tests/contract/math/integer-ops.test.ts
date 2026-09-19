import { parity } from "../helpers.ts";

parity("integer division truncation table", [], "SELECT 9 / 4 AS a, -9 / 4 AS b, 9 / -4 AS c, -9 / -4 AS d");
parity("integer modulo table", [], "SELECT 9 % 4 AS a, -9 % 4 AS b, 9 % -4 AS c, -9 % -4 AS d");
parity("int8 division and modulo", [], "SELECT 9000000000 / 7 AS a, 9000000000 % 7 AS b");
parity("int2 division", [], "SELECT 9::int2 / 4::int2 AS a, 9::int2 % 4::int2 AS b");
parity("gcd int8", [], "SELECT gcd(9000000000, 6000000000) AS v");
parity("lcm int8", [], "SELECT lcm(9000000000, 6000000000) AS v");
parity("factorial as numeric", [], "SELECT factorial(10) AS v");
parity("bitwise and or xor", [], "SELECT 12 & 10 AS a, 12 | 10 AS b, 12 # 10 AS c");
parity("bitwise not and shifts", [], "SELECT ~5 AS a, 1 << 8 AS b, 256 >> 4 AS c");
parity("bitwise on int8", [], "SELECT 5000000000 & 1 AS a, 1::int8 << 40 AS b");
parity("division identity with mod", [], "SELECT (17 / 5) * 5 + (17 % 5) AS v");
parity("negative division identity with mod", [], "SELECT (-17 / 5) * 5 + (-17 % 5) AS v");
parity("mod function int", [], "SELECT mod(17, 5) AS a, mod(-17, 5) AS b");
