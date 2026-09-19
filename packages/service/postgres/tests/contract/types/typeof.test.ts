import { parity, parityTyped } from "../helpers.ts";

parityTyped("pg_typeof int2 cast", [], "SELECT 1::int2 AS v");
parityTyped("pg_typeof int4", [], "SELECT 1::int4 AS v");
parityTyped("pg_typeof int8", [], "SELECT 1::int8 AS v");
parityTyped("pg_typeof float4", [], "SELECT 1::float4 AS v");
parityTyped("pg_typeof float8", [], "SELECT 1::float8 AS v");
parityTyped("pg_typeof numeric", [], "SELECT 1::numeric AS v");
parityTyped("pg_typeof text", [], "SELECT 'x'::text AS v");
parityTyped("pg_typeof varchar", [], "SELECT 'x'::varchar(10) AS v");
parityTyped("pg_typeof bpchar", [], "SELECT 'x'::char(3) AS v");
parityTyped("pg_typeof bool", [], "SELECT true AS v");
parity("pg_typeof of NULL", [], "SELECT pg_typeof(NULL)::text AS v");
parity("pg_typeof of string literal", [], "SELECT pg_typeof('x')::text AS v");
parity("pg_typeof sum is bigint", [], "SELECT pg_typeof(sum(v))::text AS t FROM (VALUES (1), (2)) AS x(v)");
parity("pg_typeof count", [], "SELECT pg_typeof(count(*))::text AS t FROM (VALUES (1)) AS x(v)");
parity("pg_typeof of pg_typeof", [], "SELECT pg_typeof(pg_typeof(1))::text AS v");
parity("pg_typeof avg int", [], "SELECT pg_typeof(avg(v))::text AS t FROM (VALUES (1), (2)) AS x(v)");
parity("pg_typeof avg float", [], "SELECT pg_typeof(avg(v))::text AS t FROM (VALUES (1.0::float8)) AS x(v)");
