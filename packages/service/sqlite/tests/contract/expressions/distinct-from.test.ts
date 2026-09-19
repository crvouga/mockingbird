import { parity } from "../helpers.ts";

parity(
  "IS DISTINCT FROM nulls",
  [],
  `
  SELECT
    NULL IS DISTINCT FROM NULL AS a,
    NULL IS DISTINCT FROM 1 AS b,
    1 IS DISTINCT FROM 1 AS c`,
);
parity(
  "IS NOT DISTINCT FROM",
  [],
  `
  SELECT
    NULL IS NOT DISTINCT FROM NULL AS a,
    1 IS NOT DISTINCT FROM 1.0 AS b`,
);
