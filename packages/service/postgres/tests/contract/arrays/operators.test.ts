import { parity } from "../helpers.ts";

// containment and overlap
parity("contains operator", [], "SELECT ARRAY[1, 2, 3] @> ARRAY[2] AS a, ARRAY[1, 2] @> ARRAY[3] AS b");
parity("contained by operator", [], "SELECT ARRAY[2] <@ ARRAY[1, 2, 3] AS a, ARRAY[9] <@ ARRAY[1, 2] AS b");
parity("contains duplicates ignored", [], "SELECT ARRAY[1, 2] @> ARRAY[2, 2, 2] AS v");
parity(
  "contains empty array always true",
  [],
  "SELECT ARRAY[1] @> ARRAY[]::int[] AS a, ARRAY[]::int[] @> ARRAY[]::int[] AS b",
);
parity("overlap operator", [], "SELECT ARRAY[1, 2] && ARRAY[2, 3] AS a, ARRAY[1, 2] && ARRAY[3, 4] AS b");
parity("overlap with empty is false", [], "SELECT ARRAY[1] && ARRAY[]::int[] AS v");
parity(
  "containment in where clause",
  [
    "CREATE TABLE t (id int, tags text[])",
    "INSERT INTO t VALUES (1, ARRAY['red', 'blue']), (2, ARRAY['green']), (3, ARRAY['blue', 'green'])",
  ],
  "SELECT id FROM t WHERE tags @> ARRAY['blue'] ORDER BY id",
);
parity(
  "overlap in where clause",
  [
    "CREATE TABLE t (id int, tags text[])",
    "INSERT INTO t VALUES (1, ARRAY['red']), (2, ARRAY['green', 'red']), (3, ARRAY['blue'])",
  ],
  "SELECT id FROM t WHERE tags && ARRAY['red', 'blue'] ORDER BY id",
);

// comparisons
parity("array equality", [], "SELECT ARRAY[1, 2] = ARRAY[1, 2] AS a, ARRAY[1, 2] = ARRAY[2, 1] AS b");
parity("array inequality", [], "SELECT ARRAY[1, 2] <> ARRAY[1, 3] AS v");
parity("array less than element-wise", [], "SELECT ARRAY[1, 2] < ARRAY[1, 3] AS a, ARRAY[2] < ARRAY[1, 9] AS b");
parity("array shorter prefix is less", [], "SELECT ARRAY[1, 2] < ARRAY[1, 2, 3] AS v");
parity("array greater than", [], "SELECT ARRAY[2, 1] > ARRAY[1, 9] AS v");
parity("array comparison with nulls inside", [], "SELECT ARRAY[1, NULL] = ARRAY[1, NULL] AS v");
parity(
  "order by array column",
  ["CREATE TABLE t (a int[])", "INSERT INTO t VALUES (ARRAY[2, 1]), (ARRAY[1, 9]), (ARRAY[1, 2])"],
  "SELECT a FROM t ORDER BY a",
);

// unnest round-trips
parity(
  "unnest then array_agg round trip",
  [],
  "SELECT array_agg(v ORDER BY v) AS a FROM unnest(ARRAY[3, 1, 2]) AS u(v)",
);
parity(
  "array column round trip through unnest",
  ["CREATE TABLE t (id int, xs int[])", "INSERT INTO t VALUES (1, ARRAY[3, 1]), (2, ARRAY[2])"],
  "SELECT id, array_agg(v ORDER BY v) AS sorted FROM (SELECT id, unnest(xs) AS v FROM t) s GROUP BY id ORDER BY id",
);
parity("any over array", [], "SELECT 2 = ANY (ARRAY[1, 2]) AS a, 9 = ANY (ARRAY[1, 2]) AS b");
parity("all over array", [], "SELECT 1 < ALL (ARRAY[2, 3]) AS a, 1 < ALL (ARRAY[0, 3]) AS b");
