import { errorParity, parity, parityTyped, queryErrorParity, sequenceParity } from "../helpers.ts";

// Expression / function parity issues reported through a `pg` client, proven against the oracle.

// #673 an aggregate wrapped in an expression over an empty grouped input
const EMPTY = ["CREATE TABLE t (x int, y int, b bigint, n numeric, k text)"];
for (const [label, sql] of [
  ["max(x) + 0", "SELECT y, max(x) + 0 AS m FROM t GROUP BY y"],
  ["coalesce(sum(x), 0)", "SELECT y, coalesce(sum(x), 0) AS m FROM t GROUP BY y"],
  ["coalesce(sum() FILTER)", "SELECT y, coalesce(sum(b) FILTER (WHERE k = 'a'), 0) AS m FROM t GROUP BY y"],
  ["count(*) + 1", "SELECT y, count(*) + 1 AS m FROM t GROUP BY y"],
  ["round(avg(n), 2)", "SELECT y, round(avg(n), 2) AS m FROM t GROUP BY y"],
  ["min(k) || '!'", "SELECT y, min(k) || '!' AS m FROM t GROUP BY y"],
  ["ORDER BY max(x) + 0", "SELECT y FROM t GROUP BY y ORDER BY max(x) + 0"],
  ["ordered-set aggregate", "SELECT y, percentile_cont(0.5) WITHIN GROUP (ORDER BY x) + 1 AS m FROM t GROUP BY y"],
  ["HAVING", "SELECT y, max(x) + 0 AS m FROM t GROUP BY y HAVING count(*) > 0"],
  ["CTE", "WITH c AS (SELECT y, greatest(max(x), 0) AS m FROM t GROUP BY y) SELECT count(*)::int AS n FROM c"],
] as const) {
  parityTyped(`#673 ${label} over an empty grouped input`, EMPTY, sql);
}
sequenceParity("#673 a view over an empty table and a WHERE that filters every row", EMPTY, [
  { sql: "CREATE VIEW v AS SELECT y, coalesce(sum(b), 0) AS m FROM t GROUP BY y" },
  { sql: "SELECT count(*)::int AS n FROM v", query: true },
  { sql: "INSERT INTO t VALUES (1, 1, 10, 1.5, 'a')" },
  { sql: "SELECT y, max(x) + 0 AS m FROM t GROUP BY y", query: true },
  { sql: "SELECT y, max(x) + 0 AS m FROM t WHERE x > 5 GROUP BY y", query: true },
]);

// #674 named-notation calls to user-defined functions
const FNS = [
  "CREATE FUNCTION f(a int DEFAULT 1, b int DEFAULT 2) RETURNS int LANGUAGE sql AS $$ SELECT a * 10 + b $$",
  "CREATE FUNCTION g(a int, b int) RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN a - b; END $$",
  "CREATE FUNCTION s(lo int, hi int) RETURNS SETOF int LANGUAGE sql AS $$ SELECT generate_series(lo, hi) $$",
];
parity(
  "#674 named and mixed notation bind by name",
  FNS,
  "SELECT f() AS a, f(b => 5) AS b, f(b => 5, a => 7) AS c, f(7, b => 5) AS d, f(a := 3) AS e, g(b => 5, a => 10) AS h",
);
parity("#674 named notation in FROM", FNS, "SELECT * FROM s(hi => 3, lo => 2)");
queryErrorParity(
  "#674 a missing argument without a default is 42883",
  FNS,
  "SELECT g(b => 5) AS v",
  "undefined_function",
);
queryErrorParity("#674 an unknown parameter name is 42883", FNS, "SELECT f(c => 3) AS v", "undefined_function");
parity("#674 named arguments to a builtin still work", [], "SELECT make_interval(days => 2)::text AS v");

