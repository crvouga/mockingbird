import { parity } from "../helpers.ts";

parity("line comment ignored", [], "SELECT 1 AS v -- trailing comment");
parity("line comment inside statement", [], "SELECT 1 AS v, -- comment here\n 2 AS w");
parity("block comment ignored", [], "SELECT /* comment */ 1 AS v");
parity("nested block comment", [], "SELECT /* outer /* inner */ still comment */ 1 AS v");
parity("dollar quoted string", [], "SELECT $$hello world$$ AS v");
parity("dollar quoted with quotes inside", [], 'SELECT $$it\'s "quoted"$$ AS v');
parity("tagged dollar quote", [], "SELECT $tag$body with $$ inside$tag$ AS v");
parity("escape string newline tab", [], "SELECT E'a\\nb\\tc' AS v");
parity("escape string backslash", [], "SELECT E'a\\\\b' AS v");
parity("escape string hex and unicode", [], "SELECT E'\\x41' AS a, E'\\u0042' AS b");
parity("escape string octal", [], "SELECT E'\\101' AS v");
parity("standard string keeps backslash literal", [], "SELECT 'a\\nb' AS v");
parity("adjacent string literals across newline concatenate", [], "SELECT 'foo'\n'bar' AS v");
parity("keyword case insensitivity", [], "select 1 as V");
parity("quoted mixed case identifier", [], 'SELECT 1 AS "MyCol"');
parity("semicolon terminated statement", [], "SELECT 1 AS v;");
