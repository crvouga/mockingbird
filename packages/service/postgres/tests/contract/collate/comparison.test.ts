import { parity } from "../helpers.ts";

parity("text equality is case sensitive", [], "SELECT 'abc' = 'abc' AS a, 'abc' = 'Abc' AS b");
parity("text less than same case", [], "SELECT 'apple' < 'banana' AS a, 'banana' < 'apple' AS b");
parity("text comparison prefix rule", [], "SELECT 'ab' < 'abc' AS a, 'abc' < 'ab' AS b");
parity("empty string is smallest", [], "SELECT '' < 'a' AS a, '' = '' AS b");
parity("mixed case comparison collate c", [], "SELECT 'A' < 'a' COLLATE \"C\" AS a, 'Z' < 'a' COLLATE \"C\" AS b");
parity("digits before letters collate c", [], "SELECT '1' < 'a' COLLATE \"C\" AS a, '9' < 'A' COLLATE \"C\" AS b");
parity("greatest least of text", [], "SELECT greatest('fig', 'pear') AS a, least('fig', 'pear') AS b");
parity("text comparison operators full set", [], "SELECT 'b' >= 'a' AS a, 'b' <= 'a' AS b, 'b' <> 'a' AS c");
parity("varchar and text compare directly", [], "SELECT 'abc'::varchar(10) = 'abc'::text AS v");
parity(
  "case sensitivity in distinct",
  ["CREATE TABLE t (v text)", "INSERT INTO t VALUES ('a'), ('A'), ('a')"],
  "SELECT count(DISTINCT v) AS n FROM t",
);
