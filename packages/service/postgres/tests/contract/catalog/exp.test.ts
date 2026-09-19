import { expect } from "bun:test";
import { EXP_SECTION } from "../../../compat/sections/exp.ts";
import { runCatalog } from "./run.ts";

runCatalog(EXP_SECTION, [
  { id: "EXP-arith-01", kind: "parity", sql: "SELECT 7 / 2 AS a, -7 / 2 AS b, 7 / -2 AS c" },
  { id: "EXP-arith-02", kind: "parity", sql: "SELECT 7 % 3 AS a, -7 % 3 AS b, 7 % -3 AS c, -7 % -3 AS d" },
  { id: "EXP-arith-03", kind: "error", sql: "SELECT 1 / 0", query: true, messageTier: "A" },
  { id: "EXP-arith-04", kind: "error", sql: "SELECT 1 % 0", query: true, messageTier: "A" },
  { id: "EXP-arith-05", kind: "error", sql: "SELECT 1.0 / 0", query: true, messageTier: "A" },
  { id: "EXP-arith-06", kind: "parity", sql: "SELECT 1 + 2.5 AS a, 2 * 1.5::float8 AS b, 10::numeric / 4 AS c" },
  { id: "EXP-arith-07", kind: "parity", sql: "SELECT 2 ^ 10 AS a, 2.0 ^ 0.5 AS b, pg_typeof(2 ^ 10)::text AS t" },
  { id: "EXP-concat-01", kind: "parity", sql: "SELECT 'a' || NULL AS a, NULL || 'b' AS b" },
  {
    id: "EXP-concat-02",
    kind: "parity",
    sql: "SELECT 1 || 'a' AS a, 'a' || 1 AS b, 1.5 || 'x' AS c, true || 'x' AS d",
  },
  { id: "EXP-concat-03", kind: "error", sql: "SELECT 1 || 2", query: true, messageTier: "A" },
  {
    id: "EXP-null-01",
    kind: "parity",
    sql: "SELECT (NULL = NULL) IS NULL AS a, (NULL <> 1) IS NULL AS b, (NULL < NULL) IS NULL AS c, '' IS NULL AS d",
  },
  {
    id: "EXP-dist-01",
    kind: "parity",
    sql: "SELECT NULL IS DISTINCT FROM NULL AS a, NULL IS DISTINCT FROM 1 AS b, 1 IS DISTINCT FROM 2 AS c, NULL IS NOT DISTINCT FROM NULL AS d",
  },
  {
    id: "EXP-between-01",
    kind: "parity",
    sql: "SELECT 1 BETWEEN 1 AND 3 AS lo, 3 BETWEEN 1 AND 3 AS hi, 3 BETWEEN SYMMETRIC 5 AND 1 AS sym",
  },
  {
    id: "EXP-between-02",
    kind: "parity",
    sql: "SELECT (2 BETWEEN NULL AND 3) IS NULL AS a, 2 BETWEEN 3 AND NULL AS b",
  },
  {
    id: "EXP-in-01",
    kind: "parity",
    sql: "SELECT (1 NOT IN (2, NULL)) IS NULL AS a, 2 IN (2, NULL) AS b, (1 IN (2, NULL)) IS NULL AS c",
  },
  {
    id: "EXP-in-02",
    kind: "parity",
    setup: ["CREATE TABLE t (n int)", "INSERT INTO t VALUES (NULL), (2)"],
    sql: "SELECT (1 NOT IN (SELECT n FROM t)) IS NULL AS a, 2 IN (SELECT n FROM t) AS b",
  },
  {
    id: "EXP-in-03",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (n int); INSERT INTO t VALUES (1), (2)");
      expect(() => db.query("SELECT (1, 2) IN (SELECT n, n + 1 FROM t) AS v")).toThrow(/too many columns/);
    },
  },
  { id: "EXP-case-01", kind: "parity", sql: "SELECT CASE WHEN NULL THEN 'y' ELSE 'n' END AS v" },
  {
    id: "EXP-case-02",
    kind: "parity",
    setup: ["CREATE TABLE t (n int)", "INSERT INTO t VALUES (0), (2)"],
    sql: "SELECT CASE WHEN n = 0 THEN -1 ELSE 10 / n END AS v FROM t ORDER BY n",
  },
  { id: "EXP-cond-01", kind: "parity", sql: "SELECT COALESCE(NULL, NULL, 3) AS a, COALESCE(NULL::int) IS NULL AS b" },
  {
    id: "EXP-cond-02",
    kind: "parity",
    sql: "SELECT NULLIF(1, 1) IS NULL AS a, NULLIF(2, 1) AS b, NULLIF('a', 'b') AS c",
  },
  {
    id: "EXP-cond-03",
    kind: "parity",
    sql: "SELECT GREATEST(1, 5, 3) AS g, LEAST(1, 5, 3) AS l, GREATEST(1, NULL, 3) AS gn, LEAST(NULL::int, NULL) IS NULL AS alln",
  },
  {
    id: "EXP-bool-01",
    kind: "parity",
    sql: "SELECT (true OR NULL) AS a, (false AND NULL) AS b, (true AND NULL) IS NULL AS c, (NOT NULL::bool) IS NULL AS d",
  },
  {
    id: "EXP-bool-02",
    kind: "parity",
    sql: "SELECT NULL::bool IS TRUE AS a, NULL::bool IS FALSE AS b, NULL::bool IS UNKNOWN AS c, false IS NOT TRUE AS d",
  },
  {
    id: "EXP-like-01",
    kind: "parity",
    sql: "SELECT 'abc' LIKE 'ABC' AS a, 'abc' ILIKE 'ABC' AS b, 'aXc' LIKE 'a_c' AS c, 'abc' LIKE 'a%' AS d",
  },
  {
    id: "EXP-like-02",
    kind: "parity",
    sql: "SELECT '50%' LIKE '50!%' ESCAPE '!' AS a, 'a_b' LIKE 'a\\_b' AS b, '100%' LIKE '%\\%%' AS c",
  },
  { id: "EXP-like-03", kind: "parity", sql: "SELECT NULL LIKE 'a' AS a, 'a' LIKE NULL AS b" },
  {
    id: "EXP-similar-01",
    kind: "parity",
    sql: "SELECT 'abc' SIMILAR TO 'a(b|d)c' AS a, 'abc' SIMILAR TO '%(b|d)%' AS b, 'abc' NOT SIMILAR TO 'x%' AS c",
  },
  {
    id: "EXP-regex-01",
    kind: "parity",
    sql: "SELECT 'hello' ~ 'ell' AS a, 'hello' ~ '^h.*o$' AS b, 'HELLO' ~* 'hello' AS c, 'abc' !~ 'z' AS d, 'ABC' !~* 'abc' AS e",
  },
  { id: "EXP-regex-02", kind: "parity", sql: "SELECT 'a1b2' ~ '[0-9]' AS a, 'foo bar' ~ '\\mbar\\M' AS b" },
  {
    id: "EXP-regex-03",
    kind: "error",
    sql: "SELECT 'a' ~ '('",
    query: true,
    messageTier: "B",
    notes: "both raise 2201B; the invalid-regex detail wording differs (missing ')' vs unbalanced parentheses)",
  },
  {
    id: "EXP-arrsub-01",
    kind: "parity",
    sql: "SELECT (ARRAY[10, 20, 30])[2] AS v, (ARRAY[10, 20, 30])[5] IS NULL AS oob",
  },
  {
    id: "EXP-arrsub-02",
    kind: "parity",
    sql: "SELECT (ARRAY[1, 2, 3, 4])[2:3] AS slice, (ARRAY[[1,2],[3,4]])[2][1] AS mat",
  },
  {
    id: "EXP-scalar-01",
    kind: "parity",
    setup: ["CREATE TABLE t (n int)"],
    sql: "SELECT (SELECT n FROM t) IS NULL AS v",
  },
  {
    id: "EXP-scalar-02",
    kind: "error",
    setup: ["CREATE TABLE t (n int)", "INSERT INTO t VALUES (1), (2)"],
    sql: "SELECT (SELECT n FROM t) AS v",
    query: true,
    messageTier: "A",
  },
  { id: "EXP-cmp-01", kind: "parity", sql: "SELECT 'apple' < 'banana' AS a, 'a' < 'ab' AS b, '' < 'a' AS c" },
  {
    id: "EXP-cmp-02",
    kind: "parity",
    sql: "SELECT 1::int2 = 1::int8 AS a, 1 = 1.0 AS b, 1.5::float4 = 1.5::float8 AS c",
  },
  { id: "EXP-unary-01", kind: "parity", sql: "SELECT +5 AS a, -'5'::int AS b" },
  {
    id: "EXP-bit-01",
    kind: "parity",
    sql: "SELECT 5 & 3 AS a, 5 | 3 AS o, 5 # 3 AS x, ~5 AS n, 1 << 4 AS shl, 16 >> 2 AS shr",
  },
  {
    id: "EXP-any-01",
    kind: "parity",
    sql: "SELECT 2 = ANY (ARRAY[1, 2, 3]) AS a, 5 = ALL (ARRAY[5, 5]) AS b, 1 <> ALL (ARRAY[2, 3]) AS c",
  },
]);
