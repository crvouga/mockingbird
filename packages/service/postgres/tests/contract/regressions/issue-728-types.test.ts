import { errorParity, parity, parityTyped, queryErrorParity, sequenceParity } from "../helpers.ts";

// Issue #728: type and function mismatches. Every case is differential against the oracle; values that
// depend on the clock or on randomness are compared through relations, lengths and patterns.

// --- 1. special datetime input words -------------------------------------------------------------

parity(
  "#728 'today' / 'now' / 'tomorrow' / 'yesterday' read the transaction clock",
  [],
  `SELECT 'today'::date = current_date AS today,
          'now'::timestamptz = now() AS now_tz,
          'tomorrow'::date - 'yesterday'::date AS span,
          'now'::timestamp = localtimestamp AS now_ts,
          'now'::time = localtime AS now_time,
          'now'::date = current_date AS now_date,
          ' NOW '::date = current_date AS spaced,
          'Today'::date = current_date AS cased,
          'today'::date + 1 = 'tomorrow'::date AS plus_one,
          'yesterday'::timestamp = localtimestamp::date - 1 AS yesterday_ts`,
);
parity(
  "#728 day words as timestamps, with a time and a zone",
  [],
  `SELECT 'today'::timestamp = current_date::timestamp AS ts,
          'today'::timestamptz = date_trunc('day', now()) AS tz,
          'today 10:00'::timestamp - 'today'::timestamp AS at_ten,
          'tomorrow'::timestamptz - 'today'::timestamptz AS one_day,
          'today +02'::timestamptz = 'today'::timestamptz - interval '2 hours' AS zoned,
          'today'::timestamptz AT TIME ZONE 'UTC' = current_date::timestamp AS utc`,
);
sequenceParity(
  "#728 day words follow the session TimeZone",
  [],
  [
    { sql: "SET TIME ZONE 'Asia/Tokyo'" },
    {
      sql: `SELECT 'today'::timestamptz = date_trunc('day', now()) AS midnight, 'now'::date = current_date AS d,
                 'today'::timestamptz::date = current_date AS round_trip, 'tomorrow 12:30'::timestamptz - 'today'::timestamptz AS later`,
      query: true,
    },
  ],
);
parity(
  "#728 epoch, infinity and allballs",
  [],
  `SELECT 'epoch'::date, 'epoch'::timestamp, 'epoch'::timestamptz, 'infinity'::date, '-infinity'::timestamp,
          'infinity'::timestamptz, 'allballs'::time, 'allballs'::timetz`,
);
queryErrorParity("#728 'today' is not a time", [], "SELECT 'today'::time");
queryErrorParity("#728 'epoch' is not a time", [], "SELECT 'epoch'::time");
queryErrorParity("#728 'now' is not an interval", [], "SELECT 'now'::interval");
queryErrorParity("#728 a day word with junk", [], "SELECT 'todayx'::date");

// --- 2. interval unit abbreviations -------------------------------------------------------------

