import { parity, queryErrorParity } from "../helpers.ts";

parity("md5 of text", [], "SELECT md5('hello') AS a, md5('') AS b");
parity("encode hex", [], "SELECT encode('abc'::bytea, 'hex') AS v");
parity("encode base64", [], "SELECT encode('hello world!'::bytea, 'base64') AS v");
parity("encode escape", [], "SELECT encode('ab c'::bytea, 'escape') AS v");
parity("decode hex roundtrip", [], "SELECT convert_from(decode('616263', 'hex'), 'UTF8') AS v");
parity("decode base64 roundtrip", [], "SELECT convert_from(decode('aGVsbG8=', 'base64'), 'UTF8') AS v");
parity("starts_with", [], "SELECT starts_with('abcdef', 'abc') AS a, starts_with('abcdef', 'bcd') AS b");
parity("starts_with empty prefix", [], "SELECT starts_with('abc', '') AS v");
parity("to_hex", [], "SELECT to_hex(255) AS a, to_hex(0) AS b, to_hex(4096) AS c");
parity("to_hex bigint", [], "SELECT to_hex(9223372036854775807) AS v");
parity("caret anchors in text ops", [], "SELECT 'abc' < 'abd' AS a, 'abc' < 'abcd' AS b");
queryErrorParity("encode unknown format", [], "SELECT encode('ab'::bytea, 'nope')", "invalid_parameter");
