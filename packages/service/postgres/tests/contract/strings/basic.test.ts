import { parity, parityTyped } from "../helpers.ts";

parity("length and char_length", [], "SELECT length('hello') AS a, char_length('hello') AS b");
parity("octet_length ascii", [], "SELECT octet_length('hello') AS a, octet_length('') AS b");
parity("upper and lower", [], "SELECT upper('MiXeD') AS a, lower('MiXeD') AS b");
parity("substr basics", [], "SELECT substr('abcdef', 2) AS a, substr('abcdef', 2, 3) AS b");
parity("substr out of range", [], "SELECT substr('abcdef', 0, 3) AS a, substr('abcdef', 10) AS b");
parity("substr negative start", [], "SELECT substr('abcdef', -2, 5) AS v");
parity("substring from for", [], "SELECT substring('abcdef' FROM 2 FOR 3) AS a, substring('abcdef' FROM 4) AS b");
parity("position and strpos", [], "SELECT position('cd' IN 'abcdef') AS a, strpos('abcdef', 'cd') AS b");
parity("position not found", [], "SELECT position('xy' IN 'abcdef') AS a, strpos('abcdef', '') AS b");
parity("left and right", [], "SELECT left('abcdef', 2) AS a, right('abcdef', 2) AS b");
parity("left and right negative counts", [], "SELECT left('abcdef', -2) AS a, right('abcdef', -2) AS b");
parity("reverse and repeat", [], "SELECT reverse('abc') AS a, repeat('ab', 3) AS b, repeat('x', 0) AS c");
parity("concat operator", [], "SELECT 'a' || 'b' AS a, 1::text || 'b' AS b");
parity("concat function ignores nulls", [], "SELECT concat('a', NULL, 'b', 1) AS v");
parity("concat_ws", [], "SELECT concat_ws(',', 'a', NULL, 'b') AS v, concat_ws('-', 1, 2, 3) AS w");
parityTyped("string function result types", [], "SELECT length('x') AS a, upper('x') AS b, left('xy', 1) AS c");
parity("case sensitivity of comparison", [], "SELECT 'abc' = 'ABC' AS a, lower('ABC') = 'abc' AS b");
