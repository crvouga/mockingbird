import { parity, rankParity } from "../helpers.ts";

const t = [
  "CREATE TABLE t (id int, grp text, v int)",
  "INSERT INTO t VALUES (1, 'a', 10), (2, 'a', 20), (3, 'b', 30), (4, 'b', 40), (5, 'b', 50)",
];

// FILTER (WHERE ...)
parity("count with filter", t, "SELECT count(*) FILTER (WHERE v > 20) AS n FROM t");
parity("sum with filter", t, "SELECT sum(v) FILTER (WHERE grp = 'b') AS s FROM t");
parity(
  "multiple filtered aggregates",
  t,
  "SELECT count(*) FILTER (WHERE grp = 'a') AS a_n, count(*) FILTER (WHERE grp = 'b') AS b_n FROM t",
);
parity("filter with group by", t, "SELECT grp, sum(v) FILTER (WHERE v >= 20) AS s FROM t GROUP BY grp ORDER BY grp");
parity(
  "filter excludes everything",
  t,
  "SELECT sum(v) FILTER (WHERE false) AS s, count(*) FILTER (WHERE false) AS n FROM t",
);
parity("avg with filter", t, "SELECT avg(v) FILTER (WHERE v > 10) AS a FROM t");
parity("filter with distinct inside", t, "SELECT count(DISTINCT grp) FILTER (WHERE v > 10) AS n FROM t");

// statistics
parity("stddev_samp", t, "SELECT stddev_samp(v) AS s FROM t");
parity("stddev default is samp", t, "SELECT stddev(v) AS s FROM t");
parity("stddev_pop", t, "SELECT stddev_pop(v) AS s FROM t");
parity("var_samp", t, "SELECT var_samp(v) AS s FROM t");
parity("var_pop", t, "SELECT var_pop(v) AS s FROM t");
parity("variance default is samp", t, "SELECT variance(v) AS s FROM t");
parity(
  "stddev_samp of single row is null",
  ["CREATE TABLE s (v int)", "INSERT INTO s VALUES (5)"],
  "SELECT stddev_samp(v) AS ss FROM s",
);
parity("variance empty input", ["CREATE TABLE s (v int)"], "SELECT var_samp(v) AS v1, var_pop(v) AS v2 FROM s");
rankParity("stddev per group", t, "SELECT grp, stddev_samp(v) AS s FROM t GROUP BY grp ORDER BY grp");

// ordered-set aggregates
parity("percentile_cont median", t, "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY v) AS median FROM t");
parity(
  "percentile_cont interpolates",
  ["CREATE TABLE s (v int)", "INSERT INTO s VALUES (1), (2), (3), (4)"],
  "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY v) AS median FROM s",
);
parity("percentile_disc", t, "SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY v) AS median FROM t");
parity(
  "percentile_cont zero and one",
  t,
  "SELECT percentile_cont(0) WITHIN GROUP (ORDER BY v) AS lo, percentile_cont(1) WITHIN GROUP (ORDER BY v) AS hi FROM t",
);
parity(
  "mode",
  ["CREATE TABLE s (v int)", "INSERT INTO s VALUES (1), (2), (2), (3)"],
  "SELECT mode() WITHIN GROUP (ORDER BY v) AS m FROM s",
);
parity(
  "mode ties pick first in order",
  ["CREATE TABLE s (v int)", "INSERT INTO s VALUES (1), (1), (2), (2)"],
  "SELECT mode() WITHIN GROUP (ORDER BY v) AS m FROM s",
);
parity(
  "percentile empty input",
  ["CREATE TABLE s (v int)"],
  "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY v) AS p FROM s",
);
