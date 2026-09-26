import { runCatalog } from "./run.ts";

const T = [
  "CREATE TABLE t(grp TEXT, n INT, x INT)",
  "INSERT INTO t VALUES ('a',1,10),('a',2,20),('a',2,21),('b',1,30)",
];

runCatalog("WIN", [
  {
    id: "WIN-rank-01",
    kind: "parity",
    setup: T,
    sql: "SELECT n, row_number() OVER (PARTITION BY grp ORDER BY n, x) AS r FROM t ORDER BY grp, n, x",
  },
  {
    id: "WIN-rank-02",
    kind: "parity",
    setup: T,
    sql: "SELECT n, rank() OVER (PARTITION BY grp ORDER BY n) AS r FROM t ORDER BY grp, n, x",
  },
  {
    id: "WIN-rank-03",
    kind: "parity",
    setup: T,
    sql: "SELECT n, dense_rank() OVER (PARTITION BY grp ORDER BY n) AS r FROM t ORDER BY grp, n, x",
  },
  {
    id: "WIN-rank-04",
    kind: "parity",
    setup: T,
    sql: "SELECT n, percent_rank() OVER (PARTITION BY grp ORDER BY n) AS r FROM t ORDER BY grp, n, x",
  },
  {
    id: "WIN-rank-05",
    kind: "parity",
    setup: T,
    sql: "SELECT n, cume_dist() OVER (PARTITION BY grp ORDER BY n) AS r FROM t ORDER BY grp, n, x",
  },
  {
    id: "WIN-ntile-01",
    kind: "parity",
    setup: T,
    sql: "SELECT n, ntile(2) OVER (ORDER BY grp, n, x) AS r FROM t ORDER BY grp, n, x",
  },
  { id: "WIN-ntile-02", kind: "parity", setup: T, sql: "SELECT ntile(2) OVER (ORDER BY n) FROM t ORDER BY n, x" },
  {
    id: "WIN-lag-01",
    kind: "parity",
    setup: T,
    sql: "SELECT n, lag(n) OVER (ORDER BY grp, n, x), lead(n, 2) OVER (ORDER BY grp, n, x) FROM t ORDER BY grp, n, x",
  },
  {
    id: "WIN-lag-02",
    kind: "parity",
    setup: T,
    sql: "SELECT n, lag(n, 1, -1) OVER (ORDER BY grp, n, x) FROM t ORDER BY grp, n, x",
  },
  {
    id: "WIN-nth-01",
    kind: "parity",
    setup: T,
    sql: "SELECT first_value(x) OVER (PARTITION BY grp ORDER BY n, x), last_value(x) OVER (PARTITION BY grp ORDER BY n, x ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING), nth_value(x, 2) OVER (PARTITION BY grp ORDER BY n, x) FROM t ORDER BY grp, n, x",
  },
  {
    id: "WIN-agg-01",
    kind: "parity",
    setup: T,
    sql: "SELECT n, sum(x) OVER (PARTITION BY grp ORDER BY n, x) FROM t ORDER BY grp, n, x",
  },
  {
    id: "WIN-filter-01",
    kind: "parity",
    setup: T,
    sql: "SELECT sum(x) FILTER (WHERE n=1) OVER (PARTITION BY grp) FROM t ORDER BY grp, n, x",
  },
  {
    id: "WIN-part-01",
    kind: "parity",
    setup: T,
    sql: "SELECT count(*) OVER (PARTITION BY grp, n) FROM t ORDER BY grp, n, x",
  },
  {
    id: "WIN-order-01",
    kind: "parity",
    setup: ["CREATE TABLE t(a TEXT)", "INSERT INTO t VALUES ('a'),('B')"],
    sql: "SELECT a, row_number() OVER (ORDER BY a COLLATE NOCASE) FROM t ORDER BY a COLLATE NOCASE",
  },
  {
    id: "WIN-order-02",
    kind: "parity",
    setup: ["CREATE TABLE t(a INT)", "INSERT INTO t VALUES (NULL),(1)"],
    sql: "SELECT a, row_number() OVER (ORDER BY a NULLS FIRST), row_number() OVER (ORDER BY a NULLS LAST) FROM t ORDER BY a NULLS FIRST",
  },
  {
    id: "WIN-frame-01",
    kind: "parity",
    setup: T,
    sql: "SELECT sum(x) OVER (ORDER BY grp, n, x ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM t ORDER BY grp, n, x",
  },
  {
    id: "WIN-frame-02",
    kind: "parity",
    setup: T,
    sql: "SELECT sum(n) OVER (ORDER BY n RANGE BETWEEN 1 PRECEDING AND CURRENT ROW) FROM t ORDER BY grp, n, x",
  },
  {
    id: "WIN-frame-03",
    kind: "parity",
    setup: T,
    sql: "SELECT sum(x) OVER (ORDER BY n GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM t ORDER BY grp, n, x",
  },
  {
    id: "WIN-frame-04",
    kind: "parity",
    setup: T,
    sql: "SELECT sum(x) OVER (ORDER BY n RANGE BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM t ORDER BY grp, n, x",
  },
  {
    id: "WIN-excl-01",
    kind: "parity",
    setup: T,
    sql: "SELECT sum(x) OVER (ORDER BY n ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE NO OTHERS) FROM t ORDER BY grp, n, x",
  },
  {
    id: "WIN-excl-02",
    kind: "parity",
    setup: T,
    sql: "SELECT sum(x) OVER (ORDER BY n ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE CURRENT ROW) FROM t ORDER BY grp, n, x",
  },
  {
    id: "WIN-excl-03",
    kind: "parity",
    setup: T,
    sql: "SELECT sum(x) OVER (ORDER BY n RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE GROUP) FROM t ORDER BY grp, n, x",
  },
  {
    id: "WIN-excl-04",
    kind: "parity",
    setup: T,
    sql: "SELECT sum(x) OVER (ORDER BY n RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE TIES) FROM t ORDER BY grp, n, x",
  },
  {
    id: "WIN-named-01",
    kind: "parity",
    setup: T,
    sql: "SELECT n, row_number() OVER w FROM t WINDOW w AS (PARTITION BY grp ORDER BY n, x) ORDER BY grp, n, x",
  },
  {
    id: "WIN-named-02",
    kind: "parity",
    setup: T,
    sql: "SELECT n, rank() OVER (PARTITION BY grp ORDER BY n) FROM t ORDER BY grp, n, x",
  },
  {
    id: "WIN-sub-01",
    kind: "parity",
    setup: T,
    sql: "SELECT n FROM t ORDER BY n, x",
  },
  { id: "WIN-empty-01", kind: "parity", setup: ["CREATE TABLE t(a INT)"], sql: "SELECT row_number() OVER () FROM t" },
  {
    id: "WIN-peer-01",
    kind: "parity",
    setup: T,
    sql: "SELECT n, sum(x) OVER (ORDER BY n RANGE CURRENT ROW) FROM t ORDER BY grp, n, x",
  },
]);