// #675 LIKE / ILIKE with ANY / SOME / ALL
parity(
  "#675 LIKE, ILIKE and their negations over an array",
  [],
  `SELECT 'abc' LIKE ANY(ARRAY['a%', 'z%']) AS a, 'ABC' ILIKE ANY(ARRAY['a%']) AS b,
          'abc' LIKE ALL(ARRAY['a%', '%c']) AS c, 'abc' LIKE ALL(ARRAY['a%', '%d']) AS d,
          'abc' NOT LIKE ANY(ARRAY['z%']) AS e, 'abc' NOT ILIKE ALL(ARRAY['z%']) AS f,
          'abc' LIKE SOME(ARRAY[NULL, 'z%']) AS g, NULL::text LIKE ANY(ARRAY['a']) AS h,
          'abc' LIKE ANY(ARRAY[]::text[]) AS i, 'abc' LIKE ANY('{a%,b%}') AS j`,
);
parity("#675 LIKE ANY over a bound array parameter", [], "SELECT 'abc' LIKE ANY($1::text[]) AS v", ["{a%}"]);
parity(
  "#675 LIKE ANY / NOT LIKE ALL over a subquery",
  [],
  "SELECT 'abc' LIKE ANY(SELECT 'a%' UNION ALL SELECT 'x') AS a, 'abc' NOT LIKE ALL(SELECT 'x%') AS b",
);

// #676 an untyped parameter multiplied with / dividing an interval resolves to float8
parity("#676 $1 * interval", [], "SELECT ($1 * interval '1 day')::text AS v", ["2"]);
parity("#676 interval * $1", [], "SELECT (interval '1 hour' * $1)::text AS v", ["3"]);
parity("#676 fractional factor", [], "SELECT ($1 * interval '1 day')::text AS v", ["1.5"]);
parity("#676 interval / $1", [], "SELECT (interval '1 hour' / $1)::text AS v", ["2"]);
parity("#676 interval * an unknown literal", [], "SELECT (interval '1 day' * '2')::text AS v");
parity(
  "#676 timestamptz minus a parameterised interval",
  ["SET TIME ZONE 'UTC'"],
  "SELECT (timestamptz '2026-01-01 00:00+00' - ($1 * interval '1 millisecond'))::text AS v",
  ["5000"],
);
queryErrorParity(
  "#676 unknown / interval has no operator",
  [],
  "SELECT '2' / interval '1 day' AS v",
  "undefined_function",
);

// #687 a row constructor compared with a multi-column subquery
const ROWS = ["CREATE TABLE t (x int, y int)", "INSERT INTO t VALUES (1, 1), (2, 1), (3, 2), (4, NULL)"];
parity("#687 (a, b) IN (SELECT a, b)", [], "SELECT (1, 2) IN (SELECT 1, 2) AS a, (1, 2) NOT IN (SELECT 1, 3) AS b");
parity("#687 IN over a UNION", ROWS, "SELECT x FROM t WHERE (x, y) IN (SELECT 1, 1 UNION ALL SELECT 3, 2) ORDER BY 1");
parity(
  "#687 IN over unnest of two array parameters",
  ROWS,
  "SELECT x FROM t WHERE (x, y) IN (SELECT * FROM unnest($1::int[], $2::int[])) ORDER BY 1",
  ["{1,3}", "{1,2}"],
);
parity("#687 NOT IN with a NULL field", ROWS, "SELECT x, (x, y) NOT IN (SELECT 1, 1) AS v FROM t ORDER BY 1");
parity(
  "#687 correlated row IN",
  ROWS,
  "SELECT x FROM t a WHERE (x, y) IN (SELECT b.x, b.y FROM t b WHERE b.x = a.x AND b.x < 3) ORDER BY 1",
);
parity(
  "#687 row comparison with a row subquery",
  ROWS,
  `SELECT (SELECT x FROM t WHERE (x, y) = (SELECT 3, 2)) AS a, (1, 2) = (SELECT 1, 2 WHERE false) AS b,
          (1, 2) <> (SELECT 1, 3) AS c, (1, 2) < (SELECT 1, 3) AS d,
          (1, 2) = ANY (SELECT 1, 2) AS e, (1, 2) <> ALL (SELECT x, y FROM t) AS f, ('a', 1) IN (SELECT 'a', 1) AS g`,
);
queryErrorParity("#687 too many subquery columns", [], "SELECT (1, 2) IN (SELECT 1, 2, 3) AS v");
queryErrorParity("#687 too few subquery columns", [], "SELECT (1, 2, 3) IN (SELECT 1, 2) AS v");
queryErrorParity(
  "#687 a row subquery returning two rows",
  [],
  "SELECT (1, 2) = (SELECT 1, 2 UNION ALL SELECT 1, 2) AS v",
);

