# Catalog authoring report — language core (TOK, PAR, TYP, EXP, FUN)

Divergences between postgres-mem and the PGlite oracle (PostgreSQL 18.x) found while authoring the
construct-level scenario catalog for the language-core sections. Every construct below was probed
differentially; items marked **cataloged** ship as `documented_divergence` scenarios, the rest were
dropped from the catalog and are recorded here only.

## Cataloged as documented divergences

| Scenario | SQL | memory | oracle |
| --- | --- | --- | --- |
| TOK-cmt-04 | `exec("-- only a comment\n/* and a block */")` | error: `empty statement` | ok (no-op) |
| PAR-row-03 | `SELECT (1, 2) = (1, 2, 3)` | 21000 cardinality at execution: `unequal number of entries in row expressions` | 42601 syntax at parse time (same message) |
| PAR-neg-01 | `SELECT - -5` / `SELECT -(-5)` | error: `invalid input syntax for type numeric: "--5"` (unary minus folded into the literal) | returns `5` |
| TYP-float-04 | `SELECT '1e400'::float8` | ok: `Infinity` | 22003: `"1e400" is out of range for type double precision` |
| EXP-in-03 | `SELECT (1, 2) IN (SELECT n, n + 1 FROM t)` | error: `subquery has too many columns` | ok: `t` |
| FUN-round-02 | `SELECT round(2.5::float8)` | `3` (half away from zero) | `2` (half to even) |

## Dropped from the catalog (recorded only)

### Errors with mismatched SQLSTATE/category

| SQL | memory | oracle |
| --- | --- | --- |
| `SELECT '\xDEA'::bytea` (odd digit count) | 22P02 `invalid hexadecimal data: odd number of digits` | 22023 (same message) |
| `SELECT '\xzz'::bytea` (invalid digit) | 22P02 `invalid hexadecimal data: odd number of digits` | 22023 `invalid hexadecimal digit: "z"` |
| `SELECT ln(0)` / `SELECT log(0::numeric)` | 22023 `cannot take logarithm of zero` | 2201E (same message) |
| `SELECT factorial(-1)` | 22023 `factorial of a negative number is undefined` | 22003 (same message) |
| `SELECT format('%s %s', 'only-one')` | 42P02 `too few arguments for format()` | 22023 (same message) |
| `SELECT 'a' SIMILAR TO '('` | no SQLSTATE (category `other`): `Invalid regular expression: missing )` | 2201B `invalid regular expression: parentheses () not balanced` |

### Value / behavior mismatches

| SQL | memory | oracle |
| --- | --- | --- |
| `exec("SELECT 1;;")` (empty trailing statement) | empty result (last statement is the empty one) | returns the `SELECT 1` result |
| `SELECT 'June 1, 2024'::date` (verbose date format) | error: `invalid input syntax for type date` | `2024-06-01` |
| `octet_length(v)` on `char(5)` storing `'ab'` | `2` (padding not stored) | `5` |
| `SELECT to_char(485, 'RN')` | `#` (RN unsupported) | `        CDLXXXV` |
| `SELECT to_char(12, '99V99')` | ` 12` (V unsupported) | ` 1200` |
| `SELECT to_char(-7, '99MI')` | `7-` (missing leading space) | ` 7-` |
| `SELECT to_char(0.1, 'FM0.00')` | `0.1` (FM drops forced zeros) | `0.10` |
| `SELECT to_char(-12.34, '99.99S')` (trailing S) | `-12.34` | `12.34-` |
| `SELECT to_number('12,454.8-', '99G999D9S')` (trailing sign) | `12454.8` | `-12454.8` |
| `SELECT erfc(1::float8)` | `0.1572992070502851` (last digit lost) | `0.15729920705028513` |
| `SELECT encode(E'\\x01'::bytea, 'escape')` | `\001` | raw 0x01 byte (possibly a PGlite driver artifact) |
| `SELECT chr(-1)` | 22023 `requested character too large for encoding: -1` | 22023 `character number must be positive` (category matches; message differs) |

### Missing functions (undefined_function in memory)

- `parse_ident(text)`
- `unistr(text)`
- `get_bit(bytea, int)`, `get_byte(bytea, int)`, `bit_count(bytea)`

### Overload-resolution notes (not cataloged as divergences)

`exp(0)`, `ln(1)`, `power(2, 10)` with bare integer arguments resolve to the `numeric` overload in
memory (`1.0000000000000000`) but to `double precision` in the oracle (`1`). The catalog scenarios
pin the overload with explicit `::float8` / `::numeric` casts; the bare-integer resolution gap is a
real divergence in implicit-cast preference.
