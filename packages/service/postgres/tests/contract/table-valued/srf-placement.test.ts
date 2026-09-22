import { parity } from "../helpers.ts";

// SRFs in the select list
parity("srf in select list expands rows", [], "SELECT generate_series(1, 3) AS v");
parity("srf in select list with scalar column", [], "SELECT 'k' AS tag, generate_series(1, 2) AS v");
parity("unnest in select list", [], "SELECT unnest(ARRAY[3, 1, 2]) AS v");
parity(
  "srf in select list per input row",
  ["CREATE TABLE t (id int, n int)", "INSERT INTO t VALUES (1, 2), (2, 1)"],
  "SELECT id, generate_series(1, n) AS g FROM t ORDER BY id, g",
);
parity("two srfs in select list run in lockstep", [], "SELECT generate_series(1, 3) AS a, generate_series(1, 2) AS b");
parity("srf in select list with order by", [], "SELECT generate_series(1, 4) AS v ORDER BY v DESC");

// ROWS FROM
parity("rows from single function", [], "SELECT * FROM ROWS FROM (generate_series(1, 3)) AS r(v) ORDER BY v");
parity(
  "rows from two functions zips",
  [],
  "SELECT a, b FROM ROWS FROM (generate_series(1, 3), unnest(ARRAY['x', 'y'])) AS r(a, b) ORDER BY a NULLS LAST",
);
parity(
  "rows from with ordinality",
  [],
  "SELECT a, b, ord FROM ROWS FROM (generate_series(1, 2), generate_series(10, 12)) WITH ORDINALITY AS r(a, b, ord) ORDER BY ord",
);
parity(
  "rows from mixed lengths pads with nulls",
  [],
  "SELECT a, b FROM ROWS FROM (unnest(ARRAY[1]), unnest(ARRAY['p', 'q', 'r'])) AS r(a, b) ORDER BY b",
);
