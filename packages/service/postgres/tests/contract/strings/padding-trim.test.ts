import { parity } from "../helpers.ts";

parity("lpad basic", [], "SELECT lpad('ab', 5) AS a, lpad('ab', 5, '*') AS b");
parity("lpad truncates when too long", [], "SELECT lpad('abcdef', 3) AS v");
parity("lpad multichar fill", [], "SELECT lpad('a', 6, 'xyz') AS v");
parity("rpad basic", [], "SELECT rpad('ab', 5) || '|' AS a, rpad('ab', 5, '*') AS b");
parity("rpad truncates when too long", [], "SELECT rpad('abcdef', 3) AS v");
parity("pad zero or negative length", [], "SELECT lpad('abc', 0) AS a, rpad('abc', -1) AS b");
parity("trim both default", [], "SELECT trim('  ab  ') || '|' AS v");
parity("trim leading", [], "SELECT trim(LEADING FROM '  ab  ') || '|' AS v");
parity("trim trailing", [], "SELECT trim(TRAILING FROM '  ab  ') || '|' AS v");
parity("trim custom characters", [], "SELECT trim(BOTH 'xy' FROM 'xyabyx') AS v");
parity("ltrim rtrim btrim", [], "SELECT ltrim('  ab') AS a, rtrim('ab  ') || '|' AS b, btrim('xxabxx', 'x') AS c");
parity("ltrim with charset", [], "SELECT ltrim('zzzytest', 'xyz') AS v");
parity("trim of empty and no-op", [], "SELECT trim('') AS a, trim('abc') AS b");