parity(
  "#728 interval abbreviations glued to their numbers",
  [],
  `SELECT interval '1h' AS a, interval '15m' AS b, interval '2d 3h' AS c, interval '1h30m' AS d, interval '10s' AS e,
          interval '1y 2mon' AS f, interval '3w' AS g, interval '1Y2Mon3D' AS h, interval '1day' AS i, interval '1.5h' AS j,
          interval '1y1m' AS k, interval '1d,2h' AS l`,
);
parity(
  "#728 every deltatktbl unit spelling",
  [],
  `SELECT interval '1 hr', interval '2 mins', interval '3 secs', interval '5 msec', interval '7 usec', interval '1 c',
          interval '2 cent', interval '1 dec', interval '3 decs', interval '1 mil', interval '2 mils', interval '5 mseconds',
          interval '5 msecs', interval '5 useconds', interval '5 usecs', interval '5 milliseconds', interval '5 microseconds',
          interval '5 millisecondsxx', interval '2 yrs 3 hrs', interval '1 millennia', interval '3 centuries', interval '2 decades'`,
);
parity(
  "#728 interval signs, ago, trailing seconds and time fields",
  [],
  `SELECT interval '-1h', interval '+1h -30m', interval '1h ago', interval '@ 1 day', interval '1 day at', interval '- 1 day',
          interval '1h 30', interval '1 1:30', interval '3 4:05', interval '1 +02:03', interval '1:30.5',
          interval '1-2 3 4:05:06', interval '.5 h', interval '1 mon 2', interval '1 week ago'`,
);
parity(
  "#728 fractional interval units spill like PostgreSQL",
  [],
  `SELECT interval '1.04 years', interval '1.05 years', interval '1.5 months', interval '1.5 weeks', interval '-1.5 hours',
          interval '0.5 mil', interval '1.234 dec', interval '1.123456789 s', interval '1 day 1:30:15.123456789'`,
);
for (const text of [
  "1 qtr",
  "3w2d",
  "1mins2s",
  "5 ago",
  "1 ago 2 days",
  "1 2",
  "1.5 s 3 ms",
  "1 d 1 d",
  "1 hour 1 hour",
  "1e3 s",
]) {
  queryErrorParity(`#728 interval '${text}' is rejected`, [], `SELECT interval '${text}'`);
}
for (const text of ["99999999999 years", "25:61", "2147483648 days"]) {
  queryErrorParity(`#728 interval '${text}' is out of range`, [], `SELECT interval '${text}'`);
}

// --- 3. date_trunc / to_char / date_bin / timezone on a date resolve to timestamptz ----------------

parityTyped("#728 date_trunc(text, date) is timestamptz", [], "SELECT date_trunc('month', date '2024-03-15') AS t");
parity(
  "#728 date_trunc(text, date) fields and nulls",
  [],
  `SELECT pg_typeof(date_trunc('month', current_date)), date_trunc('year', date '2024-03-15'),
          date_trunc('hour', date '2024-03-15'), pg_typeof(date_trunc('day', null::date)), date_trunc('day', 'infinity'::date)`,
);
sequenceParity(
  "#728 a date truncates in the session zone",
  [],
  [
    { sql: "SET TIME ZONE 'Asia/Tokyo'" },
    {
      sql: `SELECT date_trunc('month', date '2024-03-15') AS m, date_trunc('week', date '2024-03-15') AS w,
                 date_trunc('month', date '2024-03-15', 'UTC') AS z, to_char(date '2024-03-10', 'YYYY-MM-DD HH24 OF') AS c,
                 date_bin('1 hour', date '2024-03-15', date '2024-01-01') AS b, pg_typeof(date_bin('1 hour', date '2024-03-15', date '2024-01-01')) AS bt,
                 date_bin('1 day', date '2024-03-15', timestamp '2024-01-01') AS bts,
                 timezone('UTC', date '2024-03-10') AS tz1, date '2024-03-10' AT TIME ZONE 'UTC' AS tz2`,
      query: true,
    },
  ],
);
parity(
  "#728 to_char of infinity is NULL",
  [],
  "SELECT to_char(date 'infinity', 'YYYY'), to_char(timestamp 'infinity', 'YYYY')",
);

// --- 4. to_char ISO week-numbering patterns -------------------------------------------------------

