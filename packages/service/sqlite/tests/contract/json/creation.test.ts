import { parity } from "../helpers.ts";

parity("json() minifies and subtypes", [], `SELECT json(' { "a" : [1, 2] } ')`);
parity("json_array mixed types", [], `SELECT json_array(1, 2, '3', 4)`);
parity("json_array nests json()", [], `SELECT json_array(1, json('[4,5]'), json('{"six":7.7}'))`);
parity("json_array quotes plain text that looks like json", [], `SELECT json_array('[1,2]')`);
parity("json_object basic", [], `SELECT json_object('a', 2, 'c', 4)`);
parity("json_object nests json subtype", [], `SELECT json_object('ex', json('[52,3.14159]'))`);
parity("json_object quotes plain text", [], `SELECT json_object('ex', '[52,3.14159]')`);
parity("json_quote null", [], `SELECT json_quote(NULL)`);
parity("json_quote number", [], `SELECT json_quote(1)`);
parity("json_quote text", [], `SELECT json_quote('abc')`);
parity("json_quote json value", [], `SELECT json_quote(json('[1]'))`);
