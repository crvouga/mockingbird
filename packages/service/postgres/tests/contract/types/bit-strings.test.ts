import { errorParity, execParity, parity, parityTyped, sequenceParity } from "../helpers.ts";

// bit(n) / bit varying(n) parity (issue #724)

const BT = ["CREATE TABLE bt (a bit(3), b varbit, c bit varying(4), d bit)"];

// --- hex / binary text input -------------------------------------------------------

parityTyped("hex text cast to bit(8) to int", [], "SELECT ('x' || 'ff')::bit(8)::int AS v");
parity("md5 prefix idiom to int", [], "SELECT ('x' || substr(md5('abc'), 1, 8))::bit(32)::int AS v");
parity(
  "md5 idiom over table rows",
  ["CREATE TABLE ids (id int)", "INSERT INTO ids VALUES (1), (2), (3)"],
  "SELECT id, ('x' || substr(md5(id::text), 1, 8))::bit(32)::int AS h FROM ids ORDER BY id",
);
parity(
  "hex input pads and truncates to bit(n)",
  [],
  "SELECT ('x' || 'ff')::bit(8)::text AS a, ('x' || 'f')::bit(8)::text AS b, ('x' || 'fff')::bit(8)::text AS c, ('x' || 'ff')::bit(4)::text AS d",
);
parity(
  "x/X/b/B input prefixes",
  [],
  "SELECT 'xff'::bit varying::text AS a, 'XFF'::bit(8)::text AS b, 'b101'::bit(3)::text AS c, 'B101'::bit(3)::text AS d, 'x1F'::bit(8)::text AS e",
);
parity(
  "empty prefixed inputs",
  [],
  "SELECT 'X'::varbit::text AS a, 'b'::varbit::text AS b, 'B1'::varbit::text AS c, ''::bit::text AS d",
);
parity("cast() hex to bit to integer", [], "SELECT cast('xff' AS bit(8))::integer AS v");
errorParity("invalid hexadecimal digit", [], "SELECT 'x1g'::bit(12)");
errorParity("invalid hexadecimal digit in varbit", [], "SELECT 'xz'::varbit");
errorParity("invalid binary digit", [], "SELECT '102'::bit(3)");
errorParity("leading space is not a binary digit", [], "SELECT ' 101'::bit(4)");
errorParity("invalid binary digit in B literal", [], "SELECT b'12'");
errorParity("invalid hex digit in X literal", [], "SELECT x'fg'");

// --- literals and types --------------------------------------------------------

parityTyped("B'' and X'' literal types", [], "SELECT b'101' AS a, B'1' AS b, X'1F' AS c, b'' AS d");
parity(
  "pg_typeof of bit literals",
  [],
  "SELECT pg_typeof(b'101')::text AS a, pg_typeof(X'1F')::text AS b, X'1F'::text AS c, x'aB'::text AS d",
);
parity("bit to text and varchar", [], "SELECT b'1'::text AS a, b'10'::varchar AS b, b'101'::text::bit(3)::text AS c");

// --- typmod coercion: explicit truncation/padding vs assignment errors ---------------

parity(
  "explicit cast pads and truncates",
  [],
  "SELECT b'101'::bit(5)::text AS a, b'10111'::bit(3)::text AS b, '10111'::bit(3)::text AS c, '1'::bit(3)::text AS d, b'11'::bit(3)::text AS e",
);
parity("bit without length is bit(1)", [], "SELECT b'101'::bit::text AS a, 'x'::bit::text AS b");
parity(
  "explicit varbit(n) truncates",
  [],
  "SELECT '1010'::varbit(2)::text AS a, '1010'::bit varying(2)::text AS b, b'1010'::varbit::bit(2)::text AS c",
);
execParity("insert exact-length bit values", BT, "INSERT INTO bt VALUES (b'101', b'1', b'11', b'1')");
errorParity("insert too-long bit(3)", BT, "INSERT INTO bt (a) VALUES (b'1011')");
errorParity("insert too-short bit(3)", BT, "INSERT INTO bt (a) VALUES (b'10')");
errorParity("insert unknown literal of wrong length into bit(3)", BT, "INSERT INTO bt (a) VALUES ('10111')");
errorParity("insert two bits into bit (bit(1))", BT, "INSERT INTO bt (d) VALUES (b'10')");
errorParity("insert too-long varbit(4)", BT, "INSERT INTO bt (c) VALUES ('11111')");
errorParity(
  "update too-long varbit(4)",
  [...BT, "INSERT INTO bt VALUES (b'101', b'1', b'11', b'1')"],
  "UPDATE bt SET c = b'10101'",
);
sequenceParity("stored bit columns round-trip", BT, [
  { sql: "INSERT INTO bt VALUES (b'101', b'1', b'11', b'0'), ('011', 'x', '1', '1')" },
  { sql: "INSERT INTO bt (b) VALUES ('x')" },
  {
    sql: "SELECT a::text, b::text, c::text, d::text, pg_typeof(a)::text, pg_typeof(b)::text, pg_typeof(c)::text FROM bt ORDER BY a, b",
    query: true,
  },
]);
parity(
  "format_type of bit and varbit columns",
  BT,
  "SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'bt'::regclass AND attnum > 0 ORDER BY attnum",
);

