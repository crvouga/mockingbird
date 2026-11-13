import { errorParity, parity, parityTyped, sequenceParity } from "../helpers.ts";

// Parity issues #716-#719, proven against the oracle.

// #716 pg_has_role and the pg_user view a server stats query reads
parity(
  "#716 pg_has_role for the current superuser",
  [],
  "SELECT pg_has_role(current_user, 'pg_monitor', 'MEMBER') AS a, pg_has_role('postgres', 'MEMBER') AS b, pg_has_role('postgres', 'pg_monitor', 'USAGE') AS c, pg_has_role('postgres', 'pg_monitor', 'member with admin option') AS d, pg_has_role('postgres', 'pg_monitor', 'SET') AS e, pg_has_role(NULL, 'MEMBER') AS f",
);
parity(
  "#716 pg_has_role follows memberships, INHERIT and the role itself",
  ["CREATE ROLE r1", "CREATE ROLE r2 LOGIN", "GRANT r1 TO r2", "CREATE ROLE r3 NOINHERIT", "GRANT r1 TO r3"],
  "SELECT pg_has_role('r2', 'r1', 'MEMBER') AS a, pg_has_role('r2', 'r1', 'USAGE') AS b, pg_has_role('r1', 'r2', 'MEMBER') AS c, pg_has_role('r2', 'r2', 'USAGE') AS d, pg_has_role('r3', 'r1', 'MEMBER') AS e, pg_has_role('r3', 'r1', 'USAGE') AS f, pg_has_role('r3', 'r1', 'SET') AS g",
);
errorParity(
  "#716 pg_has_role rejects an unknown privilege",
  [],
  "SELECT pg_has_role('postgres', 'pg_monitor', 'bogus')",
  "invalid_parameter",
);
errorParity(
  "#716 pg_has_role rejects an unknown role",
  [],
  "SELECT pg_has_role('postgres', 'nosuch', 'MEMBER')",
  "undefined_object",
);
parity(
  "#716 pg_user lists login roles with their attributes",
  ["CREATE ROLE r1", "CREATE ROLE r2 LOGIN CREATEDB"],
  "SELECT usename, usecreatedb, usesuper, userepl, usebypassrls, passwd, valuntil, useconfig FROM pg_user ORDER BY usename",
);
parity("#716 the stats query's pg_user lookup", [], "SELECT usesuper FROM pg_user WHERE usename = current_user");

sequenceParity(
  "#716 set_config(..., true) outside a transaction lasts for its statement",
  [],
  [
    {
      sql: "SELECT set_config('jit', 'off', true) AS a, set_config('statement_timeout', '5000', true) AS b, current_setting('statement_timeout') AS c",
      query: true,
    },
    { sql: "SELECT current_setting('statement_timeout') AS c, current_setting('jit') AS j", query: true },
    { sql: "SELECT set_config('app.user_id', 'u1', true) AS b, current_setting('app.user_id') AS c", query: true },
    { sql: "SELECT current_setting('app.user_id', true) AS u", query: true },
    { sql: "SET LOCAL statement_timeout = 1000" },
    { sql: "SHOW statement_timeout", query: true },
    { sql: "BEGIN" },
    { sql: "SELECT set_config('statement_timeout', '2000', true) AS a", query: true },
    { sql: "SHOW statement_timeout", query: true },
    { sql: "COMMIT" },
    { sql: "SHOW statement_timeout", query: true },
    { sql: "BEGIN" },
    { sql: "SET LOCAL app.committed = 'x'" },
    { sql: "COMMIT" },
    { sql: "BEGIN" },
    { sql: "SET LOCAL app.rolled_back = 'x'" },
    { sql: "ROLLBACK" },
    { sql: "SET LOCAL app.outside = 'x'" },
    {
      sql: "SELECT current_setting('app.committed', true) AS a, current_setting('app.rolled_back', true) AS b, current_setting('app.outside', true) AS c",
      query: true,
    },
  ],
);

