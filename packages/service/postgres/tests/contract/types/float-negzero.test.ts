import { parity } from "../helpers.ts";

parity("float8 literal -0 is preserved", [], `SELECT '-0.0'::float8 AS v`);

parity(
  "float8 -0 compares equal to +0",
  [],
  `SELECT
    ('-0.0'::float8 = '0.0'::float8) AS eq,
    ('-0.0'::float8 <=> '0.0'::float8) AS spaceship`,
);

parity("float8 -0 text output preserves sign", [], `SELECT (-0.0::float8)::text AS v`);
