import { parity, queryErrorParity } from "../helpers.ts";

const data = ["CREATE TABLE t (id int, v int)", "INSERT INTO t VALUES (1, 10), (2, 20), (3, 30)"];

parity("scalar subquery in select list", data, "SELECT id, (SELECT max(v) FROM t) AS mx FROM t ORDER BY id");
parity("scalar subquery as expression operand", data, "SELECT id FROM t WHERE v > (SELECT avg(v) FROM t) ORDER BY id");
parity("scalar subquery returning no rows is null", data, "SELECT (SELECT v FROM t WHERE id = 99) AS missing");
parity(
  "correlated scalar subquery",
  [
    "CREATE TABLE a (id int, grp text)",
    "CREATE TABLE b (grp text, score int)",
    "INSERT INTO a VALUES (1, 'x'), (2, 'y'), (3, 'z')",
    "INSERT INTO b VALUES ('x', 5), ('x', 7), ('y', 3)",
  ],
  "SELECT a.id, (SELECT max(score) FROM b WHERE b.grp = a.grp) AS best FROM a ORDER BY a.id",
);
parity(
  "scalar subquery in where correlated",
  [
    "CREATE TABLE t (id int, grp text, v int)",
    "INSERT INTO t VALUES (1, 'a', 5), (2, 'a', 9), (3, 'b', 4), (4, 'b', 2)",
  ],
  "SELECT id FROM t o WHERE v = (SELECT max(v) FROM t i WHERE i.grp = o.grp) ORDER BY id",
);
parity("scalar subquery arithmetic", data, "SELECT (SELECT min(v) FROM t) + (SELECT max(v) FROM t) AS total");
parity("scalar subquery in order by", data, "SELECT id FROM t ORDER BY (SELECT 1), id DESC");
parity("scalar subquery nested twice", data, "SELECT (SELECT (SELECT max(v) FROM t)) AS v");

// cardinality errors
queryErrorParity("scalar subquery more than one row", data, "SELECT (SELECT v FROM t) AS v", "cardinality");
queryErrorParity(
  "scalar subquery in where more than one row",
  data,
  "SELECT id FROM t WHERE v = (SELECT v FROM t WHERE id > 1)",
  "cardinality",
);
queryErrorParity(
  "subquery must return one column in scalar context",
  data,
  "SELECT id FROM t WHERE v = (SELECT id, v FROM t WHERE id = 1)",
  undefined,
);
