import { parity, queryErrorParity } from "../helpers.ts";

const t = ["CREATE TABLE t (id int, grp text, v int)", "INSERT INTO t VALUES (1, 'a', 10), (2, 'a', 20), (3, 'b', 30)"];

// named windows (WINDOW clause)
parity(
  "named window reused by two functions",
  t,
  "SELECT id, row_number() OVER w AS rn, rank() OVER w AS r FROM t WINDOW w AS (ORDER BY v) ORDER BY id",
);
parity(
  "named window with partition",
  t,
  "SELECT id, row_number() OVER w AS rn FROM t WINDOW w AS (PARTITION BY grp ORDER BY v) ORDER BY id",
);
parity(
  "named window refined with frame in over",
  t,
  "SELECT id, sum(v) OVER (w ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS s FROM t WINDOW w AS (ORDER BY id) ORDER BY id",
);
parity(
  "two named windows",
  t,
  "SELECT id, row_number() OVER w1 AS a, row_number() OVER w2 AS b FROM t WINDOW w1 AS (ORDER BY v), w2 AS (ORDER BY v DESC) ORDER BY id",
);
parity("window function in order by clause", t, "SELECT id FROM t ORDER BY row_number() OVER (ORDER BY v DESC), id");

// errors
queryErrorParity("undefined named window", t, "SELECT rank() OVER nope FROM t", "undefined_object");
