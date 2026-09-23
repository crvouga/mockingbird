import { parity } from "../helpers.ts";

const t = ["CREATE TABLE t (id int, v int)", "INSERT INTO t VALUES (1, 10), (2, 20), (3, 30)"];

parity("basic with", t, "WITH big AS (SELECT * FROM t WHERE v > 15) SELECT id FROM big ORDER BY id");
parity(
  "with over values",
  [],
  "WITH nums AS (SELECT * FROM (VALUES (1), (2), (3)) v(n)) SELECT n * 10 AS x FROM nums ORDER BY x",
);
parity(
  "multiple ctes",
  t,
  "WITH a AS (SELECT id FROM t WHERE v > 5), b AS (SELECT id FROM t WHERE v < 25) SELECT a.id FROM a JOIN b ON a.id = b.id ORDER BY a.id",
);
parity(
  "cte referencing earlier cte",
  t,
  "WITH a AS (SELECT id, v FROM t), b AS (SELECT id, v * 2 AS w FROM a) SELECT id, w FROM b ORDER BY id",
);
parity(
  "cte chain three deep",
  [],
  "WITH a AS (SELECT 1 AS n), b AS (SELECT n + 1 AS n FROM a), c AS (SELECT n + 1 AS n FROM b) SELECT n FROM c",
);
parity(
  "cte used twice in body",
  t,
  "WITH s AS (SELECT id, v FROM t) SELECT x.id FROM s x JOIN s y ON x.v = y.v ORDER BY x.id",
);
parity("cte column aliases", t, "WITH s(a, b) AS (SELECT id, v FROM t) SELECT a, b FROM s ORDER BY a");
parity("cte partial column aliases derive rest", t, "WITH s(a) AS (SELECT id FROM t) SELECT a FROM s ORDER BY a");
parity("cte with aggregate", t, "WITH totals AS (SELECT sum(v) AS total FROM t) SELECT total FROM totals");
parity(
  "cte joined to base table",
  t,
  "WITH mx AS (SELECT max(v) AS m FROM t) SELECT t.id FROM t, mx WHERE t.v = mx.m ORDER BY t.id",
);
parity("cte shadows table name", t, "WITH t AS (SELECT 99 AS id) SELECT id FROM t");
parity("cte in subquery", t, "SELECT * FROM (WITH s AS (SELECT id FROM t) SELECT id FROM s) q ORDER BY id");
parity(
  "cte with order by and limit inside",
  t,
  "WITH top2 AS (SELECT id, v FROM t ORDER BY v DESC LIMIT 2) SELECT id FROM top2 ORDER BY id",
);
parity("cte with set operation body", [], "WITH s AS (SELECT 1 AS v UNION SELECT 2) SELECT v FROM s ORDER BY v");
