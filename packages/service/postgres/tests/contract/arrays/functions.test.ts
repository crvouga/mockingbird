import { parity } from "../helpers.ts";

parity("array_length", [], "SELECT array_length(ARRAY[1, 2, 3], 1) AS n");
parity("array_length empty array is null", [], "SELECT array_length(ARRAY[]::int[], 1) AS n");
parity(
  "array_length second dimension",
  [],
  "SELECT array_length('{{1,2,3},{4,5,6}}'::int[], 1) AS d1, array_length('{{1,2,3},{4,5,6}}'::int[], 2) AS d2",
);
parity("cardinality", [], "SELECT cardinality(ARRAY[1, 2, 3]) AS n, cardinality(ARRAY[]::int[]) AS z");
parity("cardinality multi-dim counts all", [], "SELECT cardinality('{{1,2},{3,4}}'::int[]) AS n");
parity("array_append", [], "SELECT array_append(ARRAY[1, 2], 3) AS a");
parity("array_append to empty", [], "SELECT array_append(ARRAY[]::int[], 1) AS a");
parity("array_append null element", [], "SELECT array_append(ARRAY[1], NULL) AS a");
parity("array_prepend", [], "SELECT array_prepend(0, ARRAY[1, 2]) AS a");
parity("array_cat", [], "SELECT array_cat(ARRAY[1, 2], ARRAY[3, 4]) AS a");
parity("array_cat with empty", [], "SELECT array_cat(ARRAY[1], ARRAY[]::int[]) AS a");
parity("array concat operator", [], "SELECT ARRAY[1, 2] || ARRAY[3] AS a");
parity("element concat operators", [], "SELECT 0 || ARRAY[1, 2] AS pre, ARRAY[1, 2] || 3 AS post");
parity("array_position", [], "SELECT array_position(ARRAY['a', 'b', 'c'], 'b') AS p");
parity("array_position not found is null", [], "SELECT array_position(ARRAY[1, 2], 9) AS p");
parity("array_position with start", [], "SELECT array_position(ARRAY[1, 2, 1, 2], 2, 3) AS p");
parity("array_position of null", [], "SELECT array_position(ARRAY[1, NULL, 3], NULL) AS p");
parity("array_positions", [], "SELECT array_positions(ARRAY['a', 'b', 'a'], 'a') AS p");
parity("array_positions none found is empty", [], "SELECT array_positions(ARRAY[1, 2], 9) AS p");
parity("array_remove", [], "SELECT array_remove(ARRAY[1, 2, 1, 3], 1) AS a");
parity("array_remove nulls", [], "SELECT array_remove(ARRAY[1, NULL, 2, NULL], NULL) AS a");
parity("array_replace", [], "SELECT array_replace(ARRAY[1, 2, 1], 1, 9) AS a");
parity("array_fill one dim", [], "SELECT array_fill(7, ARRAY[3]) AS a");
parity("array_fill two dims", [], "SELECT array_fill(0, ARRAY[2, 3]) AS a");
parity("array_dims", [], "SELECT array_dims(ARRAY[1, 2, 3]) AS d");
parity("array_dims two dim", [], "SELECT array_dims('{{1,2},{3,4}}'::int[]) AS d");
parity(
  "array_upper and array_lower",
  [],
  "SELECT array_lower(ARRAY[5, 6, 7], 1) AS lo, array_upper(ARRAY[5, 6, 7], 1) AS hi",
);
parity("array_to_string", [], "SELECT array_to_string(ARRAY[1, 2, 3], '-') AS s");
parity("array_to_string with null placeholder", [], "SELECT array_to_string(ARRAY['a', NULL, 'b'], ',', '?') AS s");
parity(
  "array_to_string skips nulls without placeholder",
  [],
  "SELECT array_to_string(ARRAY['a', NULL, 'b'], ',') AS s",
);
parity("string_to_array", [], "SELECT string_to_array('a,b,c', ',') AS a");
parity("string_to_array with null token", [], "SELECT string_to_array('a,X,b', ',', 'X') AS a");
parity("string_to_array round trip", [], "SELECT array_to_string(string_to_array('x|y|z', '|'), '|') AS s");
