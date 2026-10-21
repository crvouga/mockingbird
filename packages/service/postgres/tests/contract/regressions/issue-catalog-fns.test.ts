import { expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { expectParity } from "../../harness/assert.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { errorParity, parity, sequenceParity } from "../helpers.ts";

const sqlStateOf = (sql: string, setup: string[] = []): string | undefined => {
  const db = new Database();
  for (const statement of setup) db.exec(statement);
  try {
    db.exec(sql);
  } catch (error) {
    return (error as { sqlState?: string }).sqlState;
  }
  return undefined;
};

// #532 pg_catalog.pg_attrdef
const adSetup = ["CREATE TABLE ad (id int PRIMARY KEY, v text DEFAULT 'x', n int NOT NULL DEFAULT 5)"];
parity("#532 pg_attrdef is selectable", [], "SELECT count(*) >= 0 AS selectable FROM pg_catalog.pg_attrdef");
parity(
  "#532 the SQLAlchemy per-column server default query",
  adSetup,
  `SELECT a.attname,
          (SELECT pg_catalog.pg_get_expr(d.adbin, d.adrelid)
           FROM pg_catalog.pg_attrdef d
           WHERE d.adrelid = a.attrelid AND d.adnum = a.attnum AND a.atthasdef) AS "default"
   FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
   WHERE c.relname = 'ad' AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
);
sequenceParity("#532 pg_attrdef follows SET / DROP DEFAULT and DROP TABLE", adSetup, [
  {
    sql: "SELECT adnum, pg_get_expr(adbin, adrelid) AS d FROM pg_attrdef WHERE adrelid = 'ad'::regclass ORDER BY adnum",
    query: true,
  },
  { sql: "ALTER TABLE ad ALTER COLUMN id SET DEFAULT 7" },
  { sql: "ALTER TABLE ad ALTER COLUMN v DROP DEFAULT" },
  {
    sql: "ALTER TABLE ad ADD COLUMN ts timestamptz DEFAULT now(), ADD COLUMN u uuid, ADD COLUMN g int GENERATED ALWAYS AS (n * 2) STORED",
  },
  {
    sql: "SELECT adnum, pg_get_expr(adbin, adrelid) AS d FROM pg_attrdef WHERE adrelid = 'ad'::regclass ORDER BY adnum",
    query: true,
  },
  { sql: "CREATE TABLE ad2 (a serial, b text DEFAULT 'q'::text, c numeric DEFAULT 1.5)" },
  {
    sql: "SELECT pg_get_expr(adbin, adrelid) AS d, adnum FROM pg_attrdef WHERE adrelid = 'ad2'::regclass ORDER BY adnum",
    query: true,
  },
  { sql: "DROP TABLE ad2" },
  {
    sql: "SELECT count(*) AS n FROM pg_attrdef WHERE adrelid IN (SELECT oid FROM pg_class WHERE relname = 'ad2')",
    query: true,
  },
  {
    sql: "SELECT count(*) AS n FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum WHERE a.atthasdef",
    query: true,
  },
]);
parity(
  "#532 pg_attrdef agrees with information_schema.columns.column_default",
  adSetup,
  `SELECT c.column_name, c.column_default, pg_get_expr(d.adbin, d.adrelid) AS expr
   FROM information_schema.columns c
   LEFT JOIN pg_attrdef d ON d.adrelid = 'ad'::regclass AND d.adnum = c.ordinal_position
   WHERE c.table_name = 'ad' ORDER BY c.ordinal_position`,
);

// #535 hashtext / hashtextextended
for (const [label, sql] of [
  [
    "hashtext values and type",
    "SELECT hashtext('abc') AS h, pg_typeof(hashtext('abc')) AS t, hashtext('') AS e, hashtext('tenant-1') AS tn, hashtext('é') AS u",
  ],
  [
    "hashtextextended values and type",
    "SELECT hashtextextended('abc', 0) AS h0, pg_typeof(hashtextextended('abc', 0)) AS t, hashtextextended('abc', 42) AS h42, hashtextextended('', 0) AS e, hashtextextended('é', 0) AS u",
  ],
  [
    "strict",
    "SELECT hashtext(NULL) IS NULL AS a, hashtextextended(NULL, 0) IS NULL AS b, hashtextextended('x', NULL) IS NULL AS c",
  ],
  [
    "every tail length and a negative seed",
    "SELECT hashtext(repeat('ab', 20)) AS a, hashtext(repeat('z', 11)) AS b, hashtext(repeat('z', 12)) AS c, hashtext(repeat('z', 13)) AS d, hashtextextended(repeat('qr', 15), -9223372036854775807) AS e, hashtextextended(repeat('q', 12), 9223372036854775807) AS f",
  ],
  [
    "multi-byte text",
    "SELECT hashtext('日本語のテキスト') AS a, hashtextextended('日本語のテキスト', 3) AS b, hashtext('😀') AS c",
  ],
] as const) {
  parity(`#535 ${label}`, [], sql);
}
parity("#535 bound parameters", [], "SELECT hashtext($1) AS a, hashtextextended($1, $2) AS b", ["abc", 0]);
parity(
  "#535 over a column",
  ["CREATE TABLE ht (k text)", "INSERT INTO ht VALUES ('a'), ('b'), (NULL)"],
  "SELECT k, hashtext(k) AS h FROM ht ORDER BY k",
);

// #536 to_regclass, regclass <-> oid, regclass for indexes and catalog relations
const rcSetup = [
  "CREATE SCHEMA rc",
  "CREATE TABLE rc.t (id serial PRIMARY KEY, k text)",
  "CREATE INDEX t_k_idx ON rc.t (k)",
];
for (const [label, sql] of [
  [
    "to_regclass finds, misses and unquotes",
    `SELECT to_regclass('rc.t') IS NOT NULL AS found, to_regclass('rc.missing') IS NULL AS missing, to_regclass('"rc"."t"')::text AS quoted, pg_typeof(to_regclass('rc.t')) AS ty`,
  ],
  [
    "to_regclass of an index, sequence and catalog relation",
    `SELECT to_regclass('rc.t_k_idx')::text AS i, to_regclass('rc.t_id_seq')::text AS s, to_regclass('pg_class')::text AS c, to_regclass('pg_catalog.pg_class')::text AS c2`,
  ],
  [
    "to_regclass is NULL for NULL and for malformed names",
    `SELECT to_regclass(NULL) IS NULL AS a, to_regclass('rc.') IS NULL AS b, to_regclass('') IS NULL AS c, to_regclass('nodb.rc.t') IS NULL AS d`,
  ],
  ["oid = regclass", `SELECT relname FROM pg_class WHERE oid = 'rc.t'::regclass`],
  ["regclass = oid", `SELECT relname FROM pg_class WHERE 'rc.t'::regclass = oid`],
  ["attrelid = regclass", `SELECT count(*) AS cols FROM pg_attribute WHERE attrelid = 'rc.t'::regclass AND attnum > 0`],
  ["indexrelid = to_regclass", `SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('rc.t_k_idx')`],
  ["conrelid::regclass", `SELECT conrelid::regclass FROM pg_constraint WHERE conname = 't_pkey'`],
  ["indrelid::regclass", `SELECT indrelid::regclass FROM pg_index WHERE indexrelid = 'rc.t_k_idx'::regclass`],
  ["regclass round-trips through oid", `SELECT ('rc.t'::regclass::oid)::regclass`],
  [
    "catalog relation literals",
    `SELECT 'pg_class'::regclass IS NOT NULL AS a, 'pg_catalog.pg_class'::regclass::text AS b`,
  ],
  [
    "index literal",
    `SELECT 'rc.t_k_idx'::regclass::text AS a, 'rc.t_k_idx'::regclass::oid = to_regclass('rc.t_k_idx')::oid AS b`,
  ],
  [
    "regclass output uses the search path",
    `SELECT 'rc.t'::regclass::text AS a, (SELECT oid FROM pg_class WHERE relname = 't_k_idx')::regclass AS b`,
  ],
  ["oid::regclass of an unknown oid prints the number", `SELECT 4000000::oid::regclass::text AS a`],
  ["integer::regclass", `SELECT 'rc.t'::regclass::oid::int4::regclass::text AS a`],
] as const) {
  parity(`#536 ${label}`, rcSetup, sql);
}
sequenceParity("#536 regclass output after SET search_path", rcSetup, [
  { sql: "SET search_path = rc, public" },
  { sql: "SELECT conrelid::regclass AS c FROM pg_constraint WHERE conname = 't_pkey'", query: true },
  { sql: "SELECT to_regclass('t')::text AS a, to_regclass('t_k_idx')::text AS b", query: true },
]);
errorParity(
  "#536 a regclass literal that names nothing is 42P01",
  rcSetup,
  "SELECT 'rc.missing'::regclass",
  "undefined_table",
);
errorParity("#536 a missing index literal is 42P01", rcSetup, "SELECT 'rc.nope_idx'::regclass", "undefined_table");
test("#536 to_regclass is soft where the literal cast raises", () => {
  expect(sqlStateOf("SELECT 'rc.missing'::regclass", rcSetup)).toBe("42P01");
  expect(sqlStateOf("SELECT to_regclass('rc.missing')", rcSetup)).toBeUndefined();
});

// #533 pgvector is not modelled: every entry point fails exactly as stock PostgreSQL (which has no pgvector) does
errorParity("#533 CREATE EXTENSION vector is not available", [], "CREATE EXTENSION vector", "unsupported");
errorParity(
  "#533 CREATE EXTENSION IF NOT EXISTS vector is not available",
  [],
  "CREATE EXTENSION IF NOT EXISTS vector",
  "unsupported",
);
errorParity(
  "#533 a vector(n) column does not exist as a type",
  [],
  "CREATE TABLE sm (id int PRIMARY KEY, embedding vector(3))",
  "undefined_object",
);
errorParity("#533 a vector cast does not exist as a type", [], "SELECT '[1,2,3]'::vector", "undefined_object");
test("#533 refusing pgvector leaves no extension, table or type behind", () => {
  const db = new Database();
  for (const sql of ["CREATE EXTENSION IF NOT EXISTS vector", "CREATE TABLE sm (id int, embedding vector(3))"]) {
    expect(() => db.exec(sql)).toThrow();
  }
  expect(db.query("SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'vector'")).toEqual([{ n: 0 }]);
  expect(db.query("SELECT count(*)::int AS n FROM pg_available_extensions WHERE name = 'vector'")).toEqual([{ n: 0 }]);
  expect(db.query("SELECT count(*)::int AS n FROM pg_class WHERE relname = 'sm'")).toEqual([{ n: 0 }]);
});

// #538 wishlist, item 3: sha256 (and the rest of the core SHA-2 family)
parity("#538 sha256 of bytea", [], "SELECT encode(sha256('a'::bytea), 'hex') AS h, pg_typeof(sha256('a'::bytea)) AS t");
parity(
  "#538 sha224 / sha384 / sha512 and the empty input",
  [],
  "SELECT encode(sha224('abc'::bytea), 'hex') AS a, encode(sha384(''::bytea), 'hex') AS b, encode(sha512('abc'::bytea), 'hex') AS c, encode(sha256(''::bytea), 'hex') AS d, encode(sha256('\\xdeadbeef'::bytea), 'hex') AS e",
);
parity("#538 sha256 of NULL is NULL", [], "SELECT sha256(NULL::bytea) IS NULL AS n");

// #538 item 4: enum_range, enum_first, enum_last
const moodSetup = [
  "CREATE TYPE wl_mood AS ENUM ('a', 'b', 'c', 'd')",
  "CREATE TABLE wl_t (m wl_mood)",
  "INSERT INTO wl_t VALUES ('b'), ('d')",
];
for (const [label, sql] of [
  ["enum_range of a type", "SELECT enum_range(NULL::wl_mood) AS r, pg_typeof(enum_range(NULL::wl_mood)) AS t"],
  ["enum_range with both bounds", "SELECT enum_range('b'::wl_mood, 'c'::wl_mood) AS r"],
  ["enum_range with an open lower bound", "SELECT enum_range(NULL, 'b'::wl_mood) AS r"],
  ["enum_range with an open upper bound", "SELECT enum_range('c'::wl_mood, NULL) AS r"],
  ["enum_range with bounds out of order is empty", "SELECT enum_range('d'::wl_mood, 'a'::wl_mood) AS r"],
  ["enum_range of a column value", "SELECT m, enum_range(m) AS r FROM wl_t ORDER BY m"],
  [
    "enum_first and enum_last",
    "SELECT enum_first(NULL::wl_mood) AS f, enum_last(NULL::wl_mood) AS l, enum_first('c'::wl_mood) AS f2",
  ],
  ["unnest of enum_range", "SELECT x FROM unnest(enum_range(NULL::wl_mood)) AS x ORDER BY x DESC"],
  ["enum_range cast to text[]", "SELECT enum_range(NULL::wl_mood)::text[] AS r"],
] as const) {
  parity(`#538 ${label}`, moodSetup, sql);
}
errorParity("#538 enum_range of a non-enum is 42883", [], "SELECT enum_range(1)", "undefined_function");
parity(
  "#538 pg_typeof prints an enum and its array unqualified when the schema is on the search path",
  ["CREATE SCHEMA o", "CREATE TYPE wl_mood AS ENUM ('a')", "CREATE TYPE o.om AS ENUM ('a')"],
  "SELECT pg_typeof('a'::wl_mood) AS t, pg_typeof(ARRAY['a']::wl_mood[]) AS u, pg_typeof('a'::o.om) AS v, pg_typeof(ARRAY['a']::o.om[]) AS w",
);

// #538 item 1: jsonb_to_recordset (and its json / record siblings) with a column definition list
for (const [label, sql] of [
  ["jsonb_to_recordset", `SELECT * FROM jsonb_to_recordset('[{"a":1,"b":"x"}]'::jsonb) AS r(a int, b text)`],
  [
    "json_to_recordset with a missing key and a filter",
    `SELECT r.a, r.b FROM json_to_recordset('[{"a":1,"b":"x"},{"a":2}]') AS r(a int, b text) WHERE a > 0`,
  ],
  [
    "scalar, jsonb and array columns",
    `SELECT * FROM jsonb_to_recordset('[{"a":1.5,"b":{"c":1},"d":[1,2],"e":null,"f":true}]'::jsonb) AS r(a numeric, b jsonb, d int[], e text, f bool, g int)`,
  ],
  [
    "nested values into text columns",
    `SELECT * FROM jsonb_to_recordset('[{"b":{"c":1},"d":[1,2]}]'::jsonb) AS r(b text, d text)`,
  ],
  [
    "null elements and a text array literal",
    `SELECT * FROM jsonb_to_recordset('[{"a":[1,null,3],"b":["x","y"],"c":"{1,2}"}]'::jsonb) AS r(a int[], b text[], c int[])`,
  ],
  [
    "input functions of other types",
    `SELECT * FROM jsonb_to_recordset('[{"a":"2024-01-02T03:04:05Z","b":"f0e1d2c3-b4a5-4687-8899-aabbccddeeff","c":"2024-02-03","d":true}]'::jsonb) AS r(a timestamptz, b uuid, c date, d bool)`,
  ],
  [
    "JSON null in jsonb and json columns",
    `SELECT * FROM jsonb_to_recordset('[{"a":null,"b":null}]'::jsonb) AS r(a jsonb, b json)`,
  ],
  ["a string into an int column", `SELECT * FROM jsonb_to_recordset('[{"a":"1"}]'::jsonb) AS r(a int)`],
  ["key case matters", `SELECT * FROM jsonb_to_recordset('[{"A":1}]'::jsonb) AS r(a int, "A" int)`],
  [
    "empty array and NULL input",
    `SELECT (SELECT count(*) FROM jsonb_to_recordset('[]'::jsonb) AS r(a int)) AS e, (SELECT count(*) FROM jsonb_to_recordset(NULL) AS r(a int)) AS n`,
  ],
  ["jsonb_to_record", `SELECT * FROM jsonb_to_record('{"a":1,"b":"x","c":null}') AS r(a bigint, b varchar(5), c int)`],
  [
    "result column types",
    `SELECT pg_typeof(a)::text AS a, pg_typeof(b)::text AS b FROM jsonb_to_record('{"a":1,"b":"x"}') AS r(a bigint, b varchar(5))`,
  ],
  [
    "join and lateral",
    `SELECT * FROM (VALUES ('[{"a":1},{"a":2}]'::jsonb)) v(j), LATERAL jsonb_to_recordset(v.j) AS r(a int) ORDER BY a`,
  ],
  [
    "cross join with a record",
    `SELECT * FROM jsonb_to_record('{"a":1,"b":2}') AS r(a int, b int) CROSS JOIN jsonb_to_recordset('[{"z":1},{"z":2}]') AS s(z int) ORDER BY z`,
  ],
] as const) {
  parity(`#538 ${label}`, [], sql);
}
for (const [label, sql] of [
  ["a non-array into the recordset form", `SELECT * FROM jsonb_to_recordset('{"a":1}'::jsonb) AS r(a int)`],
  ["non-object elements", `SELECT * FROM jsonb_to_recordset('[1,2]'::jsonb) AS r(a int)`],
  ["an array into the record form", `SELECT * FROM jsonb_to_record('[1]'::jsonb) AS r(a int)`],
  ["no column definition list", `SELECT * FROM jsonb_to_record('{"a":1}'::jsonb)`],
  ["invalid input for the column type", `SELECT * FROM jsonb_to_recordset('[{"a":"x"}]'::jsonb) AS r(a int)`],
  ["a fractional number into an int column", `SELECT * FROM jsonb_to_recordset('[{"a":1.5}]'::jsonb) AS r(a int)`],
  ["a value too long for varchar(n)", `SELECT * FROM jsonb_to_recordset('[{"a":"abcdef"}]'::jsonb) AS r(a varchar(3))`],
  ["a duplicate column in the list", `SELECT * FROM jsonb_to_recordset('[{"a":1}]'::jsonb) AS r(a text, a text)`],
] as const) {
  errorParity(`#538 ${label}`, [], sql);
}

// #538 items 5 and 6: the label of an unnamed select-list expression
for (const [label, sql] of [
  ["cast to int", "SELECT 1::int"],
  ["cast of a cast takes the outermost type", `SELECT '{"a":1}'::jsonb::text`],
  ["numeric(10,2) then float8", "SELECT 1.5::numeric(10,2)::float8"],
  [
    "type aliases are spelled as pg_catalog names",
    "SELECT 1::integer, 1::bigint, 1::smallint, 1::boolean, 1::real, 1::double precision, 1::decimal, 'a'::character varying, 'a'::varchar(3), 'a'::char(2), '2020-01-01'::timestamptz, '2020-01-01'::timestamp, 'a'::text, 1::int[]",
  ],
  [
    "a column or function inside a cast keeps its own name",
    "SELECT id::text, abs(id)::bigint, upper(name)::text FROM lb",
  ],
  ["a CASE inside a cast", "SELECT (CASE WHEN true THEN 1 END)::int, CASE WHEN true THEN 1 END"],
  ["ANY / ALL over an array", "SELECT 'a' = ANY(ARRAY['a']), 'a' <> ALL(ARRAY['b']), id = ANY(ARRAY[1]) FROM lb"],
  ["OVERLAPS", "SELECT (DATE '2020-01-01', DATE '2020-02-01') OVERLAPS (DATE '2020-01-15', DATE '2020-03-01')"],
  ["an enum cast keeps the type name as written", "SELECT 'a'::lb_mood"],
] as const) {
  parity(
    `#538 label of ${label}`,
    ["CREATE TYPE lb_mood AS ENUM ('a')", "CREATE TABLE lb (id int, name text)", "INSERT INTO lb VALUES (1, 'x')"],
    sql,
  );
}

// #538 item 8: catalogs tools only probe (what the engine models is listed; the rest is empty)
for (const name of [
  "pg_depend",
  "pg_inherits",
  "pg_collation",
  "pg_opclass",
  "pg_authid",
  "pg_locks",
  "pg_stat_activity",
]) {
  parity(`#538 pg_catalog.${name} is selectable`, [], `SELECT count(*) >= 0 AS ok FROM pg_catalog.${name}`);
}
parity(
  "#538 pg_inherits is empty without inheritance",
  ["CREATE TABLE ih (id int)"],
  "SELECT count(*) AS n FROM pg_inherits",
);
parity(
  "#538 pg_collation has default, C, POSIX and ucs_basic",
  [],
  "SELECT collname, collprovider, collencoding, collisdeterministic FROM pg_collation WHERE collname IN ('default', 'C', 'POSIX', 'ucs_basic') ORDER BY collname",
);
parity(
  "#538 pg_authid has the postgres role",
  [],
  "SELECT rolname, rolsuper, rolcanlogin, rolcreatedb FROM pg_authid WHERE rolname = 'postgres'",
);
parity(
  "#538 pg_stat_activity lists the current backend",
  [],
  "SELECT datname, state, pid = pg_backend_pid() AS me FROM pg_stat_activity WHERE pid = pg_backend_pid()",
);
parity(
  "#538 pg_locks shows the session's own locks",
  [],
  "SELECT locktype, mode, granted FROM pg_locks ORDER BY locktype",
);
parity(
  "#538 pg_opclass has the default btree class of int4, text and the gin classes",
  [],
  "SELECT DISTINCT opcname FROM pg_opclass WHERE opcname IN ('int4_ops', 'text_ops', 'jsonb_ops', 'jsonb_path_ops', 'array_ops') ORDER BY 1",
);
parity(
  "#538 pg_depend lists the sequence and column default dependencies",
  [
    "CREATE TABLE dp (id serial PRIMARY KEY, k text DEFAULT 'q', n int GENERATED ALWAYS AS IDENTITY)",
    "CREATE INDEX dp_k ON dp (k)",
  ],
  `SELECT classid::regclass::text AS c, CASE WHEN classid = 'pg_class'::regclass THEN objid::regclass::text END AS o,
          refobjsubid, deptype
   FROM pg_depend WHERE refobjid = 'dp'::regclass AND classid IN ('pg_class'::regclass, 'pg_attrdef'::regclass) AND refobjsubid > 0
   ORDER BY 1, 2, 3, 4`,
);

// #538 item 7: inet, cidr and macaddr (input, output, equality, ordering); ranges and geometric types are refused
const netInputs = {
  inet: [
    "127.0.0.1",
    "192.168.1.5/24",
    "1.2.3.4/32",
    "1.2.3.4/0",
    "01.2.3.4",
    "::1",
    "::",
    "::ffff:1.2.3.4",
    "::1.2.3.4",
    "1::2",
    "1:0:2:3:4:5:6:7",
    "1:0:0:2:0:0:0:3",
    "2001:DB8::1/64",
    "::ffff:0:0",
    "1:2:3:4:5:6:1.2.3.4",
    "::/0",
    "::2",
    "0.0.0.0/0",
    "1.2.3.4/33",
    "10",
    "10.1",
    "1.2.3",
    "256.1.1.1",
    "abc",
    "1.2.3.4/",
    "1.2.3.4/8x",
    "::g",
    "1::2::3",
    "::1/129",
    "1.2.3.4::",
    "",
  ],
  cidr: [
    "10.0.0.0/8",
    "10",
    "10.1",
    "192.168.1",
    "192.168.1.0/24",
    "192.168.1.5/24",
    "128",
    "128.1",
    "224",
    "240",
    "224.1",
    "1.2.3.4",
    "::1",
    "::1/128",
    "2001:db8::/32",
    "2001:db8::1/32",
    "10.0.0.0/33",
    "0/0",
    "0.0.0.0/0",
    "::/0",
    "1.2.3.0/24/1",
  ],
  macaddr: [
    "08:00:2b:01:02:03",
    "08-00-2b-01-02-03",
    "08002b:010203",
    "08002b-010203",
    "0800.2b01.0203",
    "0800-2b01-0203",
    "08002b010203",
    "8:0:2b:1:2:3",
    "08:00:2B:01:02:03",
    "08:00:2b:01:02",
    "08:00:2b:01:02:03:04",
    "xx",
    " 08:00:2b:01:02:03 ",
    "08:00:2b:01:02:0g",
    "0800.2b01-0203",
    "08:00-2b:01:02:03",
  ],
} as const;
for (const [type, inputs] of Object.entries(netInputs)) {
  // an input is either accepted with the same canonical text or refused with the same SQLSTATE
  matrixBoth(`#538 ${type} input`, async (memory, postgres) => {
    for (const input of inputs) {
      const sql = `SELECT '${input}'::${type} AS v`;
      try {
        expectParity(await memory.query(sql), await postgres.query(sql), { ignoreErrorPhase: true, messageTier: "B" });
      } catch (error) {
        throw new Error(`${type} ${JSON.stringify(input)}: ${(error as Error).message}`);
      }
    }
  });
}
parity(
  "#538 inet equality ignores the spelling of the address",
  [],
  "SELECT '1.2.3.4'::inet = '1.2.3.4/32'::inet AS a, '::FFFF:1.2.3.4'::inet = '::ffff:1.2.3.4'::inet AS b, '10.0.0.1/8'::inet = '10.0.0.1/16'::inet AS c, '10.0.0.0/8'::cidr = '10.0.0.0/8'::inet AS d",
);
parity(
  "#538 inet ordering is numeric, by family and then network",
  [
    "CREATE TABLE ips (i inet)",
    "INSERT INTO ips VALUES ('10.0.0.0/8'), ('9.0.0.0/8'), ('::1'), ('10.0.0.1'), ('10.0.0.0/16'), ('2.1.1.1/8'), ('2.9.9.9/8'), ('192.168.0.1'), ('::'), ('1:2::3')",
  ],
  "SELECT i FROM ips ORDER BY i",
);
parity(
  "#538 inet comparison operators, DISTINCT, GROUP BY and min / max",
  [
    "CREATE TABLE ips (i inet)",
    "INSERT INTO ips VALUES ('10.0.0.1'), ('10.0.0.1/32'), ('9.0.0.0/8'), ('10.0.0.1/24'), (NULL)",
  ],
  "SELECT (SELECT count(DISTINCT i) FROM ips) AS d, (SELECT min(i) FROM ips) AS lo, (SELECT max(i) FROM ips) AS hi, '10.0.0.1'::inet > '9.9.9.9'::inet AS gt, '10.0.0.1'::inet < '10.0.0.1/24'::inet AS lt",
);
parity(
  "#538 macaddr ordering and equality",
  [
    "CREATE TABLE macs (m macaddr)",
    "INSERT INTO macs VALUES ('08:00:2b:01:02:03'), ('00:11:22:33:44:55'), ('ff:ff:ff:ff:ff:ff'), ('08002b010203')",
  ],
  "SELECT m, m = '08:00:2b:01:02:03'::macaddr AS e FROM macs ORDER BY m",
);
parity(
  "#538 network types in a table, with a primary key, arrays and text casts",
  [
    "CREATE TABLE hosts (ip inet PRIMARY KEY, net cidr, mac macaddr, ips inet[])",
    "INSERT INTO hosts VALUES ('10.0.0.1', '10.0.0.0/8', '08:00:2b:01:02:03', ARRAY['10.0.0.1', '::1']::inet[])",
  ],
  "SELECT ip, net, mac, ips, ip::text AS t, net::inet AS ni, pg_typeof(ip)::text AS ty, pg_typeof(ips)::text AS tya FROM hosts",
);
parity(
  "#538 an index and a unique constraint over inet and macaddr columns",
  [
    "CREATE TABLE nets (ip inet, mac macaddr, UNIQUE (ip))",
    "CREATE INDEX nets_mac ON nets (mac)",
    "INSERT INTO nets VALUES ('10.0.0.2', '08:00:2b:01:02:03'), ('10.0.0.10', '08:00:2b:01:02:04'), ('::1', NULL)",
  ],
  "SELECT ip, mac FROM nets WHERE ip > '10.0.0.5' OR mac = '08002b010203' ORDER BY ip",
);
errorParity(
  "#538 a unique inet column refuses an equal address",
  ["CREATE TABLE nets (ip inet UNIQUE)", "INSERT INTO nets VALUES ('10.0.0.1')"],
  "INSERT INTO nets VALUES ('10.0.0.1/32')",
  "constraint_unique",
);
parity(
  "#538 inet to cidr drops the host bits, text round-trips",
  [],
  "SELECT '192.168.1.5/24'::inet::cidr AS a, '10.1.2.3'::inet::cidr AS b, '10.0.0.0/8'::cidr::inet AS c, '1.2.3.4/32'::cidr::inet AS d, '1.2.3.4'::text::inet AS e, '10.0.0.1/8'::inet::text AS f",
);
parity(
  "#538 inet functions",
  [],
  "SELECT family('1.2.3.4'::inet) AS f4, family('::1'::inet) AS f6, masklen('192.168.1.5/24'::inet) AS m, host('192.168.1.5/24'::inet) AS h, network('192.168.1.5/24'::inet) AS n, broadcast('192.168.1.5/24'::inet) AS b, netmask('192.168.1.5/24'::inet) AS nm, netmask('2001:db8::1/32'::inet) AS nm6, broadcast('2001:db8::1/32'::inet) AS b6, network('::1'::inet) AS n6",
);
test("#538 range and geometric types are refused as unsupported (0A000), not as missing", () => {
  for (const type of ["int4range", "daterange", "point", "box", "macaddr8", "xml"]) {
    expect(sqlStateOf(`SELECT NULL::${type}`)).toBe("0A000");
    expect(sqlStateOf(`CREATE TABLE r (a ${type})`)).toBe("0A000");
  }
  expect(sqlStateOf("SELECT NULL::no_such_type")).toBe("42704");
});
test("#538 an unsupported type leaves no table behind", () => {
  const db = new Database();
  expect(() => db.exec("CREATE TABLE ranges (id int, r int4range)")).toThrow();
  expect(db.query("SELECT count(*)::int AS n FROM pg_class WHERE relname = 'ranges'")).toEqual([{ n: 0 }]);
});
