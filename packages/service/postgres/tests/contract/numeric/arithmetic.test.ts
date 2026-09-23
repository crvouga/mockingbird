import { parity } from "../helpers.ts";

parity("big integer addition", [], "SELECT 12345678901234567890::numeric + 98765432109876543210::numeric AS v");
parity("big integer multiplication", [], "SELECT 12345678901234567890::numeric * 987654321::numeric AS v");
parity("high precision subtraction", [], "SELECT 1.00000000000000000001 - 1 AS v");
parity("numeric division default scale", [], "SELECT 1::numeric / 3 AS v");
parity("numeric division wide dividend", [], "SELECT 1000000::numeric / 7 AS v");
parity("scale addition on multiply", [], "SELECT 1.25 * 2.5 AS v");
parity("scale preserved on add", [], "SELECT 0.1 + 0.2 AS v");
parity("negative numeric arithmetic", [], "SELECT -1.5 * -2.5 AS a, -7.5 + 2.25 AS b");
parity("numeric unary minus and abs operator", [], "SELECT -(1.5::numeric) AS a, abs(-1.5::numeric) AS b");
parity("tiny fraction arithmetic", [], "SELECT 0.00000000000000000001 * 10 AS v");
parity("numeric modulo", [], "SELECT 10.5 % 3 AS a, -10.5 % 3 AS b");
parity("mixed numeric and int comparison", [], "SELECT 1.0 = 1 AS a, 2.5 > 2 AS b");
parity("exact decimal repeated add", [], "SELECT 0.1 + 0.1 + 0.1 AS v");
