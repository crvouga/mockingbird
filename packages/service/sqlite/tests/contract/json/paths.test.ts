import { parity, queryErrorParity } from "../helpers.ts";

parity("path root", [], `SELECT json_extract('[1,2,3]', '$')`);
parity("path key", [], `SELECT json_extract('{"a":1}', '$.a')`);
parity("path quoted key", [], `SELECT json_extract('{"a.b":1}', '$."a.b"')`);
parity("path array index", [], `SELECT json_extract('[10,20,30]', '$[1]')`);
parity("path nested", [], `SELECT json_extract('{"a":{"b":[0,1,2]}}', '$.a.b[2]')`);
parity("path from end", [], `SELECT json_extract('[10,20,30]', '$[#-1]')`);
parity("path unicode key", [], `SELECT json_extract('{"café":1}', '$.café')`);
parity("path numeric-looking key", [], `SELECT json_extract('{"1":"one"}', '$."1"')`);
parity("path brackets in key", [], `SELECT json_extract('{"a[0]":9}', '$."a[0]"')`);

queryErrorParity("malformed path no dollar", [], `SELECT json_extract('[1]', 'a')`);
queryErrorParity("malformed path empty", [], `SELECT json_extract('[1]', '')`);
