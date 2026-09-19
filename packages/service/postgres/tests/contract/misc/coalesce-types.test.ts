import { parityTyped } from "../helpers.ts";

parityTyped("coalesce unknown and int resolves int", [], "SELECT coalesce(NULL, 42) AS v");
parityTyped("coalesce all unknown resolves text", [], "SELECT coalesce('a', 'b') AS v");
parityTyped("coalesce varchar and text", [], "SELECT coalesce('a'::varchar(5), 'b'::text) AS v");
parityTyped("union resolves common type", [], "SELECT v FROM (SELECT 1 AS v UNION ALL SELECT 2.5) AS q");
parityTyped("greatest resolves common type", [], "SELECT greatest(1::int8, 2::int2) AS v");
parityTyped("nullif keeps unified type when first returned", [], "SELECT nullif(1.5, 2) AS v");
parityTyped("coalesce text and unknown", [], "SELECT coalesce('x'::text, 'y') AS v");
parityTyped("least resolves common type", [], "SELECT least(2.5, 3) AS v");
