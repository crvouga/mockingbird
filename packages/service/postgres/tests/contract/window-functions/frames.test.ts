import { parity } from "../helpers.ts";

const t = ["CREATE TABLE t (id int, v int)", "INSERT INTO t VALUES (1, 10), (2, 20), (3, 30), (4, 30), (5, 50)"];

// aggregates as window functions
parity("sum over running total", t, "SELECT id, sum(v) OVER (ORDER BY id) AS running FROM t ORDER BY id");
parity("avg over whole partition", t, "SELECT id, avg(v) OVER () AS a FROM t ORDER BY id");
parity(
  "count over partition",
  ["CREATE TABLE s (g text, v int)", "INSERT INTO s VALUES ('a', 1), ('a', 2), ('b', 3)"],
  "SELECT g, count(*) OVER (PARTITION BY g) AS n FROM s ORDER BY g, v",
);
parity(
  "min max over running",
  t,
  "SELECT id, min(v) OVER (ORDER BY id) AS mn, max(v) OVER (ORDER BY id) AS mx FROM t ORDER BY id",
);

// ROWS frames
parity(
  "rows between preceding and current",
  t,
  "SELECT id, sum(v) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS s FROM t ORDER BY id",
);
parity(
  "rows between current and following",
  t,
  "SELECT id, sum(v) OVER (ORDER BY id ROWS BETWEEN CURRENT ROW AND 2 FOLLOWING) AS s FROM t ORDER BY id",
);
parity(
  "rows between unbounded preceding and unbounded following",
  t,
  "SELECT id, sum(v) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS s FROM t ORDER BY id",
);
parity(
  "rows moving window centered",
  t,
  "SELECT id, avg(v) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS a FROM t ORDER BY id",
);
parity(
  "rows shorthand n preceding",
  t,
  "SELECT id, sum(v) OVER (ORDER BY id ROWS 2 PRECEDING) AS s FROM t ORDER BY id",
);

// RANGE frames
parity("range default with peers", t, "SELECT id, sum(v) OVER (ORDER BY v) AS s FROM t ORDER BY id");
parity(
  "range between numeric offsets",
  t,
  "SELECT id, sum(v) OVER (ORDER BY v RANGE BETWEEN 10 PRECEDING AND 10 FOLLOWING) AS s FROM t ORDER BY id",
);
parity(
  "range unbounded preceding to current includes peers",
  t,
  "SELECT id, count(*) OVER (ORDER BY v RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS c FROM t ORDER BY id",
);

// GROUPS frames
parity(
  "groups frame counts peer groups",
  t,
  "SELECT id, sum(v) OVER (ORDER BY v GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW) AS s FROM t ORDER BY id",
);

// EXCLUDE
parity(
  "frame exclude current row",
  t,
  "SELECT id, sum(v) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING EXCLUDE CURRENT ROW) AS s FROM t ORDER BY id",
);
parity(
  "frame exclude group",
  t,
  "SELECT id, sum(v) OVER (ORDER BY v ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING EXCLUDE GROUP) AS s FROM t ORDER BY id",
);
parity(
  "frame exclude ties",
  t,
  "SELECT id, sum(v) OVER (ORDER BY v ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING EXCLUDE TIES) AS s FROM t ORDER BY id",
);
parity(
  "frame exclude no others explicit",
  t,
  "SELECT id, sum(v) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING EXCLUDE NO OTHERS) AS s FROM t ORDER BY id",
);