// #717 timestamps inside json/jsonb are ISO 8601
const STAMPS = ["SET TIME ZONE 'UTC'"];
parity(
  "#717 to_json / to_jsonb of date-time values",
  STAMPS,
  `SELECT to_jsonb('2024-03-10 12:34:56.789+00'::timestamptz)::text AS a,
          to_json('2024-03-10 12:34:56.789+00'::timestamptz)::text AS b,
          to_json('2024-03-10 12:34:56'::timestamp)::text AS c,
          to_jsonb('2024-03-10'::date)::text AS d,
          to_json('12:34:56'::time)::text AS e,
          to_json('1 day'::interval)::text AS g`,
);
parity(
  "#717 json builders and aggregates",
  STAMPS,
  `SELECT jsonb_build_object('a', '2024-03-10 12:34:56+00'::timestamptz)::text AS a,
          json_build_object('a', '2024-03-10 12:34:56'::timestamp)::text AS b,
          json_build_array('2024-03-10 12:34:56'::timestamp)::text AS c,
          array_to_json(ARRAY['2024-03-10 12:34:56+00'::timestamptz])::text AS d,
          to_json(ARRAY['2024-03-10'::date])::text AS e,
          json_object_agg('k', '2024-03-10 12:34:56'::timestamp)::text AS f`,
);
parity(
  "#717 rows and aggregates",
  STAMPS,
  `SELECT row_to_json(t)::text AS a, to_jsonb(t)::text AS b,
          (SELECT jsonb_agg(x)::text FROM (VALUES ('2024-03-10 12:34:56.5+00'::timestamptz)) v(x)) AS c,
          (SELECT json_agg(x)::text FROM (VALUES ('2024-03-10 12:34:56.5+00'::timestamptz)) v(x)) AS d
   FROM (SELECT '2024-03-10 12:34:56'::timestamp AS a, '2024-03-10'::date AS d) t`,
);
parity(
  "#717 a timestamptz in JSON carries the session zone's offset",
  ["SET TIME ZONE 'Asia/Kolkata'"],
  "SELECT to_json('2024-03-10 12:34:56.789+00'::timestamptz)::text AS a, jsonb_build_object('a', '2024-03-10 12:34:56+00'::timestamptz)::text AS b",
);
parity(
  "#717 infinities and BC dates in JSON",
  STAMPS,
  `SELECT to_json('infinity'::timestamptz)::text AS a, to_json('-infinity'::date)::text AS b,
          to_json('0044-03-10 BC'::date)::text AS c, to_json('0044-03-10 12:00 BC'::timestamp)::text AS d,
          to_json('0044-03-10 12:00+00 BC'::timestamptz)::text AS e`,
);
parity(
  "#717 a json-building query over a table column",
  [
    "SET TIME ZONE 'UTC'",
    `CREATE TABLE ev (id int, "createdAt" timestamptz)`,
    `INSERT INTO ev VALUES (1, '2024-03-10 12:34:56.789+00')`,
  ],
  `SELECT jsonb_build_object('occurredAt', t."createdAt")->>'occurredAt' AS a FROM ev t`,
);

