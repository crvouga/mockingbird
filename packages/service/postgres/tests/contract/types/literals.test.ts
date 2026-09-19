import { parity, parityTyped, queryErrorParity } from "../helpers.ts";

parity("boolean literals", [], "SELECT true AS t, false AS f");
parity(
  "boolean text casts",
  [],
  "SELECT 't'::bool AS a, 'f'::bool AS b, 'yes'::bool AS c, 'no'::bool AS d, 'on'::bool AS e, 'off'::bool AS f",
);
parity("boolean mixed case and whitespace", [], "SELECT 'TRUE'::bool AS a, 'False'::bool AS b, '  t  '::bool AS c");
parity("boolean 1 and 0 text", [], "SELECT '1'::bool AS a, '0'::bool AS b");
parity("integer literals", [], "SELECT 0 AS a, 42 AS b, -17 AS c, +5 AS d");
parity("int8 extremes", [], "SELECT 9223372036854775807 AS hi, -9223372036854775807 AS lo");
parity("numeric literal with fraction", [], "SELECT 3.14159 AS v, -0.5 AS w, .25 AS x");
parity("scientific notation", [], "SELECT 1e3 AS a, 1.5e-2 AS b, 2E+4 AS c");
parity("text literal with quote escape", [], "SELECT 'it''s' AS v");
parity("varchar and char literals", [], "SELECT 'abc'::varchar AS a, 'abc'::char(5) AS b");
parity("float literals", [], "SELECT 1.5::float8 AS a, 1.5::float4 AS b, '1.5'::real AS c");
parityTyped("bare integer is int4", [], "SELECT 42 AS v");
parityTyped("big literal is int8", [], "SELECT 3000000000 AS v");
parityTyped("huge literal is numeric", [], "SELECT 99999999999999999999 AS v");
parityTyped("fraction literal is numeric", [], "SELECT 1.5 AS v");
queryErrorParity("trailing garbage int cast", [], "SELECT '12abc'::int", "invalid_text_representation");
queryErrorParity("empty string int cast", [], "SELECT ''::int", "invalid_text_representation");
