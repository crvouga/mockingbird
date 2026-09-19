import { parity } from "../helpers.ts";

const setup = ["CREATE TABLE t (id int, v int)", "INSERT INTO t VALUES (1, 3), (2, NULL), (3, 1), (4, NULL), (5, 2)"];

parity("order by asc puts nulls last by default", setup, "SELECT id, v FROM t ORDER BY v ASC, id");
parity("order by desc puts nulls first by default", setup, "SELECT id, v FROM t ORDER BY v DESC, id");
parity("order by nulls first explicit", setup, "SELECT id, v FROM t ORDER BY v ASC NULLS FIRST, id");
parity("order by nulls last explicit", setup, "SELECT id, v FROM t ORDER BY v DESC NULLS LAST, id");
parity(
  "distinct treats nulls as equal",
  ["CREATE TABLE t (v int)", "INSERT INTO t VALUES (NULL), (NULL), (1)"],
  "SELECT DISTINCT v FROM t ORDER BY v",
);
parity(
  "group by groups nulls together",
  ["CREATE TABLE t (v int)", "INSERT INTO t VALUES (NULL), (NULL), (1), (1), (2)"],
  "SELECT v, count(*) AS n FROM t GROUP BY v ORDER BY v",
);
parity("union removes duplicate nulls", [], "SELECT NULL::int AS v UNION SELECT NULL::int ORDER BY v");
parity(
  "order by multiple keys with nulls",
  ["CREATE TABLE t (a int, b int)", "INSERT INTO t VALUES (1, NULL), (1, 2), (NULL, 1), (2, NULL)"],
  "SELECT a, b FROM t ORDER BY a NULLS FIRST, b NULLS LAST",
);
