import { parity } from "../helpers.ts";

parity(
  "jsonb numeric ordering beyond float64 precision",
  [],
  `SELECT v FROM (VALUES
    ('999999999999999999999'::jsonb),
    ('1000000000000000000000'::jsonb),
    ('999999999999999999998'::jsonb)
  ) t(v) ORDER BY v`,
);

parity(
  "jsonb less-than on high-precision numbers",
  [],
  `SELECT
    ('999999999999999999998'::jsonb < '999999999999999999999'::jsonb) AS lt,
    ('1000000000000000000000'::jsonb > '999999999999999999999'::jsonb) AS gt`,
);

parity(
  "jsonb number order matches text tie-break for equal numeric value",
  [],
  `SELECT
    ('1.0'::jsonb < '1.00'::jsonb) AS lt,
    ('1.0'::jsonb = '1.00'::jsonb) AS eq`,
);
