import { parity, parityTyped } from "../helpers.ts";

parity("hex literal output", [], "SELECT '\\x616263'::bytea AS v");
parity("hex literal uppercase input", [], "SELECT '\\xDEADBEEF'::bytea AS v");
parity("empty bytea", [], "SELECT '\\x'::bytea AS v, octet_length('\\x'::bytea) AS len");
parity("escape format input", [], "SELECT 'abc'::bytea AS v");
parity("text to bytea via cast", [], "SELECT 'hi'::bytea AS v");
parityTyped("bytea type", [], "SELECT '\\x00'::bytea AS v");
parity("bytea with zero byte", [], "SELECT '\\x006100'::bytea AS v, octet_length('\\x006100'::bytea) AS len");
parity("bytea to text shows hex", [], "SELECT ('\\x6162'::bytea)::text AS v");
