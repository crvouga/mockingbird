import { parity } from "../helpers.ts";

parity("unnest int array", [], "SELECT * FROM unnest(ARRAY[3, 1, 2]) AS u(v) ORDER BY v");
parity("unnest text array", [], "SELECT * FROM unnest(ARRAY['b', 'a']) AS u(v) ORDER BY v");
parity(
  "unnest preserves element order without sort",
  [],
  "SELECT v, row_number() OVER () AS rn FROM unnest(ARRAY[30, 10, 20]) AS u(v) ORDER BY rn",
);
parity("unnest empty array", [], "SELECT * FROM unnest(ARRAY[]::int[]) AS u(v)");
parity("unnest array with nulls", [], "SELECT * FROM unnest(ARRAY[1, NULL, 3]) AS u(v) ORDER BY v NULLS LAST");
parity(
  "unnest multi argument",
  [],
  "SELECT a, b FROM unnest(ARRAY[1, 2, 3], ARRAY['x', 'y']) AS u(a, b) ORDER BY a NULLS LAST",
);
parity(
  "unnest with ordinality",
  [],
  "SELECT v, ord FROM unnest(ARRAY['c', 'a', 'b']) WITH ORDINALITY AS u(v, ord) ORDER BY ord",
);
parity(
  "unnest multi arg with ordinality",
  [],
  "SELECT a, b, ord FROM unnest(ARRAY[10, 20], ARRAY['p', 'q', 'r']) WITH ORDINALITY AS u(a, b, ord) ORDER BY ord",
);
parity(
  "unnest column from table",
  ["CREATE TABLE t (id int, xs int[])", "INSERT INTO t VALUES (1, ARRAY[5, 3]), (2, ARRAY[9])"],
  "SELECT t.id, u.v FROM t, unnest(t.xs) AS u(v) ORDER BY t.id, u.v",
);
parity("unnest default column name", [], "SELECT unnest FROM unnest(ARRAY[2, 1]) ORDER BY 1");
parity("unnest in aggregate", [], "SELECT sum(v) AS s FROM unnest(ARRAY[1, 2, 3, 4]) AS u(v)");
parity(
  "generate_series with ordinality",
  [],
  "SELECT v, ord FROM generate_series(10, 30, 10) WITH ORDINALITY AS g(v, ord) ORDER BY ord",
);
parity(
  "unnest round trip through array_agg",
  [],
  "SELECT array_agg(v ORDER BY v) AS agg FROM unnest(ARRAY[3, 1, 2]) AS u(v)",
);
