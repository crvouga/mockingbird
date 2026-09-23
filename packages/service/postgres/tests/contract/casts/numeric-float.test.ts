import { parity, parityTyped } from "../helpers.ts";

parity("float4 rounds to single precision", [], "SELECT 0.1::float4 AS v");
parity("float4 to float8 keeps float4 value", [], "SELECT 0.1::float4::float8 AS v");
parity("float8 text output shortest roundtrip", [], "SELECT (1.0 / 3.0::float8)::text AS v");
parity("float special text inputs", [], "SELECT 'NaN'::float8::text AS a, 'Infinity'::float8::text AS b");
parity("float negative infinity", [], "SELECT '-Infinity'::float8::text AS v, '-inf'::float8::text AS w");
parity("float infinity case insensitive", [], "SELECT 'INFINITY'::float8::text AS a, 'nan'::float8::text AS b");
parity("numeric to float4 precision loss", [], "SELECT 1.23456789::float4 AS v");
parity("large float8 exponent output", [], "SELECT 1e30::float8::text AS a, 1e-30::float8::text AS b");
parity("float8 integral output", [], "SELECT 100000::float8::text AS a, 3.0::float8::text AS b");
parity("numeric keeps trailing zeros float drops", [], "SELECT 1.50::text AS a, 1.50::float8::text AS b");
parityTyped("float8 division type", [], "SELECT 1::float8 / 3 AS v");
parity("float equality after float4 narrowing", [], "SELECT 0.5::float4 = 0.5::float8 AS v");
parity("negative zero float8", [], "SELECT '-0'::float8::text AS a, '-0'::float8 = '0'::float8 AS b");
parity(
  "float8 min normal magnitudes",
  [],
  "SELECT 5e-324::float8::text AS tiny, 1.7976931348623157e308::float8 AS big",
);
