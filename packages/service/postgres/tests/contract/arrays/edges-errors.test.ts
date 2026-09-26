import { parity, queryErrorParity } from "../helpers.ts";

// edges
parity("array of numerics", [], "SELECT ARRAY[1.5, 2.25] AS a");
parity("array cast int to text elements", [], "SELECT ARRAY[1, 2]::text[] AS a");
parity(
  "array null vs empty distinction",
  [],
  "SELECT NULL::int[] IS NULL AS is_null, '{}'::int[] IS NULL AS empty_is_null",
);
parity("cardinality of null array", [], "SELECT cardinality(NULL::int[]) AS n");
parity("subscript on null array", [], "SELECT (NULL::int[])[1] AS v");
parity("array element type coercion in constructor", [], "SELECT ARRAY[1, 2.5] AS a");
parity(
  "array stored and read back",
  ["CREATE TABLE t (a int[])", "INSERT INTO t VALUES ('{1,2,3}'), (ARRAY[4, 5])"],
  "SELECT a FROM t ORDER BY a",
);
parity(
  "array update element via function",
  ["CREATE TABLE t (id int, a int[])", "INSERT INTO t VALUES (1, ARRAY[1, 2, 3])"],
  "SELECT array_replace(a, 2, 99) AS a FROM t",
);
parity("concat one-dim onto two-dim", [], "SELECT '{{1,2}}'::int[] || ARRAY[3, 4] AS a");
parity(
  "array distinct in aggregate",
  [],
  "SELECT array_agg(DISTINCT v ORDER BY v) AS a FROM unnest(ARRAY[2, 1, 2, 3]) u(v)",
);
parity(
  "array in group by key",
  ["CREATE TABLE t (a int[], n int)", "INSERT INTO t VALUES (ARRAY[1], 10), (ARRAY[1], 20), (ARRAY[2], 5)"],
  "SELECT a, sum(n) AS s FROM t GROUP BY a ORDER BY a",
);
parity(
  "array in distinct",
  ["CREATE TABLE t (a int[])", "INSERT INTO t VALUES (ARRAY[1]), (ARRAY[1]), (ARRAY[2])"],
  "SELECT DISTINCT a FROM t ORDER BY a",
);

// errors
queryErrorParity("multidimensional arrays must match", [], "SELECT ARRAY[ARRAY[1, 2], ARRAY[3]] AS a", undefined);
queryErrorParity("invalid array literal", [], "SELECT '{1,2'::int[] AS a", "invalid_text_representation");
queryErrorParity(
  "invalid element in int array literal",
  [],
  "SELECT '{1,x}'::int[] AS a",
  "invalid_text_representation",
);
queryErrorParity(
  "cannot compare arrays of different element types",
  [],
  "SELECT ARRAY[1] = ARRAY['a', 'b'] AS v",
  undefined,
);