// --- integer <-> bit ------------------------------------------------------------

parity(
  "int4 and int8 to bit(n)",
  [],
  "SELECT 5::bit(4)::text AS a, (-1)::bit(4)::text AS b, 300::bit(4)::text AS c, 5::bit(40)::text AS d, 5::bigint::bit(4)::text AS e, (-5)::bigint::bit(70)::text AS f",
);
parity("int to bit without length", [], "SELECT 5::bit::text AS v");
parityTyped("int to bit(4) issue example", [], "SELECT 5::bit(4) AS v");
parityTyped(
  "bit to int4 and int8",
  [],
  "SELECT b'1011'::int AS a, b'1011'::bigint AS b, b'11111111111111111111111111111111'::int AS c, b'1'::bit(33)::text AS d",
);
parity(
  "bit(n) round-trips through int",
  [],
  "SELECT 5::bit(4)::int AS a, 5::bit(4)::bigint AS b, b'101'::bit(3)::int4::text AS c, 255::bit(8) = b'11111111' AS d",
);
parity("bit(64) and bigint", [], "SELECT (-1)::bit(64)::bigint AS a, (-1)::bigint::bit(64)::text AS b");
parity("varbit to bit to int", [], "SELECT 'xff'::varbit::bit(8)::int AS a, ('x' || 'ffffffff')::bit(32)::int AS b");
errorParity("bit wider than 32 to int4", [], "SELECT b'111111111111111111111111111111111'::int");
errorParity("bit wider than 64 to int8", [], "SELECT b'1'::bit(65)::bigint");
errorParity("smallint to bit has no cast", [], "SELECT 1::int2::bit(4)");
errorParity("numeric to bit has no cast", [], "SELECT 3.5::bit(4)");
errorParity("bit to smallint has no cast", [], "SELECT b'1'::bit(1)::int2");

// --- concatenation and substring --------------------------------------------------

parityTyped("bit || bit is bit varying", [], "SELECT b'00' || b'101' AS v");
parity(
  "pg_typeof of bit concatenation",
  [],
  "SELECT pg_typeof(b'00' || b'101')::text AS a, pg_typeof(b'1' || '0')::text AS b, pg_typeof('0' || b'1')::text AS c",
);
parityTyped("bit || unknown literal", [], "SELECT b'101' || '1' AS v");
parity("concatenate int-derived bits", [], "SELECT (5::bit(4) || 3::bit(2))::text AS v");
parity("bit::text || text", [], "SELECT b'101'::text || 'a' AS v");
errorParity("bit || non-binary literal", [], "SELECT b'1' || 'a'");
parity("substring bit from for to int", [], "SELECT substring(b'10110' from 2 for 3)::bit(3)::int AS v");
parity(
  "substring bit forms",
  [],
  "SELECT substring(b'10110' from 2)::text AS a, substring(b'10110', 2, 3)::text AS b, substring(b'10110' for 2)::text AS c, pg_typeof(substring(b'10110' from 2 for 3))::text AS d",
);
parity(
  "substring bit edge cases",
  [],
  "SELECT substring(b'10110' from 0 for 2)::text AS a, substring(b'10110' from 10)::text AS b, substring(b'10110' from -1 for 3)::text AS c",
);
errorParity("substring bit negative length", [], "SELECT substring(b'10110' from 2 for -1)");
errorParity("substr has no bit overload", [], "SELECT substr(b'10110', 2, 2)");

// --- bitwise operators -------------------------------------------------------------

parityTyped(
  "bit & | # ~ << >>",
  [],
  "SELECT b'101' & b'110' AS a, b'101' | b'110' AS b, b'101' # b'110' AS c, ~b'101' AS d, b'101' << 1 AS e, b'101' >> 1 AS f",
);
parity(
  "bit shifts",
  [],
  "SELECT (b'10110' << 2)::text AS a, (b'10110' >> 2)::text AS b, (b'10110' << -1)::text AS c, (b'10110' << 10)::text AS d, (b'101' >> 0)::text AS e",
);
parity(
  "varbit operators return bit",
  [],
  "SELECT pg_typeof(b'101'::varbit & b'110'::varbit)::text AS a, pg_typeof(b'101'::varbit << 1)::text AS b, pg_typeof(~b'101'::varbit)::text AS c, (b'101'::varbit & b'110'::varbit)::text AS d",
);
parity("not of empty bit string", [], "SELECT (~b'')::text AS v");
parity("and of int-derived bits", [], "SELECT (5::bit(4) & 3::bit(4))::text AS v");
errorParity("AND of different sizes", [], "SELECT b'101' & b'11'");
errorParity("OR of different sizes", [], "SELECT b'101' | b'1100'");
errorParity("XOR of different sizes", [], "SELECT b'101' # b'1100'");

// --- comparisons and ordering -------------------------------------------------------

