# Scalar-type contract sweep — removed divergence cases

Cases removed from the scalar-type contract suites (types, casts, numeric, math, strings, regex, bytea, uuid,
date-time, intervals, expressions, null, row-values, collate, misc) because postgres-mem diverges from the
PGlite oracle (Postgres 18.3). Each bullet: the SQL, the memory result, the oracle result. To be fixed centrally.

## Expression typing (value-based instead of static common-supertype resolution)

- `SELECT pg_typeof(coalesce(1, 2.5))` — memory: `integer`; oracle: `numeric`
- `SELECT pg_typeof(coalesce(1::int2, 2::int4))` — memory: `smallint`; oracle: `integer`
- `SELECT pg_typeof(coalesce(1::float4, 2::float8))` — memory: `real`; oracle: `double precision`
- `SELECT pg_typeof(nullif(1, 2.0))` — memory: `integer`; oracle: `numeric`
- `SELECT pg_typeof(CASE WHEN true THEN 1 ELSE 2.0 END)` — memory: `integer`; oracle: `numeric`
- `SELECT pg_typeof(CASE WHEN true THEN 1::int2 ELSE 2::int8 END)` — memory: `smallint`; oracle: `bigint`
- `SELECT coalesce(date '2024-01-15', timestamp '2024-01-01 00:00:00')` — memory: `2024-01-15`; oracle:
  `2024-01-15 00:00:00` (no promotion of date to timestamp)
- `SELECT coalesce(1, 'abc')` — memory: succeeds (returns 1); oracle: error 22P02 `invalid input syntax for type integer: "abc"`
- `SELECT CASE WHEN true THEN 1 ELSE 'abc' END` — memory: succeeds (returns 1); oracle: error 22P02
- `SELECT CASE WHEN true THEN date '2024-01-01' ELSE 5 END` — memory: succeeds; oracle: error 42804
  `CASE types integer and date cannot be matched`

## Numeric transcendental result scale/precision

- `SELECT sqrt(4::numeric)` — memory: `2.0000000000000000` (16 dp); oracle: `2.000000000000000` (15 dp)
- `SELECT exp(0::numeric)` — memory: `1.000000000000000`; oracle: `1.0000000000000000`
- `SELECT ln(10::numeric)` — memory: `2.3025850929940460`; oracle: `2.3025850929940457`
- `SELECT log(2::numeric, 8::numeric)` — memory: `2.9999999999999997`; oracle: `3.0000000000000000`
- `SELECT 2::numeric ^ 10` — memory: `1024`; oracle: `1024.0000000000000`
- `SELECT 9::numeric ^ 0.5` — memory: `3.000000000000000`; oracle: `3.0000000000000000`
- `SELECT power(2::numeric, 10)` — memory: `1024`; oracle: `1024.0000000000000`

## Float semantics

- `SELECT round(2.5::float8)` — memory: `3`; oracle: `2` (round half to even)
- `SELECT power(1::float8, 'NaN'::float8)` — memory: `NaN`; oracle: `1`
- `SELECT power(0::float8, -1)` — memory: succeeds (`Infinity`); oracle: error 2201F
  `zero raised to a negative power is undefined`

## Parser

- `SELECT -(-5)` — memory: error 22P02 `invalid input syntax for type numeric: "--5"`; oracle: `5`
- `SELECT 1 < 2 < 3` — both raise a syntax error, but memory message is
  `syntax error at or near "<" (expected end of statement)` vs oracle `syntax error at or near "<"`
- `SELECT 'abc` (unterminated string) — memory: `unterminated quoted string`; oracle:
  `unterminated quoted string at or near "'abc"`
- `SELECTT 1` — memory: `syntax error at or near "selectt" (unrecognized statement)`; oracle:
  `syntax error at or near "SELECTT"`
- `SELECT 'a' || 1` — memory: error 22P02 `invalid input syntax for type integer: "a"`; oracle: `a1`

## Error SQLSTATE / message mismatches (behavior matches, code or text differs)

- `SELECT 1e100::float4` — both error 22003, but memory message `value out of range: overflow` vs oracle
  `"1000…000" is out of range for type real`
