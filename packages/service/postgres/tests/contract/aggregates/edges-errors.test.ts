import { parity, queryErrorParity } from "../helpers.ts";

const t = ["CREATE TABLE t (id int, v int)", "INSERT INTO t VALUES (1, 10), (2, 20), (3, 30)"];

// edge semantics
parity("count star vs count constant", t, "SELECT count(*) AS a, count(1) AS b FROM t");
parity("count null constant is zero", t, "SELECT count(NULL) AS n FROM t");
parity(
  "sum bigint overflow avoided via numeric",
  ["CREATE TABLE s (v bigint)", "INSERT INTO s VALUES (9223372036854775806), (1)"],
  "SELECT sum(v) AS s FROM s",
);
parity("aggregate inside expression", t, "SELECT max(v) - min(v) AS spread FROM t");
parity("aggregate of case expression", t, "SELECT sum(CASE WHEN v > 15 THEN 1 ELSE 0 END) AS n FROM t");
parity(
  "aggregate in subquery per outer row",
  t,
  "SELECT id, (SELECT count(*) FROM t i WHERE i.v <= o.v) AS rank FROM t o ORDER BY id",
);
parity(
  "group by with all aggregate select",
  t,
  "SELECT count(*) AS n, sum(v) AS s, avg(v) AS a, min(v) AS mn, max(v) AS mx FROM t",
);
parity(
  "aggregate over join",
  [
    "CREATE TABLE a (id int)",
    "CREATE TABLE b (aid int, v int)",
    "INSERT INTO a VALUES (1), (2)",
    "INSERT INTO b VALUES (1, 5), (1, 7), (2, 1)",
  ],
  "SELECT a.id, coalesce(sum(b.v), 0) AS s FROM a LEFT JOIN b ON b.aid = a.id GROUP BY a.id ORDER BY a.id",
);
parity(
  "count star with left join counts rows not matches",
  ["CREATE TABLE a (id int)", "CREATE TABLE b (aid int)", "INSERT INTO a VALUES (1), (2)", "INSERT INTO b VALUES (1)"],
  "SELECT a.id, count(*) AS cs, count(b.aid) AS cb FROM a LEFT JOIN b ON b.aid = a.id GROUP BY a.id ORDER BY a.id",
);
parity("sum with order by inside no-op for plain agg", t, "SELECT sum(v ORDER BY v DESC) AS s FROM t");

// errors
queryErrorParity("undefined column inside aggregate", t, "SELECT sum(zz) FROM t", "undefined_column");
