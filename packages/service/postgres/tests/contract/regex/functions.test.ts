import { parity } from "../helpers.ts";

parity("regexp_replace first match", [], "SELECT regexp_replace('abcabc', 'b', 'X') AS v");
parity("regexp_replace global flag", [], "SELECT regexp_replace('abcabc', 'b', 'X', 'g') AS v");
parity("regexp_replace case insensitive flag", [], "SELECT regexp_replace('ABCabc', 'b', 'X', 'gi') AS v");
parity("regexp_replace backreference", [], "SELECT regexp_replace('abc', '(b)', '[\\1]') AS v");
parity("regexp_match returns array", [], "SELECT regexp_match('foobarbaz', 'b(..)') AS v");
parity("regexp_match no match is null", [], "SELECT regexp_match('foo', 'xyz') AS v");
parity("regexp_match multiple groups", [], "SELECT regexp_match('a1b2', '([a-z])(\\d)') AS v");
parity("regexp_split_to_array", [], "SELECT regexp_split_to_array('a,b,,c', ',') AS v");
parity("regexp_split_to_array regex delimiter", [], "SELECT regexp_split_to_array('a1b22c', '[0-9]+') AS v");
parity("regexp_split_to_table ordered", [], "SELECT s FROM regexp_split_to_table('c,a,b', ',') AS s ORDER BY s");
parity("regexp_count", [], "SELECT regexp_count('abcabc', 'b') AS a, regexp_count('abc', 'x') AS b");
parity("regexp_count with flags", [], "SELECT regexp_count('ABCabc', 'b', 1, 'i') AS v");
parity("regexp_like", [], "SELECT regexp_like('abc', 'b') AS a, regexp_like('ABC', 'b', 'i') AS b");
parity("regexp_substr", [], "SELECT regexp_substr('foo123bar', '[0-9]+') AS a, regexp_substr('foo', '[0-9]+') AS b");
parity("regexp_instr", [], "SELECT regexp_instr('foo123bar', '[0-9]+') AS a, regexp_instr('foo', '[0-9]+') AS b");
parity("regexp_matches global ordered", [], "SELECT m FROM regexp_matches('a1b2', '\\d', 'g') AS m ORDER BY m");
