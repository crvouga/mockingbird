import { parity } from "../helpers.ts";

parity("-> extracts an object field as jsonb", [], `SELECT '{"a":{"b":1}}'::jsonb -> 'a' AS v`);

parity("->> extracts an object field as text", [], `SELECT '{"a":{"b":1}}'::jsonb ->> 'a' AS v`);

parity("-> with an integer index on an array", [], `SELECT '[10,20,30]'::jsonb -> 1 AS v`);

parity("->> with a negative index counts from the end", [], `SELECT '[10,20,30]'::jsonb ->> -1 AS v`);

parity("-> missing key yields NULL", [], `SELECT '{"a":1}'::jsonb -> 'zzz' IS NULL AS v`);

parity("->> out-of-range index yields NULL", [], `SELECT '[1,2]'::jsonb ->> 5 IS NULL AS v`);

parity("#> extracts a nested path", [], `SELECT '{"a":{"b":[1,2]}}'::jsonb #> '{a,b,1}' AS v`);

parity("#>> extracts a nested path as text", [], `SELECT '{"a":{"b":1}}'::jsonb #>> '{a,b}' AS v`);

parity("#> with a missing path yields NULL", [], `SELECT '{"a":1}'::jsonb #> '{x,y}' IS NULL AS v`);

parity("@> object containment", [], `SELECT '{"a":1,"b":2}'::jsonb @> '{"a":1}'::jsonb AS v`);

parity("@> array containment ignores order", [], `SELECT '[1,2,3]'::jsonb @> '[3,1]'::jsonb AS v`);

parity("@> nested containment", [], `SELECT '{"a":{"b":1,"c":2}}'::jsonb @> '{"a":{"b":1}}'::jsonb AS v`);

parity("@> false when not contained", [], `SELECT '{"a":1}'::jsonb @> '{"a":2}'::jsonb AS v`);

parity("<@ is the inverse of containment", [], `SELECT '{"a":1}'::jsonb <@ '{"a":1,"b":2}'::jsonb AS v`);

parity("? checks key existence", [], `SELECT '{"a":1}'::jsonb ? 'a' AS yes, '{"a":1}'::jsonb ? 'b' AS no`);

parity("? on an array checks string membership", [], `SELECT '["x","y"]'::jsonb ? 'x' AS v`);

parity(
  "?| any key exists",
  [],
  `SELECT '{"a":1}'::jsonb ?| array['a','z'] AS yes, '{"a":1}'::jsonb ?| array['q','z'] AS no`,
);

parity(
  "?& all keys exist",
  [],
  `SELECT '{"a":1,"b":2}'::jsonb ?& array['a','b'] AS yes, '{"a":1}'::jsonb ?& array['a','b'] AS no`,
);

parity("|| merges objects with right precedence", [], `SELECT '{"a":1,"b":1}'::jsonb || '{"b":2,"c":3}'::jsonb AS v`);

parity("|| concatenates arrays", [], `SELECT '[1]'::jsonb || '[2,3]'::jsonb AS v`);

parity("- removes an object key", [], `SELECT '{"a":1,"b":2}'::jsonb - 'a' AS v`);

parity("- with a missing key is a no-op", [], `SELECT '{"a":1}'::jsonb - 'zzz' AS v`);

parity("- with an integer removes an array element", [], `SELECT '[1,2,3]'::jsonb - 1 AS v`);

parity("- with a text array removes several keys", [], `SELECT '{"a":1,"b":2,"c":3}'::jsonb - array['a','b'] AS v`);

parity("#- removes a nested path", [], `SELECT '{"a":{"b":1,"c":2}}'::jsonb #- '{a,b}' AS v`);
