import { expect } from "bun:test";
import { TYP_SECTION } from "../../../compat/sections/typ.ts";
import { runCatalog } from "./run.ts";

runCatalog(TYP_SECTION, [
  { id: "TYP-bool-01", kind: "parity", sql: "SELECT true AS t, false AS f, pg_typeof(true)::text AS ty" },
  {
    id: "TYP-bool-02",
    kind: "parity",
    sql: "SELECT 't'::bool AS a, 'true'::bool AS b, 'yes'::bool AS c, 'on'::bool AS d, '1'::bool AS e, ' f '::bool AS g",
  },
  { id: "TYP-bool-03", kind: "error", sql: "SELECT 'maybe'::bool", query: true, messageTier: "A" },
  {
    id: "TYP-int-01",
    kind: "parity",
    sql: "SELECT pg_typeof(1)::text AS a, pg_typeof(2147483648)::text AS b, pg_typeof(1::int2)::text AS c",
  },
  { id: "TYP-int-02", kind: "error", sql: "SELECT 32768::int2", query: true, messageTier: "A" },
  { id: "TYP-int-03", kind: "error", sql: "SELECT 2147483648::int4", query: true, messageTier: "A" },
  { id: "TYP-int-04", kind: "error", sql: "SELECT 9223372036854775807 + 1", query: true, messageTier: "A" },
  {
    id: "TYP-int-05",
    kind: "parity",
    sql: "SELECT (-32768)::int2 AS a, 32767::int2 AS b, (-2147483648)::int4 AS c, 9223372036854775807 AS d",
  },
  { id: "TYP-int-06", kind: "error", sql: "SELECT (-9223372036854775808) / (-1)", query: true, messageTier: "A" },
  { id: "TYP-float-01", kind: "parity", sql: "SELECT 1.5::float8 AS a, 1.5::float4 AS b, pg_typeof(1e5)::text AS c" },
  {
    id: "TYP-float-02",
    kind: "parity",
    sql: "SELECT 'NaN'::float8 AS a, 'Infinity'::float8 AS b, '-Infinity'::float8 AS c, 'inf'::float8 AS d",
  },
  {
    id: "TYP-float-03",
    kind: "parity",
    sql: "SELECT 'NaN'::float8 = 'NaN'::float8 AS eq, 'NaN'::float8 > 'Infinity'::float8 AS gt",
  },
  {
    id: "TYP-float-04",
    kind: "divergence",
    fn: (db) => {
      expect(db.query("SELECT '1e400'::float8::text AS v")).toEqual([{ v: "Infinity" }]);
    },
  },
  { id: "TYP-float-05", kind: "parity", sql: "SELECT 0.1::float8 + 0.2::float8 AS v" },
  { id: "TYP-num-01", kind: "parity", sql: "SELECT pg_typeof(1.5)::text AS t, 1.5000 AS v, 1.50::numeric(10,2) AS w" },
  {
    id: "TYP-num-02",
    kind: "parity",
    sql: "SELECT 123.456::numeric(5,2) AS a, 123.454::numeric(5,2) AS b, 2.5::numeric(2,0) AS c, 3.5::numeric(2,0) AS d",
  },
  { id: "TYP-num-03", kind: "error", sql: "SELECT 1000::numeric(3,1)", query: true, messageTier: "A" },
  { id: "TYP-num-04", kind: "parity", sql: "SELECT 'NaN'::numeric AS n, 'NaN'::numeric = 'NaN'::numeric AS eq" },
  { id: "TYP-num-05", kind: "parity", sql: "SELECT 1::numeric / 3 AS v, pg_typeof(1::numeric / 3)::text AS t" },
  {
    id: "TYP-text-01",
    kind: "error",
    setup: ["CREATE TABLE t (v varchar(3))"],
    sql: "INSERT INTO t VALUES ('abcd')",
    messageTier: "A",
  },
  { id: "TYP-text-02", kind: "parity", sql: "SELECT 'abcdef'::varchar(3) AS v, 'abcd '::varchar(4) AS w" },
  {
    id: "TYP-text-03",
    kind: "parity",
    setup: ["CREATE TABLE t (v char(5))", "INSERT INTO t VALUES ('ab')"],
    sql: "SELECT v, length(v) AS l, v || '|' AS shown FROM t",
  },
  {
    id: "TYP-text-04",
    kind: "parity",
    sql: "SELECT 'ab'::char(5) = 'ab   '::char(5) AS eq, 'ab'::char(5) || 'X' AS cat",
  },
  { id: "TYP-text-05", kind: "parity", sql: "SELECT 'abcd'::char(2) AS a, 'ab'::char(4) || '|' AS b" },
  { id: "TYP-bytea-01", kind: "parity", sql: "SELECT '\\x01ff'::bytea AS v, octet_length('\\x01ff'::bytea) AS n" },
  { id: "TYP-bytea-02", kind: "parity", sql: "SELECT 'abc'::bytea AS v, '\\x616263'::bytea::text AS t" },
  { id: "TYP-uuid-01", kind: "parity", sql: "SELECT 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11'::uuid AS v" },
  { id: "TYP-uuid-02", kind: "error", sql: "SELECT 'not-a-uuid'::uuid", query: true, messageTier: "A" },
  { id: "TYP-uuid-03", kind: "parity", sql: "SELECT '{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}'::uuid AS v" },
  { id: "TYP-dt-01", kind: "parity", sql: "SELECT '2024-06-01'::date AS d, pg_typeof('2024-06-01'::date)::text AS t" },
  {
    id: "TYP-dt-02",
    kind: "parity",
    sql: "SELECT '2024-06-01 12:30:45'::timestamp AS ts, '2024-06-01T12:30:45'::timestamp AS iso",
  },
  { id: "TYP-dt-03", kind: "parity", sql: "SELECT '2024-06-01 12:00:00+00'::timestamptz AT TIME ZONE 'UTC' AS v" },
  {
    id: "TYP-dt-04",
    kind: "parity",
    sql: "SELECT '1 year 2 mons 3 days'::interval AS a, 'P1Y2M3D'::interval AS b, '01:02:03'::interval AS c",
  },
  { id: "TYP-dt-05", kind: "error", sql: "SELECT '2024-13-01'::date", query: true, messageTier: "A" },
  { id: "TYP-unknown-01", kind: "parity", sql: "SELECT pg_typeof('abc')::text AS t, pg_typeof('1')::text AS u" },
  {
    id: "TYP-unknown-02",
    kind: "parity",
    setup: ["CREATE TABLE t (n int)", "INSERT INTO t VALUES (5)"],
    sql: "SELECT n + '5' AS v FROM t",
  },
  {
    id: "TYP-pgt-01",
    kind: "parity",
    sql: "SELECT pg_typeof(1 + 1)::text AS a, pg_typeof(1 + 1.5)::text AS b, pg_typeof(1::int2 + 1::int2)::text AS c, pg_typeof(1 / 2)::text AS d",
  },
  {
    id: "TYP-pgt-02",
    kind: "parity",
    sql: "SELECT pg_typeof('a' || 'b')::text AS a, pg_typeof(now() - now())::text AS b, pg_typeof(1.5::float4 + 1.5::float8)::text AS c",
  },
  { id: "TYP-cast-01", kind: "error", sql: "SELECT 'abc'::int", query: true, messageTier: "A" },
  { id: "TYP-cast-02", kind: "parity", sql: "SELECT ' 42 '::int AS v, '+7'::int AS p" },
  { id: "TYP-cast-03", kind: "parity", sql: "SELECT 1.9::int AS a, (-1.9)::int AS b, 2.5::int AS c, 3.5::int AS d" },
  {
    id: "TYP-cast-04",
    kind: "parity",
    sql: "SELECT 1.9::float8::int AS a, 2.5::float8::int AS b, (-2.5)::float8::int AS c",
  },
]);
