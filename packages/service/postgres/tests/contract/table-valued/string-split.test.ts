import { parity } from "../helpers.ts";

// string_to_table
parity("string_to_table basic", [], "SELECT * FROM string_to_table('a,b,c', ',') AS s(part) ORDER BY part");
parity(
  "string_to_table preserves order via ordinality",
  [],
  "SELECT part, ord FROM string_to_table('z,y,x', ',') WITH ORDINALITY AS s(part, ord) ORDER BY ord",
);
parity(
  "string_to_table empty fields",
  [],
  "SELECT part, ord FROM string_to_table('a,,c', ',') WITH ORDINALITY AS s(part, ord) ORDER BY ord",
);
parity(
  "string_to_table null delimiter splits chars",
  [],
  "SELECT part, ord FROM string_to_table('abc', NULL) WITH ORDINALITY AS s(part, ord) ORDER BY ord",
);
parity(
  "string_to_table with null string arg",
  [],
  "SELECT part, ord FROM string_to_table('a,NULLTOKEN,b', ',', 'NULLTOKEN') WITH ORDINALITY AS s(part, ord) ORDER BY ord",
);
parity("string_to_table single token", [], "SELECT * FROM string_to_table('solo', ',') AS s(part)");

// regexp_split_to_table
parity(
  "regexp_split_to_table basic",
  [],
  "SELECT part, ord FROM regexp_split_to_table('one two  three', '\\s+') WITH ORDINALITY AS s(part, ord) ORDER BY ord",
);
parity(
  "regexp_split_to_table on digits",
  [],
  "SELECT part, ord FROM regexp_split_to_table('a1b22c333d', '[0-9]+') WITH ORDINALITY AS s(part, ord) ORDER BY ord",
);
parity(
  "regexp_split_to_table no match returns whole",
  [],
  "SELECT * FROM regexp_split_to_table('hello', ',') AS s(part)",
);
parity("regexp_split_to_table count", [], "SELECT count(*) AS n FROM regexp_split_to_table('a,b,c,d', ',') AS s(part)");
parity(
  "regexp_split_to_table from column",
  ["CREATE TABLE t (id int, words text)", "INSERT INTO t VALUES (1, 'a b'), (2, 'c d e')"],
  "SELECT t.id, s.part FROM t, regexp_split_to_table(t.words, ' ') AS s(part) ORDER BY t.id, s.part",
);
