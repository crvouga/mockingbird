import { parity } from "../helpers.ts";

parity("similar to basic", [], "SELECT 'abc' SIMILAR TO 'abc' AS a, 'abc' SIMILAR TO 'a' AS b");
parity("similar to percent", [], "SELECT 'abc' SIMILAR TO 'a%' AS a, 'abc' SIMILAR TO '%(b|d)%' AS b");
parity("similar to alternation", [], "SELECT 'abc' SIMILAR TO '(abc|def)' AS a, 'def' SIMILAR TO '(abc|def)' AS b");
parity("similar to star and plus", [], "SELECT 'abc' SIMILAR TO 'ab*c' AS a, 'ac' SIMILAR TO 'ab+c' AS b");
parity("similar to character class", [], "SELECT 'a1c' SIMILAR TO 'a[0-9]c' AS a, 'axc' SIMILAR TO 'a[0-9]c' AS b");
parity("not similar to", [], "SELECT 'abc' NOT SIMILAR TO 'a%' AS a, 'abc' NOT SIMILAR TO 'x%' AS b");
parity("similar to underscore", [], "SELECT 'abc' SIMILAR TO 'a_c' AS a, 'abbc' SIMILAR TO 'a_c' AS b");
parity("similar to full anchoring", [], "SELECT 'abcd' SIMILAR TO 'abc' AS a, 'abcd' SIMILAR TO 'abc_' AS b");
parity("substring from regex", [], "SELECT substring('foobar' FROM 'o.b') AS a, substring('foobar' FROM 'xyz') AS b");
parity("substring with capture group", [], "SELECT substring('year 2024!' FROM '([0-9]+)') AS v");
parity("substring similar escape form", [], "SELECT substring('abcdef' SIMILAR '%#\"cd#\"%' ESCAPE '#') AS v");
