import { parity, queryErrorParity } from "../helpers.ts";

parity("replace basic", [], "SELECT replace('abcabc', 'b', 'X') AS a, replace('abc', 'x', 'y') AS b");
parity("replace with empty strings", [], "SELECT replace('abc', 'b', '') AS a, replace('abc', '', 'x') AS b");
parity("translate", [], "SELECT translate('12345', '143', 'ax') AS v");
parity("split_part basic", [], "SELECT split_part('a,b,c', ',', 2) AS a, split_part('a,b,c', ',', 9) AS b");
parity("split_part negative index", [], "SELECT split_part('a,b,c', ',', -1) AS a, split_part('a,b,c', ',', -3) AS b");
parity("initcap", [], "SELECT initcap('hello world') AS a, initcap('HELLO-world foo_bar') AS b");
parity("format basic", [], "SELECT format('Hello %s, you are %s', 'world', 42) AS v");
parity("format identifier and literal", [], "SELECT format('%I and %L', 'my col', 'it''s') AS v");
parity("format positional args", [], "SELECT format('%2$s %1$s', 'a', 'b') AS v");
parity("format percent escape", [], "SELECT format('100%%') AS v");
parity("quote_literal", [], "SELECT quote_literal('abc') AS a, quote_literal('it''s') AS b");
parity("quote_ident", [], "SELECT quote_ident('abc') AS a, quote_ident('my col') AS b, quote_ident('SELECT') AS c");
parity("quote_nullable", [], "SELECT quote_nullable(NULL) AS a, quote_nullable('x') AS b");
parity("chr and ascii", [], "SELECT chr(65) AS a, ascii('A') AS b, chr(97) AS c, ascii('abc') AS d");
parity(
  "overlay",
  [],
  "SELECT overlay('abcdef' PLACING 'XX' FROM 2) AS a, overlay('abcdef' PLACING 'XX' FROM 2 FOR 4) AS b",
);
queryErrorParity("chr zero is invalid", [], "SELECT chr(0)");
queryErrorParity("split_part zero index errors", [], "SELECT split_part('a,b', ',', 0)", "invalid_parameter");
