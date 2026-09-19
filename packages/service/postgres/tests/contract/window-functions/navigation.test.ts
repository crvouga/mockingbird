import { parity } from "../helpers.ts";

const t = [
  "CREATE TABLE t (id int, grp text, v int)",
  "INSERT INTO t VALUES (1, 'a', 100), (2, 'a', 200), (3, 'a', 300), (4, 'b', 10), (5, 'b', 20)",
];

parity("lag default one", t, "SELECT id, lag(v) OVER (ORDER BY id) AS prev FROM t ORDER BY id");
parity("lead default one", t, "SELECT id, lead(v) OVER (ORDER BY id) AS next FROM t ORDER BY id");
parity("lag with offset", t, "SELECT id, lag(v, 2) OVER (ORDER BY id) AS prev2 FROM t ORDER BY id");
parity("lead with offset and default", t, "SELECT id, lead(v, 2, -1) OVER (ORDER BY id) AS next2 FROM t ORDER BY id");
parity("lag with default", t, "SELECT id, lag(v, 1, 0) OVER (ORDER BY id) AS prev FROM t ORDER BY id");
parity(
  "lag partitioned resets at boundary",
  t,
  "SELECT id, lag(v) OVER (PARTITION BY grp ORDER BY id) AS prev FROM t ORDER BY id",
);
parity("lead partitioned", t, "SELECT id, lead(v) OVER (PARTITION BY grp ORDER BY id) AS next FROM t ORDER BY id");
parity("first_value", t, "SELECT id, first_value(v) OVER (PARTITION BY grp ORDER BY id) AS fv FROM t ORDER BY id");
parity(
  "last_value default frame stops at current row",
  t,
  "SELECT id, last_value(v) OVER (ORDER BY id) AS lv FROM t ORDER BY id",
);
parity(
  "last_value with full frame",
  t,
  "SELECT id, last_value(v) OVER (PARTITION BY grp ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS lv FROM t ORDER BY id",
);
parity(
  "nth_value",
  t,
  "SELECT id, nth_value(v, 2) OVER (PARTITION BY grp ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS nv FROM t ORDER BY id",
);
parity(
  "nth_value beyond partition size is null",
  t,
  "SELECT id, nth_value(v, 9) OVER (PARTITION BY grp ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS nv FROM t ORDER BY id",
);
parity("lag expression argument", t, "SELECT id, v - lag(v, 1, 0) OVER (ORDER BY id) AS delta FROM t ORDER BY id");
parity(
  "first and last combined",
  t,
  "SELECT id, first_value(v) OVER w AS fv, last_value(v) OVER w AS lv FROM t WINDOW w AS (PARTITION BY grp ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) ORDER BY id",
);
