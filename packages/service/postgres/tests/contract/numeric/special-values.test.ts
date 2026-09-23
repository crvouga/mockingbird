import { parity } from "../helpers.ts";

parity("numeric NaN literal", [], "SELECT 'NaN'::numeric::text AS v, 'nan'::numeric::text AS w");
parity("numeric infinity literals", [], "SELECT 'Infinity'::numeric::text AS a, '-Infinity'::numeric::text AS b");
parity("numeric inf shorthand", [], "SELECT 'inf'::numeric::text AS a, '-inf'::numeric::text AS b");
parity("NaN equals NaN in numeric", [], "SELECT 'NaN'::numeric = 'NaN'::numeric AS v");
parity("NaN sorts above infinity", [], "SELECT 'NaN'::numeric > 'Infinity'::numeric AS v");
parity("infinity arithmetic", [], "SELECT 'Infinity'::numeric + 1 AS a, 'Infinity'::numeric * -1 AS b");
parity("infinity minus infinity is NaN", [], "SELECT 'Infinity'::numeric - 'Infinity'::numeric AS v");
parity("NaN propagates through arithmetic", [], "SELECT 'NaN'::numeric + 1 AS a, 'NaN'::numeric * 0 AS b");
parity(
  "order by numeric with specials",
  ["CREATE TABLE t (v numeric)", "INSERT INTO t VALUES (1), ('NaN'), ('-Infinity'), ('Infinity'), (0), (-5)"],
  "SELECT v::text FROM t ORDER BY v",
);
parity("float8 NaN comparisons", [], "SELECT 'NaN'::float8 = 'NaN'::float8 AS a, 'NaN'::float8 > 1e308 AS b");
parity("float8 infinity arithmetic", [], "SELECT 'Infinity'::float8 + 1 AS a, 1 / 'Infinity'::float8 AS b");
parity("float8 infinity times zero is NaN", [], "SELECT ('Infinity'::float8 * 0)::text AS v");
parity("numeric zero signs", [], "SELECT 0.0::text AS a, '-0.0'::numeric::text AS b, -0.0 = 0.0 AS c");
