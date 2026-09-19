import { parity } from "../helpers.ts";

parity(
  "jsonb_path_query_first object member",
  [],
  `SELECT jsonb_path_query_first('{"a":1,"b":2}'::jsonb, '$.a'::jsonpath) AS v`,
);

parity(
  "jsonb_path_query_first nested member",
  [],
  `SELECT jsonb_path_query_first('{"a":{"b":3}}'::jsonb, '$.a.b'::jsonpath) AS v`,
);

parity(
  "jsonb_path_query_first array index",
  [],
  `SELECT jsonb_path_query_first('[10,20,30]'::jsonb, '$[1]'::jsonpath) AS v`,
);

parity(
  "jsonb_path_query_first nested array",
  [],
  `SELECT jsonb_path_query_first('{"a":[1,2,3]}'::jsonb, '$.a[2]'::jsonpath) AS v`,
);

parity(
  "jsonb_path_query_first missing path is NULL",
  [],
  `SELECT jsonb_path_query_first('{"a":1}'::jsonb, '$.missing'::jsonpath) AS v`,
);

parity("jsonb_path_query_first root", [], `SELECT jsonb_path_query_first('{"a":1}'::jsonb, '$'::jsonpath) AS v`);

parity("jsonpath cast from text", [], `SELECT jsonb_path_query_first('{"a":1}'::jsonb, ('$.a')::jsonpath) AS v`);

parity("jsonb_path_exists present key", [], `SELECT jsonb_path_exists('{"a":1,"b":2}'::jsonb, '$."b"') AS ex`);

parity("jsonb_path_exists missing key", [], `SELECT jsonb_path_exists('{"a":1}'::jsonb, '$.missing') AS ex`);

parity("jsonb_path_exists json null value", [], `SELECT jsonb_path_exists('{"a":null}'::jsonb, '$.a') AS ex`);
