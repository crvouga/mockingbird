import { parity } from "../helpers.ts";

parity("collate c in expression comparison", [], "SELECT 'abc' COLLATE \"C\" < 'abd' AS v");
parity("collate posix behaves like c", [], "SELECT 'B' COLLATE \"POSIX\" < 'a' AS v");
parity(
  "collate c on column comparison",
  ["CREATE TABLE t (v text)", "INSERT INTO t VALUES ('Apple'), ('apple')"],
  "SELECT v FROM t WHERE v COLLATE \"C\" < 'a' ORDER BY v",
);
parity(
  "column declared with collate c",
  ['CREATE TABLE t (v text COLLATE "C")', "INSERT INTO t VALUES ('b'), ('B'), ('a')"],
  "SELECT v FROM t ORDER BY v",
);
parity(
  "group by respects collate case sensitivity",
  ["CREATE TABLE t (v text)", "INSERT INTO t VALUES ('a'), ('A')"],
  'SELECT v, count(*) AS n FROM t GROUP BY v ORDER BY v COLLATE "C"',
);
parity(
  "collate in order by expression",
  [],
  "SELECT v FROM (VALUES ('b'), ('A'), ('a'), ('B')) AS x(v) ORDER BY v COLLATE \"C\"",
);
parity(
  "max with collate c ordering",
  ["CREATE TABLE t (v text)", "INSERT INTO t VALUES ('a'), ('Z')"],
  'SELECT max(v COLLATE "C") AS v FROM t',
);
