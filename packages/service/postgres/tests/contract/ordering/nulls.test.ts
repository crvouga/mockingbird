import { parity } from "../helpers.ts";

const t = ["CREATE TABLE t (id int, v int)", "INSERT INTO t VALUES (1, 10), (2, NULL), (3, 5), (4, NULL), (5, 20)"];

parity("nulls last default for asc", t, "SELECT id, v FROM t ORDER BY v, id");
parity("nulls first default for desc", t, "SELECT id, v FROM t ORDER BY v DESC, id");
parity("explicit nulls first asc", t, "SELECT id, v FROM t ORDER BY v ASC NULLS FIRST, id");
parity("explicit nulls last asc", t, "SELECT id, v FROM t ORDER BY v ASC NULLS LAST, id");
parity("explicit nulls first desc", t, "SELECT id, v FROM t ORDER BY v DESC NULLS FIRST, id");
parity("explicit nulls last desc", t, "SELECT id, v FROM t ORDER BY v DESC NULLS LAST, id");
parity(
  "nulls in secondary key",
  ["CREATE TABLE s (a int, b int)", "INSERT INTO s VALUES (1, NULL), (1, 2), (2, NULL), (2, 1)"],
  "SELECT a, b FROM s ORDER BY a, b NULLS FIRST",
);
parity(
  "null text ordering",
  ["CREATE TABLE s (v text)", "INSERT INTO s VALUES ('b'), (NULL), ('a')"],
  "SELECT v FROM s ORDER BY v NULLS LAST",
);
parity(
  "all null column",
  ["CREATE TABLE s (id int, v int)", "INSERT INTO s VALUES (1, NULL), (2, NULL)"],
  "SELECT id, v FROM s ORDER BY v, id",
);
parity(
  "order by expression producing nulls",
  ["CREATE TABLE s (v int)", "INSERT INTO s VALUES (1), (2), (3)"],
  "SELECT v FROM s ORDER BY nullif(v, 2) NULLS FIRST, v",
);