// #688 a set-returning call nested in a select-list expression
parity(
  "#688 generate_series(date, date, interval)::date in the select list",
  [],
  "SELECT generate_series(date '2026-01-01', date '2026-03-01', interval '1 month')::date::text AS month",
);
parity(
  "#688 generate_series(timestamp, timestamp, interval) in the select list",
  [],
  "SELECT generate_series(timestamp '2026-01-01', timestamp '2026-01-02', interval '1 day')::text AS day",
);
parity(
  "#688 date bounds resolve to the timestamptz variant",
  [],
  "SELECT pg_typeof(g)::text AS t FROM generate_series(date '2026-01-01', date '2026-01-01', interval '1 day') g",
);
parity(
  "#688 SRFs inside arithmetic and casts",
  [],
  "SELECT generate_series(1, 3) * 10 AS n, unnest(ARRAY[1, 2])::text || '!' AS v, 'x' AS k",
);
parityTyped(
  "#688 a nested SRF over an empty input",
  ["CREATE TABLE e (a int)"],
  "SELECT generate_series(1, a) + 1 AS n FROM e",
);
sequenceParity(
  "#688 a view whose month spine is built in the select list",
  [],
  [
    {
      sql: "CREATE VIEW months AS SELECT generate_series(date_trunc('month', date '2026-01-15')::date, date '2026-03-01', interval '1 month')::date AS month",
    },
    { sql: "SELECT month::text FROM months", query: true },
    {
      sql: "WITH m AS (SELECT generate_series(date '2026-01-01', date '2026-02-01', interval '1 month')::date AS d) SELECT d::text FROM m",
      query: true,
    },
  ],
);

// #691 (1) power() and the other float8/numeric math functions resolve integer arguments to float8
parity(
  "#691 power(int, int) is double precision",
  [],
  "SELECT pg_typeof(power(2, 10))::text AS type, power(2, 10)::text AS value, pg_typeof(power(2.5, 2))::text AS n, power(2, 0.5)::text AS m",
);
parity(
  "#691 single-argument math functions on integers are double precision",
  [],
  `SELECT pg_typeof(exp(1))::text AS a, exp(0)::text AS b, ln(2)::text AS c, log(100)::text AS d, sqrt(4)::text AS e,
          pg_typeof(round(42))::text AS f, trunc(42)::text AS g, ceil(4)::text AS h, floor('4.7')::text AS i,
          pg_typeof(sign(-3))::text AS j, pg_typeof(round(NULL::int))::text AS k, abs(4)::text AS l`,
);
parity(
  "#691 round / trunc (numeric, scale) pad to the requested scale",
  [],
  "SELECT round(42, 1)::text AS a, round(4.2, 3)::text AS b, trunc(4.0, 2)::text AS c, round(1234, -2)::text AS d",
);
parity(
  "#691 float round is half-to-even",
  [],
  "SELECT round(0.5::float8)::text AS a, round(2.5::float8)::text AS b, round(-0.5::float8)::text AS c",
);
for (const sql of [
  "SELECT power(0, -1) AS v",
  "SELECT power(-8, 0.5::float8) AS v",
  "SELECT power(10, 400) AS v",
  "SELECT power(10, -400) AS v",
  "SELECT exp(1000) AS v",
  "SELECT exp(-1000) AS v",
]) {
  errorParity(`#691 float range errors: ${sql}`, [], sql);
}

