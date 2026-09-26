import { parity } from "../helpers.ts";

parity("regex match basic", [], "SELECT 'abc' ~ 'b' AS a, 'abc' ~ 'x' AS b");
parity("regex case insensitive operator", [], "SELECT 'ABC' ~* 'b' AS a, 'ABC' ~ 'b' AS b");
parity("regex negated operators", [], "SELECT 'abc' !~ 'x' AS a, 'ABC' !~* 'b' AS b");
parity("regex anchors", [], "SELECT 'abc' ~ '^a' AS a, 'abc' ~ 'c$' AS b, 'abc' ~ '^abc$' AS c");
parity("regex character classes", [], "SELECT 'a1b' ~ '[0-9]' AS a, 'abc' ~ '[[:digit:]]' AS b");
parity("regex quantifiers", [], "SELECT 'aaa' ~ 'a{3}' AS a, 'aa' ~ 'a{3,}' AS b, 'ab' ~ 'ab?c?' AS c");
parity("regex alternation and groups", [], "SELECT 'cat' ~ '^(cat|dog)$' AS a, 'cow' ~ '^(cat|dog)$' AS b");
parity("regex dot and star", [], "SELECT 'abc' ~ 'a.c' AS a, 'ac' ~ 'ab*c' AS b, 'abbbc' ~ 'ab+c' AS c");
parity("regex escaped metacharacters", [], "SELECT 'a.c' ~ 'a\\.c' AS a, 'abc' ~ 'a\\.c' AS b");
parity("regex word boundary escapes", [], "SELECT 'foo bar' ~ '\\mbar' AS a, 'foobar' ~ '\\mbar' AS b");
parity("regex digit shorthand", [], "SELECT 'a1' ~ '\\d' AS a, 'ab' ~ '\\d' AS b, 'a b' ~ '\\s' AS c");
parity(
  "regex filter in where clause",
  ["CREATE TABLE t (v text)", "INSERT INTO t VALUES ('a1'), ('b2'), ('cc'), ('d4')"],
  "SELECT v FROM t WHERE v ~ '[0-9]$' ORDER BY v",
);
