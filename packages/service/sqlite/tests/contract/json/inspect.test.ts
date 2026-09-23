import { parity } from "../helpers.ts";

parity("json_type object", [], `SELECT json_type('{"a":1}')`);
parity("json_type path", [], `SELECT json_type('{"a":[1,2]}', '$.a')`);
parity("json_type missing path", [], `SELECT json_type('{"a":1}', '$.b')`);
parity("json_valid true", [], `SELECT json_valid('{"a":1}')`);
parity("json_valid false", [], `SELECT json_valid('{')`);
parity("json_error_position ok", [], `SELECT json_error_position('{"a":1}')`);
parity("json_error_position bad", [], `SELECT json_error_position('{')`);
parity("json_array_length", [], `SELECT json_array_length('[1,2,3,4]')`);
parity("json_array_length path", [], `SELECT json_array_length('{"one":[1,2,3]}', '$.one')`);
parity("json_array_length missing", [], `SELECT json_array_length('{"one":[1,2,3]}', '$.two')`);
parity("json_array_length non-array", [], `SELECT json_array_length('{"one":[1,2,3]}')`);
parity("json_pretty", [], `SELECT json_pretty('{"a":1,"b":[2,3]}')`);
parity("subtype json", [], `SELECT subtype(json('[1]'))`);
parity("subtype jsonb", [], `SELECT subtype(jsonb('[1]'))`);