for (const d of [
  "2024-03-10",
  "2024-12-30",
  "2025-01-01",
  "2021-01-03",
  "2020-12-31",
  "2005-01-01",
  "2008-12-29",
  "2010-01-03",
  "0500-01-01",
]) {
  parity(
    `#728 to_char ISO patterns on ${d}`,
    [],
    `SELECT to_char(timestamp '${d} 13:05:09', 'ID IDDD IYYY IYY IY I IW'),
            to_char(timestamp '${d}', 'FMIDDD FMIYYY FMIYY FMIY FMI FMIW FMID'),
            to_char(timestamp '${d}', 'IYYY-IW-ID')`,
  );
}
parity(
  "#728 to_char lower-case keywords, FM scope and SSSSS",
  [],
  `SELECT to_char(timestamp '2024-03-10', 'iddd id iw iyyy iyy iy i'), to_char(timestamp '2024-03-10', 'IDDDID IYYYIW I-IY'),
          to_char(timestamp '2024-03-10 13:00', 'SSSSS SSSS'), to_char(timestamp '2024-03-10', 'yyyy-mm-dd hh24:mi:ss'),
          to_char(timestamp '2024-03-05 08:07:06.5', 'FMMonth FMDay FMDD FMHH24 MM DD HH12 FMMI'),
          to_char(timestamp '2024-03-05 08:07:06.5', 'fmdd-mm-yyyy hh12:mi am'),
          to_char(timestamp '2024-03-05 08:07:06.5', 'Dy, DD Mon YYYY "at" HH24:MI:SS.MS US q cc j ww w ddd d')`,
);

// --- 5. array_agg over arrays -----------------------------------------------------------------

parityTyped(
  "#728 array_agg of an array adds a dimension",
  [],
  "SELECT array_agg(arr) AS a FROM (VALUES (array['a','b'])) v(arr)",
);
parity(
  "#728 array_agg of arrays keeps order, nulls inside, lower bounds and depth",
  [],
  `SELECT (SELECT array_agg(arr) FROM (VALUES (array[1,2]),(array[3,4])) v(arr)) AS c1,
          (SELECT array_agg(arr ORDER BY arr DESC) FROM (VALUES (array[1,2]),(array[3,4])) v(arr)) AS c2,
          (SELECT array_agg(arr) FROM (VALUES (array[1,null]),(array[null,3])) v(arr)) AS c3,
          (SELECT array_agg(arr) FROM (VALUES (array[[1,2],[3,4]]),(array[[5,6],[7,8]])) v(arr)) AS c4,
          (SELECT array_agg(arr) FROM (VALUES ('[0:1]={1,2}'::int[]),('[0:1]={3,4}'::int[])) v(arr)) AS c5,
          (SELECT array_agg(x) FROM (SELECT array[1,2] x WHERE false) s) AS c6`,
);
queryErrorParity(
  "#728 array_agg of arrays of different dimensions",
  [],
  "SELECT array_agg(arr) FROM (VALUES (array[1,2]),(array[3])) v(arr)",
  "data_exception",
);
queryErrorParity(
  "#728 array_agg of arrays with different lower bounds",
  [],
  "SELECT array_agg(arr) FROM (VALUES ('[0:1]={1,2}'::int[]),('{3,4}'::int[])) v(arr)",
  "data_exception",
);
queryErrorParity(
  "#728 array_agg of a null array",
  [],
  "SELECT array_agg(arr) FROM (VALUES (array[1,2]),(null)) v(arr)",
  "data_exception",
);
queryErrorParity(
  "#728 array_agg of an empty array",
  [],
  "SELECT array_agg(arr) FROM (VALUES ('{}'::int[])) v(arr)",
  "data_exception",
);

// --- 6. percentile_cont / percentile_disc with an array of fractions, and on interval ------------

