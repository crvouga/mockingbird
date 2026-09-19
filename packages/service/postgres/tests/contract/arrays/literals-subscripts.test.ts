import { parity } from "../helpers.ts";

// literals and constructors
parity("array constructor ints", [], "SELECT ARRAY[1, 2, 3] AS a");
parity("array constructor text", [], "SELECT ARRAY['x', 'y'] AS a");
parity("array literal cast", [], "SELECT '{1,2,3}'::int[] AS a");
parity("array text literal with quotes", [], 'SELECT \'{"a b","c"}\'::text[] AS a');
parity("empty array constructor typed", [], "SELECT ARRAY[]::int[] AS a");
parity("empty array literal", [], "SELECT '{}'::text[] AS a");
parity("array with nulls", [], "SELECT ARRAY[1, NULL, 3] AS a");
parity("array of expressions", [], "SELECT ARRAY[1 + 1, 2 * 3] AS a");
parity("nested array constructor two-dim", [], "SELECT ARRAY[ARRAY[1, 2], ARRAY[3, 4]] AS a");
parity("two-dim array literal", [], "SELECT '{{1,2},{3,4}}'::int[] AS a");
parity(
  "array constructor from subquery",
  ["CREATE TABLE t (v int)", "INSERT INTO t VALUES (3), (1), (2)"],
  "SELECT ARRAY(SELECT v FROM t ORDER BY v) AS a",
);

// subscripts
parity("subscript one-based", [], "SELECT (ARRAY[10, 20, 30])[1] AS first, (ARRAY[10, 20, 30])[3] AS last");
parity("subscript out of range returns null", [], "SELECT (ARRAY[1, 2])[5] AS beyond, (ARRAY[1, 2])[0] AS zero");
parity("negative subscript returns null", [], "SELECT (ARRAY[1, 2])[-1] AS v");
parity(
  "subscript on column",
  ["CREATE TABLE t (a int[])", "INSERT INTO t VALUES (ARRAY[7, 8, 9])"],
  "SELECT a[2] AS v FROM t",
);
parity("subscript expression index", [], "SELECT (ARRAY[10, 20, 30])[1 + 1] AS v");
parity("multi-dim subscript", [], "SELECT ('{{1,2},{3,4}}'::int[])[2][1] AS v");
parity("multi-dim partial subscript is null", [], "SELECT (('{{1,2},{3,4}}'::int[])[1]) IS NULL AS v");

// slices
parity("slice basic", [], "SELECT (ARRAY[1, 2, 3, 4, 5])[2:4] AS s");
parity("slice open lower bound", [], "SELECT (ARRAY[1, 2, 3, 4])[:2] AS s");
parity("slice open upper bound", [], "SELECT (ARRAY[1, 2, 3, 4])[3:] AS s");
parity("slice beyond bounds clamps", [], "SELECT (ARRAY[1, 2, 3])[2:99] AS s");
parity("slice fully out of range is empty", [], "SELECT (ARRAY[1, 2, 3])[5:9] AS s");
parity("multi-dim slice", [], "SELECT ('{{1,2},{3,4},{5,6}}'::int[])[1:2][1:1] AS s");
