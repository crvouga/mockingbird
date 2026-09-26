import { WIN_SECTION } from "../../../compat/sections/win.ts";
import { runCatalog } from "./run.ts";

const SCORES = [
  "CREATE TABLE s (id int, grp text, score int)",
  "INSERT INTO s VALUES (1, 'a', 10), (2, 'a', 20), (3, 'a', 20), (4, 'b', 5), (5, 'b', 15), (6, 'b', 15), (7, 'b', 30)",
];

const T = ["CREATE TABLE t (id int, v int)", "INSERT INTO t VALUES (1, 10), (2, 20), (3, 30), (4, 30), (5, 50)"];

const NAV = [
  "CREATE TABLE n (id int, grp text, v int)",
  "INSERT INTO n VALUES (1, 'a', 100), (2, 'a', 200), (3, 'a', 300), (4, 'b', 10), (5, 'b', 20)",
];

runCatalog(WIN_SECTION, [
  {
    id: "WIN-rank-01",
    kind: "parity",
    setup: SCORES,
    sql: "SELECT id, row_number() OVER (ORDER BY id) AS rn FROM s ORDER BY id",
  },
  {
    id: "WIN-rank-02",
    kind: "parity",
    setup: SCORES,
    sql: "SELECT id, grp, row_number() OVER (PARTITION BY grp ORDER BY score DESC, id) AS rn FROM s ORDER BY id",
  },
  {
    id: "WIN-rank-03",
    kind: "parity",
    setup: SCORES,
    sql: "SELECT id, rank() OVER (PARTITION BY grp ORDER BY score) AS r FROM s ORDER BY id",
  },
  {
    id: "WIN-rank-04",
    kind: "parity",
    setup: SCORES,
    sql: "SELECT id, dense_rank() OVER (PARTITION BY grp ORDER BY score) AS dr FROM s ORDER BY id",
  },
  {
    id: "WIN-rank-05",
    kind: "parity",
    setup: SCORES,
    sql:
      "SELECT id, percent_rank() OVER (PARTITION BY grp ORDER BY score) AS pr, " +
      "cume_dist() OVER (PARTITION BY grp ORDER BY score) AS cd FROM s ORDER BY id",
  },
  {
    id: "WIN-rank-06",
    kind: "parity",
    setup: SCORES,
    sql:
      "SELECT id, ntile(3) OVER (ORDER BY id) AS even, ntile(2) OVER (PARTITION BY grp ORDER BY score, id) AS uneven " +
      "FROM s ORDER BY id",
  },
  {
    id: "WIN-rank-07",
    kind: "parity",
    setup: SCORES,
    sql: "SELECT id, rank() OVER () AS r, row_number() OVER () AS rn FROM s ORDER BY id",
  },
  {
    id: "WIN-nav-01",
    kind: "parity",
    setup: NAV,
    sql: "SELECT id, lag(v) OVER (ORDER BY id) AS prev, lead(v) OVER (ORDER BY id) AS next FROM n ORDER BY id",
  },
  {
    id: "WIN-nav-02",
    kind: "parity",
    setup: NAV,
    sql:
      "SELECT id, lag(v, 2) OVER (ORDER BY id) AS prev2, lead(v, 2, -1) OVER (ORDER BY id) AS next2, " +
      "lag(v, 1, 0) OVER (ORDER BY id) AS prev_dflt FROM n ORDER BY id",
  },
  {
    id: "WIN-nav-03",
    kind: "parity",
    setup: NAV,
    sql:
      "SELECT id, lag(v) OVER (PARTITION BY grp ORDER BY id) AS prev, " +
      "lead(v) OVER (PARTITION BY grp ORDER BY id) AS next FROM n ORDER BY id",
  },
  {
    id: "WIN-nav-04",
    kind: "parity",
    setup: NAV,
    sql: "SELECT id, first_value(v) OVER (PARTITION BY grp ORDER BY id) AS fv FROM n ORDER BY id",
  },
  {
    id: "WIN-nav-05",
    kind: "parity",
    setup: NAV,
    sql:
      "SELECT id, last_value(v) OVER (ORDER BY id) AS dflt, " +
      "last_value(v) OVER (PARTITION BY grp ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS full " +
      "FROM n ORDER BY id",
  },
  {
    id: "WIN-nav-06",
    kind: "parity",
    setup: NAV,
    sql:
      "SELECT id, nth_value(v, 2) OVER w AS nv, nth_value(v, 9) OVER w AS beyond FROM n " +
      "WINDOW w AS (PARTITION BY grp ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) ORDER BY id",
  },
  {
    id: "WIN-nav-07",
    kind: "parity",
    setup: [
      "CREATE TABLE d (d date, s text)",
      "INSERT INTO d VALUES ('2024-01-01', 'a'), ('2024-02-01', 'b'), ('2024-02-15', 'c')",
    ],
    sql:
      "SELECT d, lag(d) OVER (ORDER BY d) AS prev, d - lag(d) OVER (ORDER BY d) AS gap, " +
      "lead(s) OVER (ORDER BY d) AS next_s FROM d ORDER BY d",
  },
  {
    id: "WIN-aggw-01",
    kind: "parity",
    setup: T,
    sql: "SELECT id, sum(v) OVER (ORDER BY id) AS running FROM t ORDER BY id",
  },
  {
    id: "WIN-aggw-02",
    kind: "parity",
    setup: SCORES,
    sql: "SELECT id, avg(score) OVER () AS a, count(*) OVER (PARTITION BY grp) AS n FROM s ORDER BY id",
  },
  {
    id: "WIN-aggw-03",
    kind: "parity",
    setup: T,
    sql: "SELECT id, min(v) OVER (ORDER BY id) AS mn, max(v) OVER (ORDER BY id) AS mx FROM t ORDER BY id",
  },
  {
    id: "WIN-aggw-04",
    kind: "parity",
    setup: ["CREATE TABLE w (id int, s text, v int)", "INSERT INTO w VALUES (1, 'a', 5), (2, 'b', 6), (3, 'c', 7)"],
    sql: "SELECT id, string_agg(s, ',') OVER (ORDER BY id) AS sa, array_agg(v) OVER (ORDER BY id) AS aa FROM w ORDER BY id",
  },
  {
    id: "WIN-aggw-05",
    kind: "parity",
    setup: T,
    sql: "SELECT id, count(*) FILTER (WHERE v > 10) OVER (ORDER BY id) AS c FROM t ORDER BY id",
  },
  {
    id: "WIN-frame-01",
    kind: "parity",
    setup: T,
    sql: "SELECT id, sum(v) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS s FROM t ORDER BY id",
  },
  {
    id: "WIN-frame-02",
    kind: "parity",
    setup: T,
    sql:
      "SELECT id, sum(v) OVER (ORDER BY id ROWS BETWEEN CURRENT ROW AND 2 FOLLOWING) AS fwd, " +
      "sum(v) OVER (ORDER BY id ROWS 2 PRECEDING) AS shorthand FROM t ORDER BY id",
  },
  {
    id: "WIN-frame-03",
    kind: "parity",
    setup: T,
    sql: "SELECT id, sum(v) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS s FROM t ORDER BY id",
  },
  {
    id: "WIN-frame-04",
    kind: "parity",
    setup: T,
    sql: "SELECT id, avg(v) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS a FROM t ORDER BY id",
  },
  {
    id: "WIN-frame-05",
    kind: "parity",
    setup: T,
    sql:
      "SELECT id, sum(v) OVER (ORDER BY v) AS peers, " +
      "count(*) OVER (ORDER BY v RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS c FROM t ORDER BY id",
  },
  {
    id: "WIN-frame-06",
    kind: "parity",
    setup: T,
    sql: "SELECT id, sum(v) OVER (ORDER BY v RANGE BETWEEN 10 PRECEDING AND 10 FOLLOWING) AS s FROM t ORDER BY id",
  },
  {
    id: "WIN-frame-07",
    kind: "parity",
    setup: [
      "CREATE TABLE d (d date, v int)",
      "INSERT INTO d VALUES ('2024-01-01', 1), ('2024-01-05', 2), ('2024-01-20', 3)",
    ],
    sql: "SELECT d, sum(v) OVER (ORDER BY d RANGE BETWEEN interval '7 days' PRECEDING AND CURRENT ROW) AS s FROM d ORDER BY d",
  },
  {
    id: "WIN-frame-08",
    kind: "parity",
    setup: T,
    sql: "SELECT id, sum(v) OVER (ORDER BY v GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW) AS s FROM t ORDER BY id",
  },
  {
    id: "WIN-frame-09",
    kind: "parity",
    setup: T,
    sql:
      "SELECT id, sum(v) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING EXCLUDE CURRENT ROW) AS s " +
      "FROM t ORDER BY id",
  },
  {
    id: "WIN-frame-10",
    kind: "parity",
    setup: T,
    sql:
      "SELECT id, sum(v) OVER (ORDER BY v ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING EXCLUDE GROUP) AS xg, " +
      "sum(v) OVER (ORDER BY v ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING EXCLUDE TIES) AS xt FROM t ORDER BY id",
  },
  {
    id: "WIN-frame-11",
    kind: "parity",
    setup: T,
    sql: "SELECT id, sum(v) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING EXCLUDE NO OTHERS) AS s FROM t ORDER BY id",
  },
  {
    id: "WIN-named-01",
    kind: "parity",
    setup: SCORES,
    sql: "SELECT id, row_number() OVER w AS rn, rank() OVER w AS r FROM s WINDOW w AS (ORDER BY score, id) ORDER BY id",
  },
  {
    id: "WIN-named-02",
    kind: "parity",
    setup: SCORES,
    sql: "SELECT id, row_number() OVER w AS rn FROM s WINDOW w AS (PARTITION BY grp ORDER BY score, id) ORDER BY id",
  },
  {
    id: "WIN-named-03",
    kind: "parity",
    setup: T,
    sql: "SELECT id, sum(v) OVER (w ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS s FROM t WINDOW w AS (ORDER BY id) ORDER BY id",
  },
  {
    id: "WIN-named-04",
    kind: "parity",
    setup: SCORES,
    sql:
      "SELECT id, row_number() OVER w1 AS a, row_number() OVER w2 AS b FROM s " +
      "WINDOW w1 AS (ORDER BY score, id), w2 AS (ORDER BY score DESC, id DESC) ORDER BY id",
  },
  {
    id: "WIN-multi-01",
    kind: "parity",
    setup: SCORES,
    sql:
      "SELECT id, row_number() OVER (ORDER BY id) AS rn, rank() OVER (ORDER BY score, id) AS r, " +
      "dense_rank() OVER (ORDER BY score) AS dr, sum(score) OVER (PARTITION BY grp) AS gs FROM s ORDER BY id",
  },
  {
    id: "WIN-multi-02",
    kind: "parity",
    setup: SCORES,
    sql: "SELECT id FROM s ORDER BY row_number() OVER (ORDER BY score DESC, id DESC), id",
  },
  {
    id: "WIN-mix-01",
    kind: "parity",
    setup: ["CREATE TABLE m (g text, v int)", "INSERT INTO m VALUES ('a', 1), ('a', 2), ('b', 5), ('c', 3)"],
    sql: "SELECT g, sum(v) AS s, sum(sum(v)) OVER (ORDER BY g) AS running FROM m GROUP BY g ORDER BY g",
  },
  {
    id: "WIN-mix-02",
    kind: "parity",
    setup: SCORES,
    sql:
      "SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY grp ORDER BY score DESC, id) AS rn FROM s) x " +
      "WHERE rn = 1 ORDER BY id",
  },
  {
    id: "WIN-err-01",
    kind: "error",
    setup: SCORES,
    sql: "SELECT rank() OVER nope FROM s",
    query: true,
    messageTier: "A",
  },
]);
