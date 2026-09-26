import { parity } from "../helpers.ts";

parity(
  "lateral generate_series from column",
  ["CREATE TABLE t (n int)", "INSERT INTO t VALUES (1), (3)"],
  "SELECT t.n, g.v FROM t, LATERAL generate_series(1, t.n) AS g(v) ORDER BY t.n, g.v",
);
parity(
  "cross apply pattern with generate_series",
  ["CREATE TABLE t (id int, cnt int)", "INSERT INTO t VALUES (1, 2), (2, 0), (3, 3)"],
  "SELECT t.id, g.v FROM t CROSS JOIN LATERAL generate_series(1, t.cnt) AS g(v) ORDER BY t.id, g.v",
);
parity(
  "left join lateral generate_series keeps zero-count rows",
  ["CREATE TABLE t (id int, cnt int)", "INSERT INTO t VALUES (1, 2), (2, 0)"],
  "SELECT t.id, g.v FROM t LEFT JOIN LATERAL generate_series(1, t.cnt) AS g(v) ON true ORDER BY t.id, g.v NULLS LAST",
);
parity(
  "implicit lateral for srf referencing outer",
  ["CREATE TABLE t (n int)", "INSERT INTO t VALUES (2), (3)"],
  "SELECT t.n, s.v FROM t, generate_series(1, t.n) AS s(v) ORDER BY t.n, s.v",
);
parity(
  "lateral unnest of array column",
  ["CREATE TABLE t (id int, xs int[])", "INSERT INTO t VALUES (1, ARRAY[10, 20]), (2, ARRAY[30])"],
  "SELECT t.id, u.x FROM t, LATERAL unnest(t.xs) AS u(x) ORDER BY t.id, u.x",
);
parity(
  "lateral unnest with ordinality",
  ["CREATE TABLE t (id int, xs text[])", "INSERT INTO t VALUES (1, ARRAY['a', 'b']), (2, ARRAY['c'])"],
  "SELECT t.id, u.x, u.ord FROM t, LATERAL unnest(t.xs) WITH ORDINALITY AS u(x, ord) ORDER BY t.id, u.ord",
);
parity(
  "lateral string_to_table",
  ["CREATE TABLE t (id int, csv text)", "INSERT INTO t VALUES (1, 'a,b'), (2, 'c')"],
  "SELECT t.id, s.part FROM t, LATERAL string_to_table(t.csv, ',') AS s(part) ORDER BY t.id, s.part",
);
parity(
  "lateral generate_series with step",
  ["CREATE TABLE t (hi int)", "INSERT INTO t VALUES (5), (6)"],
  "SELECT t.hi, g.v FROM t, LATERAL generate_series(0, t.hi, 2) AS g(v) ORDER BY t.hi, g.v",
);
