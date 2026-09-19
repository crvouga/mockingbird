import { parity } from "../helpers.ts";

parity("bytea concat", [], "SELECT '\\x6162'::bytea || '\\x6364'::bytea AS v");
parity("bytea length functions", [], "SELECT length('\\x616263'::bytea) AS a, octet_length('\\x616263'::bytea) AS b");
parity("get_byte", [], "SELECT get_byte('\\x616263'::bytea, 0) AS a, get_byte('\\x616263'::bytea, 2) AS b");
parity("set_byte", [], "SELECT set_byte('\\x616263'::bytea, 1, 90) AS v");
parity("bytea substring", [], "SELECT substring('\\x6162636465'::bytea FROM 2 FOR 3) AS v");
parity("bytea encode decode roundtrip", [], "SELECT decode(encode('\\x0001ff'::bytea, 'hex'), 'hex') AS v");
parity("md5 of bytea", [], "SELECT md5('\\x616263'::bytea) AS v");
parity("bit_length of bytea", [], "SELECT bit_length('\\x6162'::bytea) AS v");