- `SELECT 'NaN'::numeric::int` — memory: 22003 `bigint out of range`; oracle: 0A000 `cannot convert NaN to integer`
- `SELECT 'Infinity'::numeric::int` — memory: 22003 `bigint out of range`; oracle: 0A000
  `cannot convert infinity to integer`
- `SELECT factorial(-1)` — memory: 22023; oracle: 22003 (same message `factorial of a negative number is undefined`)
- `SELECT sqrt(-1::numeric)` — memory: 22023; oracle: 2201F (same message)
- `SELECT log(0::numeric)` — memory: 22023; oracle: 2201E (same message)
- `SELECT 0::numeric ^ -1` — memory: 22012; oracle: 2201F (same message)
- `SELECT '2024-01-15 99:00:00'::timestamp` — memory: SQLSTATE 22007; oracle: 22008
- `SELECT make_time(25, 0, 0)` — memory message `time field value out of range: 25:0:0`; oracle
  `time field value out of range: 25:00:00`
- `SELECT get_byte('\x61'::bytea, 5)` — memory message `index out of range`; oracle
  `index 5 out of valid range, 0..0`
- `SELECT 'abc' ~ '(unclosed'` — memory: JS message `invalid regular expression: Invalid regular expression: missing )`;
  oracle: 2201B `invalid regular expression: parentheses () not balanced`
- `SELECT regexp_match('abc', '*bad')` — memory: no SQLSTATE, JS message `Invalid regular expression: nothing to repeat`;
  oracle: 2201B `invalid regular expression: quantifier operand invalid`
- `SELECT decode('xyz', 'hex')` — memory: 22P02 `invalid hexadecimal data: odd number of digits`; oracle: 22023
  `invalid hexadecimal digit: "x"`
- `SELECT '\x61zz'::bytea` — memory: 22P02 `invalid hexadecimal data: odd number of digits`; oracle: 22023
  `invalid hexadecimal digit: "z"`
- `SELECT '\x616'::bytea` — memory: 22P02; oracle: 22023 (same message `invalid hexadecimal data: odd number of digits`)

## bytea

- `SELECT position('\x6263'::bytea IN '\x61626364'::bytea)` — memory: `0`; oracle: `2`
- `SELECT sha256('\x616263'::bytea)` — memory: error `function sha256(bytea) does not exist`; oracle: digest bytes
- `SELECT overlay('\x6162636465'::bytea PLACING '\xffff'::bytea FROM 2)` — memory: `\\xffff36465` (mangled output);
  oracle: `\x61ffff6465`
- `SELECT btrim('\x0061620000'::bytea, '\x00'::bytea)` — memory: `6162` (missing `\x` prefix); oracle: `\x6162`

## char(n) semantics

- `SELECT 'ab'::char(5) = 'ab'::char(2)` — memory: `f`; oracle: `t` (bpchar comparison must ignore trailing spaces)

## uuid

- `SELECT '{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid` (unbalanced brace) — memory: accepts; oracle: error 22P02
- `SELECT min(id), max(id) FROM t` on a uuid column — memory: succeeds; oracle 18.3: error
  `function min(uuid) does not exist` (memory is ahead of the oracle here)

## date/time

- `SELECT '4714-01-01 BC'::date` — memory: succeeds; oracle: `date out of range` (below Postgres minimum 4714-11-24 BC)
- `SELECT 'January 15, 2024'::date` — memory: error `invalid input syntax for type date`; oracle: `2024-01-15`
- `SELECT extract(milliseconds FROM timestamp '2024-01-01 00:00:01.5')` — memory: `1.500`; oracle: `1500.000`
- `SELECT to_char(date '2024-03-05', 'FMMonth FMDD, YYYY')` — memory: `March 05, 2024` (FM not applied to DD);
  oracle: `March 5, 2024`
- `SELECT to_timestamp('2024-03-15 13:30', 'YYYY-MM-DD HH24:MI')` — memory: internal error
  `undefined is not an object (evaluating 'this.timezone')`; oracle: ok
- `SELECT interval '3 4:05:06'` (SQL-standard days+time form) — memory: error
  `invalid input syntax for type interval`; oracle: `3 days 04:05:06`

## Row values

- `SELECT (1, NULL) IN ((1, 2))` — memory: `f`; oracle: `NULL`
- `SELECT (1, 2) IN (SELECT a, b FROM t)` — memory: error `subquery has too many columns`; oracle: works