parity(
  "bit comparisons",
  [],
  "SELECT b'101' = b'101' AS a, b'101' < b'110' AS b, b'10' < b'101' AS c, b'101' = b'1010' AS d, b'101' <> b'110' AS e, b'1' > b'0111' AS f, b'' < b'0' AS g",
);
parity(
  "bit compares with varbit and unknown",
  [],
  "SELECT b'1010' = b'1010'::varbit AS a, b'101'::varbit = b'101'::bit(3) AS b, b'101'::bit(3) = '101' AS c",
);
parity("order by bit", [], "SELECT x::text FROM (VALUES (b'101'), (b'1'), (b'011')) t(x) ORDER BY x");
parity("distinct bit", [], "SELECT DISTINCT x::text FROM (VALUES (b'101'), (b'101')) t(x)");
parity(
  "bit aggregates",
  [],
  "SELECT bit_and(x)::text AS a, bit_or(x)::text AS b, bit_xor(x)::text AS c FROM (VALUES (b'101'), (b'110')) t(x)",
);
errorParity("max(bit) does not exist", BT, "SELECT max(a) FROM bt");

// --- functions ----------------------------------------------------------------------

parity(
  "bit string functions",
  [],
  "SELECT length(b'10110') AS a, bit_length(b'10110') AS b, octet_length(b'10110') AS c, get_bit(b'101', 1) AS d, set_bit(b'101', 1, 1)::text AS e, position(b'11' in b'10110') AS f, overlay(b'11111' placing b'00' from 2)::text AS g, bit_count(b'10110') AS h",
);
parity(
  "bit function result types",
  [],
  "SELECT pg_typeof(set_bit(b'101', 1, 1))::text AS a, pg_typeof(bit_count(b'1'))::text AS b, pg_typeof(overlay(b'1' placing b'0' from 1))::text AS c, pg_typeof(set_bit(b'101'::varbit, 0, 0))::text AS d, set_bit(b'101'::varbit, 0, 0)::text AS e",
);
parity(
  "bit length functions",
  [],
  "SELECT octet_length(b'111111111') AS a, length(b'') AS b, bit_length(b'1'::varbit) AS c",
);
parity(
  "bit position and overlay edge cases",
  [],
  "SELECT position(b'00' in b'111') AS a, position(b'' in b'101') AS b, overlay(b'11111' placing b'00' from 2 for 1)::text AS c, overlay(b'11111' placing b'000' from 4)::text AS d",
);
errorParity("get_bit out of range", [], "SELECT get_bit(b'101', 3)");
errorParity("set_bit negative index", [], "SELECT set_bit(b'101', -1, 1)");
errorParity("set_bit new bit must be 0 or 1", [], "SELECT set_bit(b'101', 0, 2)");
parity(
  "bytea get_bit set_bit bit_count",
  [],
  "SELECT get_bit('\\x01'::bytea, 0) AS a, get_bit('\\x01'::bytea, 7) AS b, set_bit('\\x00'::bytea, 0, 1) AS c, bit_count('\\xff01'::bytea) AS d",
);
errorParity("bytea get_bit out of range", [], "SELECT get_bit('\\x01'::bytea, 8)");
parity("bit arrays", [], "SELECT array[b'1', b'0']::text AS a, '{101,01}'::varbit[]::text AS b");
parity(
  "coalesce and case over bit",
  [],
  "SELECT coalesce(null, b'1')::text AS a, (CASE WHEN true THEN b'1' ELSE b'00' END)::text AS b",
);

// --- catalogs and typmods --------------------------------------------------------------

parity(
  "regtype and format_type of bit types",
  [],
  "SELECT 'bit'::regtype::text AS a, 'bit(3)'::regtype::text AS b, 'varbit'::regtype::text AS c, format_type(1560, null) AS d, format_type(1562, null) AS e, format_type(1560, 1) AS f",
);
parity(
  "information_schema lengths of bit columns",
  ["CREATE TABLE bx (a bit, b bit(5), c varbit(7), d varbit)"],
  "SELECT column_name, data_type, character_maximum_length, udt_name FROM information_schema.columns WHERE table_name = 'bx' ORDER BY ordinal_position",
);
errorParity("bit(0) is rejected", [], "SELECT 1::bit(0)");
errorParity("varbit(0) is rejected", [], "SELECT '1'::varbit(0)");
sequenceParity(
  "bit column defaults",
  ["CREATE TABLE bd (a bit(4) DEFAULT b'1010', b varbit(3) DEFAULT 'x')"],
  [
    { sql: "INSERT INTO bd DEFAULT VALUES" },
    { sql: "UPDATE bd SET a = b'1'" },
    { sql: "SELECT a::text, b::text FROM bd", query: true },
  ],
);
parity(
  "bit primary key filter and order",
  ["CREATE TABLE bz (a bit(3) PRIMARY KEY)", "INSERT INTO bz VALUES (b'101'), (b'001')"],
  "SELECT a::text FROM bz WHERE a > b'010' UNION ALL SELECT a::text FROM (SELECT a FROM bz ORDER BY a DESC) s",
);
