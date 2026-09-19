import { AGG_SECTION } from "../../../compat/sections/agg.ts";
import { runCatalog } from "./run.ts";

const T = [
  "CREATE TABLE t (id int, v int, s text)",
  "INSERT INTO t VALUES (1, 10, 'a'), (2, 20, 'b'), (3, 30, 'a'), (4, NULL, 'c')",
];

const G = [
  "CREATE TABLE g (id int, grp text, v int)",
  "INSERT INTO g VALUES (1, 'a', 10), (2, 'a', 20), (3, 'b', 30), (4, 'b', 40), (5, 'b', 50)",
];

runCatalog(AGG_SECTION, [
  {
    id: "AGG-cnt-01",
    kind: "parity",
    setup: T,
    sql: "SELECT count(*) AS star, count(v) AS col, count(1) AS one, count(NULL) AS nul FROM t",
  },
  {
    id: "AGG-cnt-02",
    kind: "parity",
    setup: ["CREATE TABLE s (a int, b int)", "INSERT INTO s VALUES (1, 1), (1, 1), (1, 2), (2, 2), (NULL, 1)"],
    sql: "SELECT count(DISTINCT a) AS da, count(DISTINCT (a, b)) AS drow FROM s",
  },
  {
    id: "AGG-sum-01",
    kind: "parity",
    setup: ["CREATE TABLE s (i int, n numeric, f float8)", "INSERT INTO s VALUES (1, 1.5, 0.25), (2, 2.25, 0.5)"],
    sql: "SELECT sum(i) AS si, sum(n) AS sn, sum(f) AS sf FROM s",
  },
  {
    id: "AGG-sum-02",
    kind: "parity",
    typed: true,
    setup: T,
    sql: "SELECT sum(v) AS s, avg(v) AS a, count(*) AS n FROM t",
  },
  {
    id: "AGG-sum-03",
    kind: "parity",
    setup: ["CREATE TABLE s (v bigint)", "INSERT INTO s VALUES (9223372036854775806), (1)"],
    sql: "SELECT sum(v) AS s FROM s",
  },
  { id: "AGG-avg-01", kind: "parity", setup: T, sql: "SELECT avg(v) AS a, avg(v * 2) AS a2 FROM t" },
  {
    id: "AGG-minmax-01",
    kind: "parity",
    setup: T,
    sql: "SELECT min(v) AS mn, max(v) AS mx, min(s) AS smn, max(s) AS smx FROM t",
  },
  {
    id: "AGG-minmax-02",
    kind: "parity",
    setup: [
      "CREATE TABLE s (d date, iv interval)",
      "INSERT INTO s VALUES ('2024-01-01', '1 hour'), ('2023-06-15', '30 minutes')",
    ],
    sql: "SELECT min(d) AS dmn, max(d) AS dmx, min(iv) AS ivmn, max(iv) AS ivmx, sum(iv) AS ivsum, avg(iv) AS ivavg FROM s",
  },
  {
    id: "AGG-empty-01",
    kind: "parity",
    setup: ["CREATE TABLE e (v int)"],
    sql: "SELECT count(*) AS n, count(v) AS nv, sum(v) AS s, avg(v) AS a, min(v) AS mn, max(v) AS mx FROM e",
  },
  {
    id: "AGG-empty-02",
    kind: "parity",
    setup: ["CREATE TABLE e (v int)", "INSERT INTO e VALUES (NULL), (NULL)"],
    sql: "SELECT count(v) AS c, sum(v) AS s, avg(v) AS a, min(v) AS mn FROM e",
  },
  {
    id: "AGG-str-01",
    kind: "parity",
    setup: T,
    sql: "SELECT string_agg(s, ',' ORDER BY s) AS asc_agg, string_agg(s, '-' ORDER BY s DESC) AS desc_agg, string_agg(s, '' ORDER BY id) AS empty_sep FROM t",
  },
  {
    id: "AGG-str-02",
    kind: "parity",
    setup: ["CREATE TABLE s (v text)", "INSERT INTO s VALUES ('a'), (NULL), ('b')"],
    sql: "SELECT string_agg(v, '+' ORDER BY v) AS skips_null, string_agg(v, NULL ORDER BY v) AS null_sep FROM s",
  },
  {
    id: "AGG-str-03",
    kind: "parity",
    setup: T,
    sql: "SELECT v, string_agg(s, ',' ORDER BY s) AS agg FROM t GROUP BY v ORDER BY v NULLS LAST",
  },
  {
    id: "AGG-arr-01",
    kind: "parity",
    setup: ["CREATE TABLE s (v int)", "INSERT INTO s VALUES (1), (NULL), (2)"],
    sql: "SELECT array_agg(v ORDER BY v NULLS FIRST) AS with_nulls FROM s",
  },
  {
    id: "AGG-arr-02",
    kind: "parity",
    setup: [...T, "CREATE TABLE e (v int)"],
    sql: "SELECT (SELECT array_agg(v) FROM e) AS empty, (SELECT array_agg(s ORDER BY s) FROM t WHERE v >= 20) AS filtered",
  },
  {
    id: "AGG-jsn-01",
    kind: "parity",
    setup: T,
    sql: "SELECT jsonb_agg(v ORDER BY v NULLS LAST) AS jb, json_agg(s ORDER BY s) AS j FROM t",
  },
  {
    id: "AGG-jsn-02",
    kind: "parity",
    setup: ["CREATE TABLE kv (k text, v int)", "INSERT INTO kv VALUES ('a', 1), ('b', 2), ('c', NULL)"],
    sql: "SELECT jsonb_object_agg(k, v) AS jb, json_object_agg(k, v ORDER BY k) AS j FROM kv",
  },
  {
    id: "AGG-bool-01",
    kind: "parity",
    setup: ["CREATE TABLE b (id int, f boolean)", "INSERT INTO b VALUES (1, true), (2, false), (3, true), (4, NULL)"],
    sql: "SELECT bool_and(f) AS ba, bool_or(f) AS bo, every(f) AS ev FROM b",
  },
  {
    id: "AGG-bool-02",
    kind: "parity",
    setup: ["CREATE TABLE b (f boolean)"],
    sql: "SELECT bool_and(f) AS a, bool_or(f) AS o, every(f) AS e FROM b",
  },
  {
    id: "AGG-bit-01",
    kind: "parity",
    setup: ["CREATE TABLE s (v int)", "INSERT INTO s VALUES (6), (3), (7)"],
    sql: "SELECT bit_and(v) AS band, bit_or(v) AS bor, bit_xor(v) AS bxor FROM s",
  },
  {
    id: "AGG-dist-01",
    kind: "parity",
    setup: ["CREATE TABLE s (v int)", "INSERT INTO s VALUES (10), (10), (20)"],
    sql: "SELECT sum(DISTINCT v) AS s, avg(DISTINCT v) AS a FROM s",
  },
  {
    id: "AGG-dist-02",
    kind: "parity",
    setup: ["CREATE TABLE s (v text)", "INSERT INTO s VALUES ('a'), ('b'), ('a')"],
    sql: "SELECT string_agg(DISTINCT v, ',' ORDER BY v) AS sa, array_agg(DISTINCT v ORDER BY v) AS aa FROM s",
  },
  {
    id: "AGG-fil-01",
    kind: "parity",
    setup: G,
    sql:
      "SELECT count(*) FILTER (WHERE v > 20) AS n, sum(v) FILTER (WHERE grp = 'b') AS s, " +
      "avg(v) FILTER (WHERE v > 10) AS a FROM g",
  },
  {
    id: "AGG-fil-02",
    kind: "parity",
    setup: G,
    sql: "SELECT grp, sum(v) FILTER (WHERE v >= 20) AS s FROM g GROUP BY grp ORDER BY grp",
  },
  {
    id: "AGG-fil-03",
    kind: "parity",
    setup: G,
    sql:
      "SELECT sum(v) FILTER (WHERE false) AS s, count(*) FILTER (WHERE false) AS n, " +
      "count(DISTINCT grp) FILTER (WHERE v > 10) AS d FROM g",
  },
  {
    id: "AGG-grp-01",
    kind: "parity",
    setup: G,
    sql: "SELECT grp, sum(v) AS s FROM g GROUP BY grp HAVING sum(v) > 40 ORDER BY grp",
  },
  {
    id: "AGG-grp-02",
    kind: "parity",
    setup: ["CREATE TABLE s (v int)", "INSERT INTO s VALUES (1), (2), (3), (4)"],
    sql: "SELECT v % 2 AS parity, count(*) AS n, sum(v) AS s FROM s GROUP BY v % 2 ORDER BY parity",
  },
  {
    id: "AGG-grp-03",
    kind: "parity",
    setup: [
      "CREATE TABLE a (id int)",
      "CREATE TABLE b (aid int, v int)",
      "INSERT INTO a VALUES (1), (2)",
      "INSERT INTO b VALUES (1, 5), (1, 7), (2, 1)",
    ],
    sql:
      "SELECT a.id, coalesce(sum(b.v), 0) AS s, count(*) AS cs, count(b.aid) AS cb " +
      "FROM a LEFT JOIN b ON b.aid = a.id GROUP BY a.id ORDER BY a.id",
  },
  {
    id: "AGG-std-01",
    kind: "parity",
    setup: G,
    sql: "SELECT stddev_samp(v) AS ss, stddev(v) AS sdefault, stddev_pop(v) AS sp FROM g",
  },
  {
    id: "AGG-std-02",
    kind: "parity",
    setup: G,
    sql: "SELECT var_samp(v) AS vs, var_pop(v) AS vp, variance(v) AS vdefault FROM g",
  },
  {
    id: "AGG-std-03",
    kind: "parity",
    setup: ["CREATE TABLE s (v int)", "INSERT INTO s VALUES (5)", "CREATE TABLE e (v int)"],
    sql:
      "SELECT (SELECT stddev_samp(v) FROM s) AS single, (SELECT var_samp(v) FROM e) AS empty_samp, " +
      "(SELECT var_pop(v) FROM e) AS empty_pop",
  },
  {
    id: "AGG-pct-01",
    kind: "parity",
    setup: ["CREATE TABLE s (v int)", "INSERT INTO s VALUES (1), (2), (3), (4)"],
    sql: "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY v) AS median FROM s",
  },
  {
    id: "AGG-pct-02",
    kind: "parity",
    setup: G,
    sql:
      "SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY v) AS disc, " +
      "percentile_cont(0) WITHIN GROUP (ORDER BY v) AS lo, percentile_cont(1) WITHIN GROUP (ORDER BY v) AS hi FROM g",
  },
  {
    id: "AGG-pct-03",
    kind: "parity",
    setup: ["CREATE TABLE e (v int)"],
    sql: "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY v) AS p FROM e",
  },
  {
    id: "AGG-mode-01",
    kind: "parity",
    setup: [
      "CREATE TABLE s (v int)",
      "INSERT INTO s VALUES (1), (2), (2), (3)",
      "CREATE TABLE ties (v int)",
      "INSERT INTO ties VALUES (1), (1), (2), (2)",
    ],
    sql: "SELECT (SELECT mode() WITHIN GROUP (ORDER BY v) FROM s) AS m, (SELECT mode() WITHIN GROUP (ORDER BY v) FROM ties) AS tie",
  },
  {
    id: "AGG-corr-01",
    kind: "parity",
    setup: ["CREATE TABLE s (x float8, y float8)", "INSERT INTO s VALUES (1, 2), (2, 4), (3, 5)"],
    sql: "SELECT corr(y, x) AS c, covar_pop(y, x) AS cp, covar_samp(y, x) AS cs FROM s",
    options: { realEpsilon: 1e-12 },
  },
  {
    id: "AGG-corr-02",
    kind: "parity",
    setup: ["CREATE TABLE s (x float8, y float8)", "INSERT INTO s VALUES (1, 2), (2, 4), (3, 5)"],
    sql: "SELECT regr_slope(y, x) AS s, regr_intercept(y, x) AS i, regr_r2(y, x) AS r2, regr_count(y, x) AS n FROM s",
    options: { realEpsilon: 1e-12 },
  },
  {
    id: "AGG-expr-01",
    kind: "parity",
    setup: G,
    sql: "SELECT max(v) - min(v) AS spread, sum(CASE WHEN v > 20 THEN 1 ELSE 0 END) AS above FROM g",
  },
  { id: "AGG-ord-01", kind: "parity", setup: G, sql: "SELECT sum(v ORDER BY v DESC) AS s FROM g" },
  {
    id: "AGG-sub-01",
    kind: "parity",
    setup: G,
    sql: "SELECT id, (SELECT count(*) FROM g i WHERE i.v <= o.v) AS rank FROM g o ORDER BY id",
  },
  {
    id: "AGG-err-01",
    kind: "error",
    setup: G,
    sql: "SELECT sum(zz) FROM g",
    query: true,
    messageTier: "A",
  },
]);
