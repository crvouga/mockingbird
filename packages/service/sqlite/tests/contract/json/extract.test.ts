import { parity } from "../helpers.ts";

const DOC = `'{"a":2,"c":[4,5,{"f":7}]}'`;

parity("json_extract root", [], `SELECT json_extract(${DOC}, '$')`);
parity("json_extract array", [], `SELECT json_extract(${DOC}, '$.c')`);
parity("json_extract nested object", [], `SELECT json_extract(${DOC}, '$.c[2]')`);
parity("json_extract scalar", [], `SELECT json_extract(${DOC}, '$.c[2].f')`);
parity("json_extract missing is null", [], `SELECT json_extract(${DOC}, '$.x')`);
parity("json_extract multiple paths", [], `SELECT json_extract('{"a":2,"c":[4,5],"f":7}', '$.c', '$.a')`);
parity("json_extract from end index", [], `SELECT json_extract('{"a":2,"c":[4,5],"f":7}', '$.c[#-1]')`);
parity("json_extract string", [], `SELECT json_extract('{"a":"xyz"}', '$.a')`);
parity("json_extract json null", [], `SELECT json_extract('{"a":null}', '$.a')`);
parity("json_extract typeof array", [], `SELECT typeof(json_extract('[1,2,3]', '$'))`);