// #718 GROUP BY a primary key makes the table's other columns functionally dependent
const PK = [
  "CREATE TABLE t (id int PRIMARY KEY, name text, v int)",
  "INSERT INTO t VALUES (1, 'a', 1), (2, 'b', 2)",
  "CREATE TABLE u (a int, b int, c text, PRIMARY KEY (a, b))",
  "INSERT INTO u VALUES (1, 1, 'x')",
  "CREATE TABLE w (id int UNIQUE NOT NULL, n text)",
];
parity("#718 GROUP BY the primary key selects other columns", PK, "SELECT id, name FROM t GROUP BY id ORDER BY id");
parity(
  "#718 qualified, with an aggregate, and ORDER BY a dependent column",
  PK,
  "SELECT t.id, t.name, count(*) AS n FROM t GROUP BY t.id ORDER BY t.name",
);
parity("#718 t.* with GROUP BY the primary key", PK, "SELECT t.* FROM t GROUP BY id ORDER BY id");
parity("#718 a composite primary key", PK, "SELECT a, b, c FROM u GROUP BY a, b");
parity("#718 the primary key among other GROUP BY columns", PK, "SELECT id, name FROM t GROUP BY id, v ORDER BY id");
parity(
  "#718 a joined table grouped by its own primary key",
  PK,
  "SELECT x.id, x.name FROM t x JOIN t y ON x.id = y.id GROUP BY x.id ORDER BY x.id",
);
errorParity("#718 part of a composite key is not enough", PK, "SELECT a, c FROM u GROUP BY a", "grouping");
errorParity("#718 a unique key is not a primary key", PK, "SELECT id, n FROM w GROUP BY id", "grouping");
errorParity(
  "#718 the key of another table in the join does not cover it",
  PK,
  "SELECT x.id, y.name FROM t x JOIN t y ON x.id = y.id GROUP BY x.id",
  "grouping",
);
errorParity(
  "#718 a subquery has no primary key",
  PK,
  "SELECT s.id, s.name FROM (SELECT * FROM t) s GROUP BY s.id",
  "grouping",
);
errorParity(
  "#718 an expression over the key is not the key",
  PK,
  "SELECT id + 0, name FROM t GROUP BY id + 0",
  "grouping",
);
sequenceParity("#718 a view that relies on the dependency", PK, [
  { sql: "CREATE VIEW tv AS SELECT id, name, count(*) AS n FROM t GROUP BY id" },
  { sql: "SELECT * FROM tv ORDER BY id", query: true },
]);

// #719 a type name called as a function casts its argument
parityTyped(
  "#719 date(), text(), int4(), timestamptz()",
  ["SET TIME ZONE 'UTC'"],
  "SELECT date(now()) IS NOT NULL AS a, date('2024-03-10') AS b, text(1) AS c, int4('5') AS d, timestamptz('2024-03-10 00:00:00+00') AS e",
);
parityTyped(
  "#719 more type names callable as casts",
  ["SET TIME ZONE 'UTC'"],
  `SELECT date('2024-03-10 12:34:56'::timestamp) AS a, int8('7') AS b, float8('1.5') AS c, "numeric"('2.5') AS d,
          bool('t') AS e, "varchar"('ab') AS f, "timestamp"('2024-03-10 01:02:03') AS g, int2('3') AS h,
          float4(1) AS i, "interval"('1 day') AS j, name('n') AS k, bpchar('x') AS l, "date"('2024-01-01') AS m,
          text(true) AS n, int4(2.7) AS o, int4(2.5::numeric) AS p, text(1.50::numeric) AS q,
          timestamptz('2024-03-10'::date) AS r, date('2024-03-10 23:00-05'::timestamptz) AS s,
          uuid('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11') AS t, jsonb('{"a":1}') AS u, date(NULL) AS v, text(NULL) AS w`,
);
parity(
  "#719 DATE(col) in a reporting query",
  [
    "SET TIME ZONE 'UTC'",
    `CREATE TABLE orders (id int, "createdAt" timestamptz)`,
    "INSERT INTO orders VALUES (1, '2024-03-10 01:00+00'), (2, '2024-03-10 23:00+00'), (3, '2024-03-11 00:30+00')",
  ],
  `SELECT DATE("createdAt") AS day, count(*)::int AS n FROM orders GROUP BY DATE("createdAt") ORDER BY 1`,
);
errorParity("#719 an invalid input fails as the cast does", [], "SELECT int4('x')", "invalid_text_representation");
errorParity("#719 a bad date fails as the cast does", [], "SELECT date('foo')", "data_exception");
errorParity("#719 no cast from integer to date", [], "SELECT date(1)", "undefined_function");
errorParity("#719 a type name called with two arguments", [], "SELECT int4(1, 2)", "undefined_function");
parityTyped(
  "#719 a cast-style call over an empty table and in a view keeps its type",
  [
    `CREATE TABLE e (ts timestamptz, n text)`,
    `CREATE VIEW ev AS SELECT date(ts) AS d, int4(n) AS i, text(ts) AS t FROM e`,
  ],
  "SELECT date(ts) AS d, int4(n) AS i, (SELECT count(*)::int FROM ev) AS c FROM e UNION ALL SELECT d, i, 0 FROM ev",
);
