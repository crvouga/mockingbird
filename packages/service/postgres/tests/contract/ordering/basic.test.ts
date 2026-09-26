import { parity } from "../helpers.ts";

const t = [
  "CREATE TABLE t (id int, name text, score int)",
  "INSERT INTO t VALUES (1, 'delta', 30), (2, 'alpha', 10), (3, 'charlie', 30), (4, 'bravo', 20)",
];

parity("order by column asc default", t, "SELECT name FROM t ORDER BY name");
parity("order by asc explicit", t, "SELECT name FROM t ORDER BY name ASC");
parity("order by desc", t, "SELECT name FROM t ORDER BY name DESC");
parity("order by int column", t, "SELECT id, score FROM t ORDER BY score, id");
parity("order by ordinal", t, "SELECT name, score FROM t ORDER BY 2, 1");
parity("order by ordinal desc", t, "SELECT name, score FROM t ORDER BY 2 DESC, 1 ASC");
parity("order by output alias", t, "SELECT name AS n, score AS s FROM t ORDER BY s DESC, n");
parity("order by expression", t, "SELECT id, score FROM t ORDER BY score * -1, id");
parity("order by column not in select list", t, "SELECT name FROM t ORDER BY score, id");
parity("order by function of column", t, "SELECT name FROM t ORDER BY length(name), name");
parity("multi-key sort with tie break", t, "SELECT id, score FROM t ORDER BY score DESC, id DESC");
parity(
  "order by on text ascii",
  ["CREATE TABLE s (v text)", "INSERT INTO s VALUES ('B'), ('a'), ('C'), ('b')"],
  "SELECT v FROM s ORDER BY v",
);
parity(
  "order by boolean column",
  ["CREATE TABLE s (id int, f boolean)", "INSERT INTO s VALUES (1, true), (2, false), (3, true)"],
  "SELECT id, f FROM s ORDER BY f, id",
);
parity("order preserved through limit", t, "SELECT name FROM t ORDER BY name LIMIT 2");
parity(
  "order by numeric vs int values",
  ["CREATE TABLE s (v numeric)", "INSERT INTO s VALUES (1.5), (1.25), (2), (0.5)"],
  "SELECT v FROM s ORDER BY v",
);
parity(
  "order by negative numbers",
  ["CREATE TABLE s (v int)", "INSERT INTO s VALUES (3), (-1), (0), (-5), (2)"],
  "SELECT v FROM s ORDER BY v",
);
