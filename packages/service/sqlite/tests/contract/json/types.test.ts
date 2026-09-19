import { parity } from "../helpers.ts";

parity("type null", [], `SELECT json_type('null'), json_extract('null', '$')`);
parity(
  "type true false",
  [],
  `SELECT json_type('true'), json_type('false'), json_extract('true', '$'), json_extract('false', '$')`,
);
parity(
  "type integer real",
  [],
  `SELECT json_type('1'), json_type('1.5'), json_extract('1', '$'), json_extract('1.5', '$')`,
);
parity("type string", [], `SELECT json_type('"hi"'), json_extract('"hi"', '$')`);
parity("type empty array object", [], `SELECT json('[]'), json('{}')`);
parity("type nested", [], `SELECT json_type('{"a":[null,true,false,0,"x",{"y":1}]}', '$.a[5]')`);
parity(
  "sql null vs json null vs string null",
  ["CREATE TABLE t(j TEXT)", "INSERT INTO t VALUES (NULL), ('null'), ('\"null\"')"],
  `SELECT j, json_type(j), json_extract(j, '$') FROM t ORDER BY rowid`,
);
parity("empty string json", [], `SELECT json_quote('')`);
parity("unicode string", [], `SELECT json('{"x":"日本語"}')`);
parity("negative zero-ish", [], `SELECT json_extract('[-0,0]', '$[0]'), json_extract('[-0,0]', '$[1]')`);