parityTyped(
  "#728 percentile_cont(float8[]) is float8[]",
  [],
  "SELECT percentile_cont(array[0.5,0.9]::float8[]) WITHIN GROUP (ORDER BY x) AS p FROM generate_series(1,10) x",
);
parityTyped(
  "#728 percentile_disc(float8[]) is the sort type's array",
  [],
  "SELECT percentile_disc(array[0.5,0.9,1]) WITHIN GROUP (ORDER BY x) AS p FROM generate_series(1,10) x",
);
parity(
  "#728 percentile arrays: nulls, shape, text, interval, empty",
  [],
  `SELECT (SELECT percentile_cont(array[0.5,null,0]) WITHIN GROUP (ORDER BY x) FROM generate_series(1,10) x) AS c1,
          (SELECT percentile_disc(array[[0.5,0.2],[0.1,1]]) WITHIN GROUP (ORDER BY x) FROM generate_series(1,10) x) AS c2,
          (SELECT percentile_disc(array[0.25,0.75]) WITHIN GROUP (ORDER BY x) FROM (VALUES ('a'),('b'),('c'),('d')) v(x)) AS c3,
          (SELECT percentile_cont(array[0.25,0.75]) WITHIN GROUP (ORDER BY x) FROM (VALUES (interval '1 hour'),(interval '3 hours')) v(x)) AS c4,
          (SELECT percentile_cont('{}'::float8[]) WITHIN GROUP (ORDER BY x) FROM generate_series(1,10) x) AS c5,
          (SELECT percentile_cont(array[0.5]) WITHIN GROUP (ORDER BY x) FROM generate_series(1,10) x WHERE false) AS c6,
          (SELECT percentile_cont(null::float8[]) WITHIN GROUP (ORDER BY x) FROM generate_series(1,10) x) AS c7`,
);
parityTyped(
  "#728 percentile_cont over interval interpolates intervals",
  [],
  `SELECT percentile_cont(0.25) WITHIN GROUP (ORDER BY x) AS p
     FROM (VALUES (interval '1 day'),(interval '1 mon 3 hours')) v(x)`,
);
queryErrorParity(
  "#728 percentile fraction out of range",
  [],
  "SELECT percentile_cont(array[1.5]) WITHIN GROUP (ORDER BY x) FROM generate_series(1,10) x",
  "numeric_out_of_range",
);
parity("#728 mode()", [], "SELECT mode() WITHIN GROUP (ORDER BY x) FROM (VALUES (1),(2),(2),(3)) v(x)");

// --- 7. time with time zone -------------------------------------------------------------------