// #691 (2) to_char numeric patterns, position by position
parity(
  "#691 to_char FM keeps the zero padding of 0 positions",
  [],
  `SELECT to_char(1234.5, 'FM9,999.00') AS a, to_char(0.5, 'FM990.00') AS b, to_char(1.0, 'FM9.9') AS c,
          to_char(5, 'FM000') AS d, to_char(-5, 'FM000') AS e, to_char(0, 'FM9.99') AS f, to_char(0, 'FM0.00') AS g,
          to_char(100, 'FM999D00') AS h, to_char(0.5, 'FM999.99') AS i, to_char(12, 'FM0,000') AS j,
          to_char(1.999, 'FM9.99') AS k, to_char(9.999, 'FM9.99') AS l, to_char(0.25, 'FM9.90') AS m`,
);
parity(
  "#691 to_char fill-mode-off layout",
  [],
  `SELECT '[' || to_char(0.5, '990.00') || ']' AS a, '[' || to_char(0.5, '999.99') || ']' AS b,
          '[' || to_char(0, '999') || ']' AS c, '[' || to_char(-5, '999') || ']' AS d, '[' || to_char(12, '9,999') || ']' AS e,
          '[' || to_char(-12, '9,999') || ']' AS f, '[' || to_char(5, '9G999') || ']' AS g, '[' || to_char(123, '99') || ']' AS h,
          '[' || to_char(-0.5, '999.99') || ']' AS i, '[' || to_char(7, '9099') || ']' AS j, '[' || to_char(-0.004, '9.99') || ']' AS k,
          '[' || to_char(12.5, 'S99.99') || ']' AS l, '[' || to_char(-12.5, '99.99MI') || ']' AS m, '[' || to_char(-12, '99S') || ']' AS n`,
);

// #691 (3) date_bin with an untyped stride literal
parity(
  "#691 date_bin('15 minutes', ...)",
  [],
  "SELECT date_bin('15 minutes', timestamp '2026-01-01 10:07', timestamp '2026-01-01')::text AS bin",
);
queryErrorParity(
  "#691 date_bin with a month stride",
  [],
  "SELECT date_bin('1 month', timestamp '2026-01-01 10:07', timestamp '2026-01-01') AS bin",
);

// #691 (4) a void result is not NULL (except from a LANGUAGE sql function)
parity(
  "#691 void results",
  [
    "CREATE FUNCTION vs() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$",
    "CREATE FUNCTION vp() RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$",
  ],
  `SELECT (pg_sleep(0) IS NOT NULL)::text AS a, pg_sleep(0)::text AS b, (pg_sleep(NULL) IS NULL)::text AS c,
          (setseed(0.5) IS NULL)::text AS d, (vs() IS NULL)::text AS e, (vp() IS NULL)::text AS f, vp()::text AS g`,
);

// #691 (5) ts_rank with a query that reduced to nothing; (6) websearch_to_tsquery
parity(
  "#691 ts_rank / ts_rank_cd over an empty tsquery",
  [],
  "SELECT ts_rank(to_tsvector('a b'), to_tsquery('a')) AS r, ts_rank_cd(to_tsvector('a b'), to_tsquery('a')) AS c, to_tsvector('a b') @@ to_tsquery('a') AS m",
);
for (const q of [
  "quick -dog",
  "The fat rats",
  '"supernovae stars" -crab',
  '"sad cat" or "fat rat"',
  'signal -"segmentation fault"',
  '""" )( dummy \\ query <->',
  '"fat the rat"',
  "or cat",
  "cat or",
  "cat or or dog",
  "cat - dog",
  "- - cat",
  "cat or -dog or mouse",
  "a b c or d e",
  '"unclosed phrase',
  "the",
  "",
]) {
  parity(
    `#691 websearch_to_tsquery(${JSON.stringify(q)})`,
    [],
    "SELECT websearch_to_tsquery('english', $1)::text AS q",
    [q],
  );
}
parity(
  "#691 websearch_to_tsquery with the simple configuration and the default one",
  [],
  "SELECT websearch_to_tsquery('simple', 'The fat rats')::text AS a, websearch_to_tsquery('quick -dog')::text AS b, to_tsvector('the quick brown fox') @@ websearch_to_tsquery('english', 'quick -dog') AS m",
);
parity(
  "#691 tsquery output chains & and | without parentheses",
  [],
  `SELECT to_tsquery('simple', 'a & b & c')::text AS a, to_tsquery('simple', 'a | (b | c)')::text AS b,
          to_tsquery('simple', 'a <-> b <-> c')::text AS c, to_tsquery('simple', 'a <-> (b <-> c)')::text AS d,
          to_tsquery('simple', 'a & (b | c)')::text AS e, to_tsquery('simple', '!(a & b)')::text AS f`,
);
