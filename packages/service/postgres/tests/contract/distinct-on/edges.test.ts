import { parity } from "../helpers.ts";

parity(
  "distinct on ordering only by the key is deterministic key set",
  ["CREATE TABLE t (k int, v int)", "INSERT INTO t VALUES (1, 5), (2, 7)"],
  "SELECT DISTINCT ON (k) k FROM t ORDER BY k",
);
parity(
  "distinct on with alias in order by",
  ["CREATE TABLE t (k int, v int)", "INSERT INTO t VALUES (1, 9), (1, 2), (2, 4)"],
  "SELECT DISTINCT ON (k) k AS key, v FROM t ORDER BY key, v DESC",
);
parity(
  "distinct on over join",
  [
    "CREATE TABLE u (id int, name text)",
    "CREATE TABLE e (uid int, at int, kind text)",
    "INSERT INTO u VALUES (1, 'alice'), (2, 'bob')",
    "INSERT INTO e VALUES (1, 10, 'x'), (1, 20, 'y'), (2, 5, 'z')",
  ],
  "SELECT DISTINCT ON (u.id) u.name, e.kind, e.at FROM u JOIN e ON e.uid = u.id ORDER BY u.id, e.at DESC",
);
parity(
  "distinct on in subquery",
  ["CREATE TABLE t (k int, v int)", "INSERT INTO t VALUES (1, 9), (1, 2), (2, 4)"],
  "SELECT sum(v) AS s FROM (SELECT DISTINCT ON (k) v FROM t ORDER BY k, v DESC) latest",
);
parity(
  "distinct on with text key ascii ordering",
  ["CREATE TABLE t (k text, v int)", "INSERT INTO t VALUES ('b', 1), ('a', 2), ('a', 3), ('c', 4)"],
  "SELECT DISTINCT ON (k) k, v FROM t ORDER BY k, v",
);
parity(
  "distinct on entire duplicate rows",
  ["CREATE TABLE t (k int, v int)", "INSERT INTO t VALUES (1, 1), (1, 1), (2, 2)"],
  "SELECT DISTINCT ON (k) k, v FROM t ORDER BY k, v",
);
parity(
  "distinct on ordinal-free expression matches order by expression",
  ["CREATE TABLE t (a int, b int)", "INSERT INTO t VALUES (1, 4), (2, 3), (3, 2), (4, 1)"],
  "SELECT DISTINCT ON (a + b) a + b AS s, a FROM t ORDER BY a + b, a",
);
parity(
  "distinct on key prefix of longer order by",
  ["CREATE TABLE t (a int, b int, c int)", "INSERT INTO t VALUES (1, 2, 3), (1, 1, 4), (2, 5, 6)"],
  "SELECT DISTINCT ON (a) a, b, c FROM t ORDER BY a, b, c",
);