parityTyped(
  "#728 timetz input and output",
  [],
  `SELECT '12:00:00+02'::timetz AS a, '12:00'::timetz AS b, '12:00:00.123456-05:30'::timetz AS c,
          '23:59:59.9999999+14'::timetz AS d, '12:00 UTC'::timetz AS e, '12:00Z'::timetz AS f, '1:2:3 +1'::timetz AS g,
          '12:00+15'::timetz AS h, '24:00:00+02'::timetz AS i, '12:00:00.123456+02'::timetz(2) AS j`,
);
parity(
  "#728 timetz types of current_time and friends",
  [],
  "SELECT pg_typeof('12:00+02'::timetz), pg_typeof(current_time), pg_typeof(localtime), 'now'::timetz = current_time, current_time = localtime::timetz",
);
parity(
  "#728 timetz comparisons order by instant, then zone",
  [],
  `SELECT '12:00+02'::timetz = '10:00+00'::timetz, '12:00+02'::timetz < '10:00+00'::timetz,
          '12:00+02'::timetz > '10:00+00'::timetz, '12:00+02'::timetz = '12:00+02'::timetz,
          '12:00+02'::timetz <> '10:00+00'::timetz, '12:00+02'::timetz IN ('10:00+00'::timetz, '12:00+02'::timetz)`,
);
parity(
  "#728 timetz sorts, groups and aggregates",
  [],
  `SELECT (SELECT array_agg(x ORDER BY x) FROM (VALUES ('12:00+02'::timetz),('10:00+00'::timetz),('11:00+00'::timetz),('09:00-02'::timetz)) v(x)) AS c1,
          (SELECT count(DISTINCT x) FROM (VALUES ('12:00+02'::timetz),('10:00+00'::timetz),('12:00+02'::timetz)) v(x)) AS c2,
          (SELECT max(x)::text || ' ' || min(x)::text FROM (VALUES ('12:00+02'::timetz),('10:00+00'::timetz)) v(x)) AS c3`,
);
parity(
  "#728 timetz casts, arithmetic and AT TIME ZONE",
  [],
  `SELECT '12:00+02'::timetz::time, '12:00'::time::timetz, timestamptz '2024-01-01 10:00+00'::timetz,
          timestamptz 'infinity'::timetz, '12:00+02'::timetz + interval '1 hour', interval '1 hour' + '12:00+02'::timetz,
          '12:00+02'::timetz - interval '13 hours', date '2024-01-01' + '12:00+02'::timetz,
          '12:00+02'::timetz AT TIME ZONE 'UTC', '12:00+02'::timetz AT TIME ZONE 'Asia/Tokyo',
          '12:00+02'::timetz AT TIME ZONE interval '+03:00', time '12:00' AT TIME ZONE 'Asia/Tokyo',
          timetz(time '12:00'), timetz('12:00:00.77+02'::timetz, 0), timetz(time '12:00:00.55', 1)`,
);
parity(
  "#728 timetz extract, text and JSON",
  [],
  `SELECT extract(hour FROM '12:30+02'::timetz), extract(timezone FROM '12:30+02'::timetz),
          extract(timezone_hour FROM '12:30-05:30'::timetz), extract(epoch FROM '12:30+02'::timetz),
          '12:00+02'::timetz::text, to_json('12:00+02'::timetz), to_jsonb('12:00+02'::timetz),
          '{12:00+02,13:00-01}'::timetz[], array['12:00+02'::timetz]`,
);
sequenceParity(
  "#728 timetz columns",
  ["CREATE TABLE ttz (a timetz, b time with time zone)"],
  [
    { sql: "INSERT INTO ttz VALUES ('12:00+02', '13:00'), ('01:02:03-07', null)" },
    { sql: "SELECT * FROM ttz ORDER BY a", query: true },
    { sql: "SELECT a::time, b FROM ttz WHERE a > '00:00+00' ORDER BY a", query: true },
  ],
);
sequenceParity(
  "#728 timetz without a zone takes the session zone",
  [],
  [
    { sql: "SET TIME ZONE 'Asia/Tokyo'" },
    {
      sql: "SELECT '12:00'::timetz AS a, '12:00'::time::timetz AS b, timestamptz '2024-07-01 10:00+00'::timetz AS c",
      query: true,
    },
  ],
);
queryErrorParity("#728 timetz garbage", [], "SELECT 'abc'::timetz");
queryErrorParity("#728 timetz hour out of range", [], "SELECT '25:00+02'::timetz");
queryErrorParity("#728 timetz with a full zone name", [], "SELECT '12:00 America/New_York'::timetz");
queryErrorParity(
  "#728 timetz(timestamptz, int) does not exist",
  [],
  "SELECT timetz(timestamptz '2024-01-01 10:00+00', 1)",
  "undefined_function",
);

// --- 8. AT LOCAL ------------------------------------------------------------------------------

parityTyped(
  "#728 AT LOCAL on timestamptz and timestamp",
  [],
  "SELECT timestamptz '2024-01-01 00:00:00+00' AT LOCAL AS a, timestamp '2024-01-01 00:00:00' AT LOCAL AS b",
);
sequenceParity(
  "#728 AT LOCAL uses the session TimeZone",
  [],
  [
    { sql: "SET TIME ZONE 'Asia/Tokyo'" },
    {
      sql: `SELECT timestamptz '2024-01-01 00:00:00+00' AT LOCAL AS a, timestamp '2024-01-01 00:00:00' AT LOCAL AS b,
                 date '2024-03-10' AT LOCAL AS c, now() AT LOCAL = localtimestamp AS d, '12:00+02'::timetz AT LOCAL AS e`,
      query: true,
    },
  ],
);

// --- 9. text || bool ------------------------------------------------------------------------------

parityTyped("#728 text || boolean", [], "SELECT 'a' || true AS a, true || 'b' AS b");

// --- 10. pgcrypto hmac / gen_random_bytes / crypt / gen_salt, and uuid-ossp ----------------------

