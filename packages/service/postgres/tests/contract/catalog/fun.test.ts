import { expect } from "bun:test";
import { FUN_SECTION } from "../../../compat/sections/fun.ts";
import { runCatalog } from "./run.ts";

runCatalog(FUN_SECTION, [
  {
    id: "FUN-length-01",
    kind: "parity",
    sql: "SELECT length('hello') AS a, char_length('héllo') AS b, octet_length('héllo') AS c, bit_length('a') AS d",
  },
  {
    id: "FUN-case-01",
    kind: "parity",
    sql: "SELECT upper('MixedCase') AS u, lower('MixedCase') AS l, initcap('hello wORLD of sql') AS i",
  },
  {
    id: "FUN-substr-01",
    kind: "parity",
    sql: "SELECT substr('hello', 2, 2) AS a, substring('hello', 3) AS b, substr('hello', -1, 3) AS c, substr('hello', 0, 3) AS d, substr('hello', 2, 0) AS e, substring('hello' from 2 for 3) AS f",
  },
  { id: "FUN-substr-02", kind: "error", sql: "SELECT substr('hello', 2, -1)", query: true, messageTier: "A" },
  {
    id: "FUN-trim-01",
    kind: "parity",
    sql: "SELECT trim('  pad  ') AS t, ltrim('xxabcxx', 'x') AS l, rtrim('xxabcxx', 'x') AS r, btrim('xxabcxx', 'x') AS b, trim(leading 'x' from 'xxaxx') AS lead, trim(trailing 'x' from 'xxaxx') AS tr",
  },
  {
    id: "FUN-pad-01",
    kind: "parity",
    sql: "SELECT lpad('7', 3, '0') AS a, rpad('ab', 5, 'xy') AS b, lpad('toolong', 3) AS c, rpad('hi', 5) || '|' AS d",
  },
  {
    id: "FUN-replace-01",
    kind: "parity",
    sql: "SELECT replace('banana', 'na', 'NA') AS a, replace('aaa', '', 'x') AS b, translate('12345', '143', 'ax') AS t, translate('abcde', 'ace', '12') AS drops",
  },
  {
    id: "FUN-split-01",
    kind: "parity",
    sql: "SELECT split_part('a,b,c', ',', 2) AS a, split_part('a,b,c', ',', 9) AS empty, split_part('a,b,c', ',', -1) AS neg",
  },
  {
    id: "FUN-strpos-01",
    kind: "parity",
    sql: "SELECT strpos('high', 'ig') AS a, strpos('high', 'zz') AS b, position('ig' IN 'high') AS c",
  },
  {
    id: "FUN-leftright-01",
    kind: "parity",
    sql: "SELECT left('hello', 2) AS a, right('hello', 2) AS b, left('hello', -2) AS c, right('hello', -2) AS d",
  },
  {
    id: "FUN-repeat-01",
    kind: "parity",
    sql: "SELECT repeat('ab', 3) AS a, repeat('x', 0) AS b, reverse('hello') AS r",
  },
  {
    id: "FUN-format-01",
    kind: "parity",
    sql: "SELECT format('%s-%s', 'a', 42) AS a, format('%I', 'my col') AS i, format('%L', E'o''brien') AS l, format('%2$s %1$s', 'world', 'hello') AS pos, format('%s', NULL) AS n, format('%L', NULL) AS ln",
  },
  {
    id: "FUN-concat-01",
    kind: "parity",
    sql: "SELECT concat('a', NULL, 'b', 1) AS c, concat_ws(',', 'a', NULL, 'b') AS ws",
  },
  {
    id: "FUN-regexp-01",
    kind: "parity",
    sql: "SELECT regexp_replace('hello world', 'o', '0') AS one, regexp_replace('hello world', 'o', '0', 'g') AS all_, regexp_replace('Hello', 'h', 'J', 'i') AS ci, regexp_replace('one two', '(\\w+) (\\w+)', '\\2 \\1') AS swap",
  },
  { id: "FUN-regexp-02", kind: "parity", sql: "SELECT regexp_matches('foobarbaz', 'b(..)') AS m" },
  {
    id: "FUN-regexp-03",
    kind: "parity",
    sql: "SELECT regexp_split_to_array('a,b,,c', ',') AS v, regexp_split_to_array('the quick brown', '\\s+') AS w",
  },
  {
    id: "FUN-regexp-04",
    kind: "parity",
    sql: "SELECT regexp_count('abcabc', 'a') AS c, regexp_like('hello', 'ell') AS l, regexp_substr('abc123', '\\d+') AS s",
  },
  {
    id: "FUN-abs-01",
    kind: "parity",
    sql: "SELECT abs(-5) AS a, abs(5.5) AS b, abs(-5.5::float8) AS c, abs(-0.0::float8) AS d",
  },
  {
    id: "FUN-ceil-01",
    kind: "parity",
    sql: "SELECT ceil(1.1) AS a, ceiling(-1.1) AS b, floor(1.9) AS c, floor(-1.9) AS d",
  },
  {
    id: "FUN-round-01",
    kind: "parity",
    sql: "SELECT round(2.5) AS a, round(3.5) AS b, round(-2.5) AS c, round(123.456, 2) AS d, round(123.456, -1) AS e",
  },
  {
    id: "FUN-round-02",
    kind: "divergence",
    fn: (db) => {
      expect(db.query("SELECT round(2.5::float8) AS a, round(3.5::float8) AS b")).toEqual([{ a: 3, b: 4 }]);
    },
  },
  {
    id: "FUN-trunc-01",
    kind: "parity",
    sql: "SELECT trunc(1.9) AS a, trunc(-1.9) AS b, trunc(123.456, 2) AS c, trunc(123.456, -2) AS d",
  },
  {
    id: "FUN-sign-01",
    kind: "parity",
    sql: "SELECT sign(-8.4) AS a, sign(0) AS b, sign(7) AS c, sign(-2.5::float8) AS d",
  },
  {
    id: "FUN-moddiv-01",
    kind: "parity",
    sql: "SELECT mod(9, 4) AS a, mod(-9, 4) AS b, mod(9, -4) AS c, mod(9.5, 4) AS n, div(9, 4) AS d, div(-9, 4) AS e, div(9.5, 4) AS f",
  },
  { id: "FUN-exp-01", kind: "parity", sql: "SELECT exp(0::float8) AS f, exp(1::float8) AS e, exp(1::numeric) AS n" },
  {
    id: "FUN-ln-01",
    kind: "parity",
    sql: "SELECT ln(1::float8) AS one, ln(2.718281828459045::float8) AS e, ln(10::numeric) AS n",
  },
  { id: "FUN-ln-02", kind: "error", sql: "SELECT ln(-1.0::float8)", query: true, messageTier: "A" },
  {
    id: "FUN-log-01",
    kind: "parity",
    sql: "SELECT log(100::numeric) AS l10, log(2, 8) AS l2, log10(1000::float8) AS f",
  },
  {
    id: "FUN-sqrt-01",
    kind: "parity",
    sql: "SELECT sqrt(16::float8) AS f, sqrt(2::numeric) AS n, cbrt(27::float8) AS c, cbrt(-8) AS neg",
    // Native libm cbrt(27) prints 3.0000000000000004; JS Math.cbrt is exact 3.
    options: { realEpsilon: 1e-12 },
  },
  { id: "FUN-sqrt-02", kind: "error", sql: "SELECT sqrt(-1::float8)", query: true, messageTier: "A" },
  {
    id: "FUN-power-01",
    kind: "parity",
    sql: "SELECT power(2::float8, 10) AS a, power(2::float8, 0.5) AS b, power(2::numeric, 3) AS n, power(0::float8, 0) AS z",
  },
  {
    id: "FUN-trig-01",
    kind: "parity",
    sql: "SELECT sin(0) AS s, cos(0) AS c, tan(0) AS t, atan(1) AS a, atan2(1, 1) AS a2, acos(1) AS ac, asin(1) AS asn, sin(pi() / 6) AS s30",
  },
  { id: "FUN-trig-02", kind: "error", sql: "SELECT asin(2)", query: true, messageTier: "A" },
  { id: "FUN-trig-03", kind: "parity", sql: "SELECT sind(30) AS s, cosd(60) AS c, tand(45) AS t" },
  { id: "FUN-pi-01", kind: "parity", sql: "SELECT pi() AS pi, degrees(pi()) AS deg, radians(180) AS rad" },
  {
    id: "FUN-wb-01",
    kind: "parity",
    sql: "SELECT width_bucket(5.35, 0.024, 10.06, 5) AS a, width_bucket(-1, 0, 10, 5) AS lo, width_bucket(11, 0, 10, 5) AS hi",
  },
  {
    id: "FUN-tochar-01",
    kind: "parity",
    sql: "SELECT to_char(1234.5, '9999.99') AS a, to_char(1234567, '9,999,999') AS b",
  },
  {
    id: "FUN-tochar-02",
    kind: "parity",
    sql: "SELECT to_char(-12.34, 'S99.99') AS s, to_char(1234.5, 'FM9999.99') AS fm",
  },
  { id: "FUN-md5-01", kind: "parity", sql: "SELECT md5('abc') AS h, md5('') AS empty" },
  {
    id: "FUN-encode-01",
    kind: "parity",
    sql: "SELECT encode('abc'::bytea, 'hex') AS h, encode('abc'::bytea, 'base64') AS b64, encode('a b'::bytea, 'escape') AS esc",
  },
  { id: "FUN-decode-01", kind: "parity", sql: "SELECT decode('616263', 'hex') AS h, decode('YWJj', 'base64') AS b64" },
  {
    id: "FUN-decode-02",
    kind: "error",
    sql: "SELECT decode('xyz', 'hex')",
    query: true,
    messageTier: "B",
    notes: "both raise 22023; memory reports odd digit count, PostgreSQL names the invalid digit",
  },
  {
    id: "FUN-gcd-01",
    kind: "parity",
    sql: "SELECT gcd(12, 18) AS g, gcd(0, 5) AS gz, lcm(4, 6) AS l, lcm(0, 7) AS lz",
  },
  { id: "FUN-fact-01", kind: "parity", sql: "SELECT factorial(5) AS f, factorial(0) AS z" },
  { id: "FUN-nulls-01", kind: "parity", sql: "SELECT num_nonnulls(1, NULL, 'a') AS nn, num_nulls(1, NULL, NULL) AS n" },
]);
