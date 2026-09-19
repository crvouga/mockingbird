import { parity } from "../helpers.ts";

parity("json_object with json() nests", [], `SELECT json_object('x', json('[1,2,3]'))`);
parity("json_object with text quotes", [], `SELECT json_object('x', '[1,2,3]')`);
parity("json_object with -> nests", [], `SELECT json_object('ex', '[52,3.14159]' -> '$')`);
parity("json_object with ->> quotes", [], `SELECT json_object('ex', ('[52,3.14159]' ->> '$')) AS o`);
parity("json_array with json_array nests", [], `SELECT json_array(json_array(1, 2))`);
parity("json_array with text", [], `SELECT json_array('[1,2]')`);
parity(
  "extract then object",
  [],
  `
  SELECT json_object('c', json_extract('{"a":2,"c":[4,5]}', '$.c'))`,
);
parity(
  "set with arrow value",
  [],
  `
  SELECT json_set('{"a":1}', '$.b', '{"x":2}' -> '$')`,
);
parity("subtype of extract array", [], `SELECT subtype(json_extract('[1,2]', '$'))`);
parity("subtype of extract scalar", [], `SELECT subtype(json_extract('{"a":1}', '$.a'))`);