const PGCRYPTO = ["CREATE EXTENSION pgcrypto"];
parity(
  "#728 hmac over every digest",
  PGCRYPTO,
  `SELECT encode(hmac('data', 'key', 'md5'), 'hex'), encode(hmac('data'::bytea, 'key'::bytea, 'sha256'), 'hex'),
          encode(hmac('d', 'k', 'sha1'), 'hex'), encode(hmac('d', 'k', 'sha224'), 'hex'), encode(hmac('d', 'k', 'SHA-256'), 'hex'),
          encode(hmac('d', 'k', 'sha384'), 'hex'), encode(hmac(repeat('x', 300), repeat('k', 200), 'sha512'), 'hex'),
          encode(hmac('', '', 'sha1'), 'hex'), hmac(null::text, 'k', 'md5'), pg_typeof(hmac('a', 'b', 'md5'))`,
);
queryErrorParity(
  "#728 hmac with an unknown algorithm",
  PGCRYPTO,
  "SELECT hmac('d', 'k', 'whirlpool')",
  "invalid_parameter",
);
parity(
  "#728 gen_random_bytes length and type",
  PGCRYPTO,
  "SELECT length(gen_random_bytes(16)), length(gen_random_bytes(1024)), pg_typeof(gen_random_bytes(1))",
);
queryErrorParity("#728 gen_random_bytes(0)", PGCRYPTO, "SELECT gen_random_bytes(0)");
queryErrorParity("#728 gen_random_bytes(1025)", PGCRYPTO, "SELECT gen_random_bytes(1025)");
parity(
  "#728 crypt md5 and bcrypt match for a given salt",
  PGCRYPTO,
  `SELECT crypt('password', '$1$saltsalt$'), crypt('password', '$1$abc'), crypt('', '$1$abc$'), crypt('a', '$1$$'),
          crypt('héllo', '$1$saltsalt$'), crypt('password', '$1$toolongsaltvalue$'),
          crypt('verylongpassword_verylongpassword_123', '$1$x'),
          crypt('password', '$2a$06$abcdefghijklmnopqrstuu'), crypt('password', '$2a$04$Ro0CUfOqk6cXEKf3dyaM7O'),
          crypt('', '$2a$04$Ro0CUfOqk6cXEKf3dyaM7O'), crypt('password', '$2a$04$abcdefghijklmnopqrstuv'),
          crypt('a much longer password that exceeds seventy two bytes in total length.......xyz', '$2a$04$Ro0CUfOqk6cXEKf3dyaM7O'),
          crypt('pässwörd', '$2a$05$abcdefghijklmnopqrstuu'), crypt('pässwörd', '$2x$05$abcdefghijklmnopqrstuu')`,
);
parity(
  "#728 crypt sha-crypt and DES match for a given salt",
  PGCRYPTO,
  `SELECT crypt('password', '$5$rounds=1000$abc'), crypt('password', '$6$abc'), crypt('password', '$5$rounds=10$abc'),
          crypt('password', '$5$rounds=$abc'), crypt('', '$5$abc'), crypt('password', '$6$$'),
          crypt('password', '$6$rounds=1000$saltsaltsaltsaltsaltsalt$'),
          crypt('password', 'ab'), crypt('password', '_J9..abcd'), crypt('averylongpasswordthatexceedseight', '_J9..abcd'),
          crypt('averylongpasswordthatexceedseight', 'zz'), crypt('', 'ab'), crypt('password', 'a:'), crypt('password', '$1'),
          crypt('password', '$2y$04$Ro0CUfOqk6cXEKf3dyaM7O'), crypt(null, 'ab')`,
);
for (const salt of [
  "",
  "x",
  "$2a$03$abcdefghijklmnopqrstuu",
  "$2a$04$abc",
  "$2a$04$abcdefghijklmnopqrstu!",
  "$5$rounds=abc$x",
  "$2$04$abcdefghijklmnopqrstuu",
]) {
  queryErrorParity(`#728 crypt rejects the salt '${salt}'`, PGCRYPTO, `SELECT crypt('password', '${salt}')`);
}
parity(
  "#728 gen_salt formats and round-trips through crypt",
  PGCRYPTO,
  `SELECT gen_salt('md5') ~ '^\\$1\\$[./0-9A-Za-z]{8}$', gen_salt('bf') ~ '^\\$2a\\$06\\$[./0-9A-Za-z]{22}$',
          gen_salt('bf', 8) ~ '^\\$2a\\$08\\$', gen_salt('des') ~ '^[./0-9A-Za-z]{2}$', gen_salt('xdes') ~ '^_J9\\.\\.[./0-9A-Za-z]{4}$',
          gen_salt('xdes', 1001) ~ '^_dD\\.\\.', gen_salt('sha256crypt') ~ '^\\$5\\$rounds=5000\\$[./0-9A-Za-z]{16}$',
          gen_salt('sha512crypt', 1000) ~ '^\\$6\\$rounds=1000\\$', gen_salt('MD5') ~ '^\\$1\\$', gen_salt('bf', 0) ~ '^\\$2a\\$06\\$',
          gen_salt('md5', 1000) ~ '^\\$1\\$', gen_salt('des', 25) ~ '^..$', pg_typeof(gen_salt('md5')), gen_salt(null)`,
);
parity(
  "#728 crypt(pw, gen_salt(...)) verifies",
  PGCRYPTO,
  `SELECT crypt('secret', s) = crypt('secret', crypt('secret', s)) FROM
     (VALUES (gen_salt('bf', 4)), (gen_salt('md5')), (gen_salt('des')), (gen_salt('xdes', 3)), (gen_salt('sha256crypt'))) v(s)`,
);
for (const call of [
  "gen_salt('xdes', 2)",
  "gen_salt('bf', 3)",
  "gen_salt('bf', 32)",
  "gen_salt('md5', 10)",
  "gen_salt('des', 10)",
  "gen_salt('sha256crypt', 999)",
  "gen_salt('foo')",
]) {
  queryErrorParity(`#728 ${call} fails`, PGCRYPTO, `SELECT ${call}`, "invalid_parameter");
}

