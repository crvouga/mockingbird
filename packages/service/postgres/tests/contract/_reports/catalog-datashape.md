# Catalog authoring report — DAT / JSN / ARR / AGG / WIN

Divergences between postgres-mem and the PGlite oracle (Postgres 18.3) found while authoring the
construct-level scenario catalog sections DAT, JSN, ARR, AGG, WIN. Every entry below was verified by
running the SQL against both engines. Unless noted, the scenario was **dropped** from the catalog
(the engine was not modified).

## Kept as documented divergences

### 1. Deterministic fixed clock (`now()` family) — kept as `DAT-now-01`

By design, postgres-mem defaults to a fixed clock. Covered by scenario `DAT-now-01`
(kind `documented_divergence`, notes "deterministic fixed now") and the DET section.

| SQL | memory | oracle |
| --- | --- | --- |
| `SELECT now()::text` | `2000-01-01 00:00:00+00` | wall clock (e.g. `2026-08-21 17:47:34.834+00`) |
| `SELECT current_date::text` | `2000-01-01` | wall clock date |
| `SELECT current_timestamp::text` | `2000-01-01 00:00:00+00` | wall clock |
| `SELECT localtimestamp::text` | `2000-01-01 00:00:00` | wall clock |
| `SELECT transaction_timestamp()::text, statement_timestamp()::text` | both `2000-01-01 00:00:00+00` | wall clock |
| `SELECT age(timestamp '2000-01-01')` (single-arg age uses `now()`) | `00:00:00` | e.g. `26 years 7 mons 20 days` |

## Dropped scenarios (memory diverges from the oracle)

### 2. BC dates are rejected

- SQL: `SELECT '0001-01-01 BC'::date::text`
- memory: error `22007 invalid input syntax for type date: "0001-01-01 BC"`
- oracle: `0001-01-01 BC`

### 3. `to_char` FM (fill mode) does not suppress leading zeros on DD

- SQL: `SELECT to_char(date '2024-03-05', 'FMMonth FMDD, YYYY')`
- memory: `March 05, 2024`
- oracle: `March 5, 2024`

### 4. `date_bin` rejects sub-month strides with a wrong month/year check

- SQL: `SELECT date_bin('15 minutes', timestamp '2024-02-11 15:44:17', timestamp '2001-01-01')`
- memory: error `0A000 timestamps cannot be binned into intervals containing months or years`
- oracle: `2024-02-11 15:30:00`

### 5. SQL-standard interval field qualifiers are not parsed

- SQL: `SELECT interval '3:20' hour to minute`
- memory: error `42601 syntax error at or near "to" (expected end of statement)`
- oracle: `03:20:00`

### 6. Infinite intervals are not supported

- SQL: `SELECT 'infinity'::interval::text, isfinite('infinity'::interval)`
- memory: error `22007 invalid input syntax for type interval: "infinity"`
- oracle: `infinity`, `f`

### 7. SQL/JSON path language is not implemented

- SQL: `SELECT jsonb_path_query('{"a":[1,2,3]}'::jsonb, '$.a[*]')`
  - memory: error `42883 function jsonb_path_query(jsonb, unknown) does not exist`
  - oracle: rows `1`, `2`, `3`
- Same for `jsonb_path_exists(...)` (oracle `t`) and `jsonb_path_query_array(...)` (oracle `[2, 3]`).
- Operators misparse the right operand as json instead of jsonpath:
  - SQL: `SELECT '{"a":[1,2]}'::jsonb @? '$.a[*] ? (@ == 2)'` and `SELECT '{"a":1}'::jsonb @@ '$.a == 1'`
  - memory: error `22P02 invalid input syntax for type json`
  - oracle: `t`

### 8. `string_to_array` with a NULL delimiter

- SQL: `SELECT string_to_array('abc', NULL)`
- memory: `NULL`
- oracle: `{a,b,c}` (NULL delimiter splits into individual characters)

### 9. `percentile_cont` does not accept an array of fractions

- SQL: `SELECT percentile_cont(ARRAY[0.25, 0.5, 0.75]) WITHIN GROUP (ORDER BY v)` over values 1..4
- memory: error `42846 cannot cast type numeric[] to double precision`
- oracle: `{1.75,2.5,3.25}`

### 10. `json_object_agg` deduplicates keys (json should keep duplicates)

- SQL: `SELECT json_object_agg(s, v ORDER BY s)` over rows `('a',10), ('a',30), ('b',20), ('c',NULL)`
- memory: `{ "a" : 30, "b" : 20, "c" : null }`
- oracle: `{ "a" : 10, "a" : 30, "b" : 20, "c" : null }`
- `AGG-jsn-02` was kept with unique keys only.

### 11. DISTINCT inside a window aggregate is accepted (should error)

- SQL: `SELECT a, count(DISTINCT a) OVER () FROM t GROUP BY a`
- memory: succeeds and computes a value
- oracle: error `DISTINCT is not implemented for window functions`

## Kept with an epsilon (float summation noise, not a semantic divergence)

### 12. `corr` / `regr_*` last-ulp float differences — kept as `AGG-corr-01` / `AGG-corr-02` with `realEpsilon: 1e-12`

- SQL: `SELECT corr(y, x), covar_pop(y, x), covar_samp(y, x)` over `(1,2), (2,4), (3,5)`
  - memory: `0.981980506061966, 1, 1.5`
  - oracle: `0.9819805060619659, 1, 1.5`
- SQL: `SELECT regr_slope(y, x), regr_intercept(y, x), regr_r2(y, x), regr_count(y, x)` over the same rows
  - memory: `1.5, 0.6666666666666665, 0.9642857142857147, 3`
  - oracle: `1.5, 0.6666666666666666, 0.9642857142857144, 3`
