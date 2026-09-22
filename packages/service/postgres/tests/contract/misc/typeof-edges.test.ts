import { parity } from "../helpers.ts";

parity("pg_typeof of untyped null", [], "SELECT pg_typeof(NULL)::text AS v");
parity("pg_typeof of typed null", [], "SELECT pg_typeof(NULL::int)::text AS a, pg_typeof(NULL::text)::text AS b");
parity("pg_typeof of unknown literal", [], "SELECT pg_typeof('hello')::text AS v");
parity("pg_typeof int plus numeric", [], "SELECT pg_typeof(1 + 1.5)::text AS v");
parity("pg_typeof of division", [], "SELECT pg_typeof(1 / 2)::text AS a, pg_typeof(1.0 / 2)::text AS b");
parity("pg_typeof of concat", [], "SELECT pg_typeof('a' || 'b')::text AS v");
parity("pg_typeof of comparison", [], "SELECT pg_typeof(1 = 1)::text AS v");
parity("pg_typeof of coalesce unknown and int", [], "SELECT pg_typeof(coalesce(NULL, 1))::text AS v");
parity("pg_typeof of extract", [], "SELECT pg_typeof(extract(year FROM date '2024-01-01'))::text AS v");
parity("pg_typeof of date arithmetic", [], "SELECT pg_typeof(date '2024-01-01' - date '2023-01-01')::text AS v");
parity("pg_typeof of interval multiply", [], "SELECT pg_typeof(interval '1 day' * 2)::text AS v");
parity("pg_typeof result is regtype", [], "SELECT pg_typeof(pg_typeof(1))::text AS v");
parity("pg_typeof of parameterless row", [], "SELECT pg_typeof(ROW(1, 2))::text AS v");