const UUID_OSSP = ['CREATE EXTENSION "uuid-ossp"'];
queryErrorParity("#728 uuid-ossp functions need the extension", [], "SELECT uuid_generate_v4()", "undefined_function");
parity(
  "#728 uuid-ossp constants and name-based UUIDs",
  UUID_OSSP,
  `SELECT uuid_nil(), uuid_ns_dns(), uuid_ns_url(), uuid_ns_oid(), uuid_ns_x500(),
          uuid_generate_v3(uuid_ns_dns(), 'www.example.com'), uuid_generate_v5(uuid_ns_dns(), 'www.example.com'),
          uuid_generate_v5(uuid_ns_url(), ''), uuid_generate_v3(uuid_ns_url(), 'héllo'),
          uuid_generate_v3(null, 'x'), uuid_generate_v5(uuid_ns_dns(), null)`,
);
parity(
  "#728 uuid-ossp random and time-based UUIDs have the right shape",
  UUID_OSSP,
  `SELECT uuid_generate_v4()::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
          uuid_generate_v1()::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
          uuid_generate_v1mc()::text ~ '-1[0-9a-f]{3}-[89ab]', pg_typeof(uuid_generate_v4()), uuid_generate_v4() <> uuid_generate_v4()`,
);
parity(
  "#728 uuid-ossp catalog rows",
  UUID_OSSP,
  `SELECT (SELECT array_agg(name || ' ' || default_version || ' ' || installed_version || ' ' || comment) FROM pg_available_extensions WHERE name = 'uuid-ossp') AS ext,
          (SELECT array_agg(version ORDER BY version) FROM pg_available_extension_versions WHERE name = 'uuid-ossp') AS versions,
          (SELECT array_agg(p.proname || ' ' || p.provolatile::text || ' ' || p.proisstrict::text ORDER BY p.proname)
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public') AS procs`,
);
errorParity(
  "#728 DROP EXTENSION uuid-ossp removes its functions",
  [...UUID_OSSP, 'DROP EXTENSION "uuid-ossp"'],
  "SELECT uuid_nil()",
);
