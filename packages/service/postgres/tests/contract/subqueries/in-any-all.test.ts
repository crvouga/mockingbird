import { parity } from "../helpers.ts";

const data = [
  "CREATE TABLE t (id int, v int)",
  "CREATE TABLE s (v int)",
  "INSERT INTO t VALUES (1, 10), (2, 20), (3, 30), (4, NULL)",
  "INSERT INTO s VALUES (10), (30)",
];

// IN / NOT IN
parity("in subquery", data, "SELECT id FROM t WHERE v IN (SELECT v FROM s) ORDER BY id");
parity("not in subquery", data, "SELECT id FROM t WHERE v NOT IN (SELECT v FROM s) ORDER BY id");
parity(
  "not in with null in subquery result yields empty",
  [
    "CREATE TABLE t (v int)",
    "CREATE TABLE s (v int)",
    "INSERT INTO t VALUES (1), (2)",
    "INSERT INTO s VALUES (1), (NULL)",
  ],
  "SELECT v FROM t WHERE v NOT IN (SELECT v FROM s) ORDER BY v",
);
parity(
  "in with null probe value",
  ["CREATE TABLE t (v int)", "CREATE TABLE s (v int)", "INSERT INTO t VALUES (NULL), (1)", "INSERT INTO s VALUES (1)"],
  "SELECT v FROM t WHERE v IN (SELECT v FROM s) ORDER BY v",
);
parity(
  "in subquery empty result",
  ["CREATE TABLE t (v int)", "CREATE TABLE s (v int)", "INSERT INTO t VALUES (1)"],
  "SELECT v FROM t WHERE v IN (SELECT v FROM s)",
);
parity(
  "not in subquery empty result matches all",
  ["CREATE TABLE t (v int)", "CREATE TABLE s (v int)", "INSERT INTO t VALUES (1), (2)"],
  "SELECT v FROM t WHERE v NOT IN (SELECT v FROM s) ORDER BY v",
);
parity(
  "correlated in subquery",
  [
    "CREATE TABLE t (id int, grp text)",
    "CREATE TABLE s (grp text, id int)",
    "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'a')",
    "INSERT INTO s VALUES ('a', 1), ('a', 3)",
  ],
  "SELECT id FROM t WHERE id IN (SELECT id FROM s WHERE s.grp = t.grp) ORDER BY id",
);
// ANY / SOME / ALL
parity("any equality", data, "SELECT id FROM t WHERE v = ANY (SELECT v FROM s) ORDER BY id");
parity("some is alias for any", data, "SELECT id FROM t WHERE v = SOME (SELECT v FROM s) ORDER BY id");
parity("any greater-than", data, "SELECT id FROM t WHERE v > ANY (SELECT v FROM s) ORDER BY id");
parity("all greater-than", data, "SELECT id FROM t WHERE v > ALL (SELECT v FROM s) ORDER BY id");
parity("all not-equal", data, "SELECT id FROM t WHERE v <> ALL (SELECT v FROM s) ORDER BY id");
parity(
  "all over empty subquery is true",
  ["CREATE TABLE t (v int)", "CREATE TABLE s (v int)", "INSERT INTO t VALUES (1)"],
  "SELECT v FROM t WHERE v > ALL (SELECT v FROM s)",
);
parity(
  "any over empty subquery is false",
  ["CREATE TABLE t (v int)", "CREATE TABLE s (v int)", "INSERT INTO t VALUES (1)"],
  "SELECT v FROM t WHERE v = ANY (SELECT v FROM s)",
);
parity(
  "all with null in subquery",
  ["CREATE TABLE t (v int)", "CREATE TABLE s (v int)", "INSERT INTO t VALUES (5)", "INSERT INTO s VALUES (1), (NULL)"],
  "SELECT v FROM t WHERE v > ALL (SELECT v FROM s)",
);
parity("any against array expression", [], "SELECT 2 = ANY (ARRAY[1, 2, 3]) AS v");
parity("all against array expression", [], "SELECT 2 < ALL (ARRAY[3, 4]) AS a, 2 < ALL (ARRAY[1, 4]) AS b");
