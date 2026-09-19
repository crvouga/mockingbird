import { ARR_SECTION } from "../../../compat/sections/arr.ts";
import { runCatalog } from "./run.ts";

runCatalog(ARR_SECTION, [
  { id: "ARR-lit-01", kind: "parity", sql: "SELECT ARRAY[1, 2, 3] AS ints, ARRAY['x', 'y'] AS texts" },
  {
    id: "ARR-lit-02",
    kind: "parity",
    sql: `SELECT '{1,2,3}'::int[] AS ints, '{"a b","c"}'::text[] AS quoted`,
  },
  { id: "ARR-lit-03", kind: "parity", sql: "SELECT ARRAY[]::int[] AS ctor, '{}'::text[] AS lit" },
  {
    id: "ARR-lit-04",
    kind: "parity",
    sql: "SELECT ARRAY[1, NULL, 3] AS a, (ARRAY['a b', NULL, 'c,d'])::text AS rendered",
  },
  { id: "ARR-lit-05", kind: "parity", sql: "SELECT ARRAY[1 + 1, 2 * 3] AS exprs, ARRAY[1, 2.5] AS coerced" },
  {
    id: "ARR-lit-06",
    kind: "parity",
    sql: "SELECT ARRAY[ARRAY[1, 2], ARRAY[3, 4]] AS ctor, '{{1,2},{3,4}}'::int[] AS lit",
  },
  {
    id: "ARR-lit-07",
    kind: "parity",
    setup: ["CREATE TABLE t (v int)", "INSERT INTO t VALUES (3), (1), (2)"],
    sql: "SELECT ARRAY(SELECT v FROM t ORDER BY v) AS a",
  },
  {
    id: "ARR-sub-01",
    kind: "parity",
    sql: "SELECT (ARRAY[10, 20, 30])[1] AS first, (ARRAY[10, 20, 30])[3] AS last",
  },
  {
    id: "ARR-sub-02",
    kind: "parity",
    sql:
      "SELECT (ARRAY[1, 2])[5] AS beyond, (ARRAY[1, 2])[0] AS zero, (ARRAY[1, 2])[-1] AS neg, " +
      "(NULL::int[])[1] AS on_null",
  },
  {
    id: "ARR-sub-03",
    kind: "parity",
    setup: ["CREATE TABLE t (a int[])", "INSERT INTO t VALUES (ARRAY[7, 8, 9])"],
    sql: "SELECT a[2] AS col, a[1 + 1] AS expr FROM t",
  },
  {
    id: "ARR-sub-04",
    kind: "parity",
    sql: "SELECT ('{{1,2},{3,4}}'::int[])[2][1] AS full, (('{{1,2},{3,4}}'::int[])[1]) IS NULL AS partial",
  },
  { id: "ARR-slice-01", kind: "parity", sql: "SELECT (ARRAY[1, 2, 3, 4, 5])[2:4] AS s" },
  {
    id: "ARR-slice-02",
    kind: "parity",
    sql: "SELECT (ARRAY[1, 2, 3, 4])[:2] AS head, (ARRAY[1, 2, 3, 4])[3:] AS tail",
  },
  {
    id: "ARR-slice-03",
    kind: "parity",
    sql: "SELECT (ARRAY[1, 2, 3])[2:99] AS clamped, (ARRAY[1, 2, 3])[5:9] AS empty",
  },
  { id: "ARR-slice-04", kind: "parity", sql: "SELECT ('{{1,2},{3,4},{5,6}}'::int[])[1:2][1:1] AS s" },
  {
    id: "ARR-meta-01",
    kind: "parity",
    sql:
      "SELECT array_length(ARRAY[1, 2, 3], 1) AS len, array_length(ARRAY[]::int[], 1) AS len_empty, " +
      "cardinality(ARRAY[1, 2, 3]) AS card, cardinality('{{1,2},{3,4}}'::int[]) AS card_2d, cardinality(NULL::int[]) AS card_null",
  },
  {
    id: "ARR-meta-02",
    kind: "parity",
    sql:
      "SELECT array_dims('{{1,2},{3,4}}'::int[]) AS dims, array_ndims('{{1,2},{3,4}}'::int[]) AS nd, " +
      "array_lower(ARRAY[5, 6, 7], 1) AS lo, array_upper(ARRAY[5, 6, 7], 1) AS hi",
  },
  {
    id: "ARR-srf-01",
    kind: "parity",
    sql: "SELECT v FROM unnest(ARRAY[3, 1, 2]) AS u(v) ORDER BY v",
  },
  { id: "ARR-srf-02", kind: "parity", sql: "SELECT unnest(ARRAY[1, 2, 3]) AS v" },
  {
    id: "ARR-srf-03",
    kind: "parity",
    sql: "SELECT * FROM unnest(ARRAY['a', 'b']) WITH ORDINALITY AS t(v, i)",
  },
  {
    id: "ARR-srf-04",
    kind: "parity",
    sql: "SELECT * FROM unnest(ARRAY[1, 2], ARRAY['a', 'b', 'c']) AS t(n, s)",
  },
  {
    id: "ARR-srf-05",
    kind: "parity",
    sql:
      "SELECT generate_subscripts(ARRAY[10, 20, 30], 1) AS fwd, " +
      "generate_subscripts(ARRAY[10, 20, 30], 1, true) AS rev",
  },
  {
    id: "ARR-agg-01",
    kind: "parity",
    setup: ["CREATE TABLE t (v int)", "INSERT INTO t VALUES (2), (1), (2), (3)"],
    sql: "SELECT array_agg(v ORDER BY v DESC) AS ordered, array_agg(DISTINCT v ORDER BY v) AS distinct_asc FROM t",
  },
  {
    id: "ARR-agg-02",
    kind: "parity",
    setup: ["CREATE TABLE t (id int, xs int[])", "INSERT INTO t VALUES (1, ARRAY[3, 1]), (2, ARRAY[2])"],
    sql: "SELECT id, array_agg(v ORDER BY v) AS sorted FROM (SELECT id, unnest(xs) AS v FROM t) s GROUP BY id ORDER BY id",
  },
  {
    id: "ARR-op-01",
    kind: "parity",
    sql:
      "SELECT ARRAY[1, 2] || ARRAY[3] AS aa, 0 || ARRAY[1, 2] AS pre, ARRAY[1, 2] || 3 AS post, " +
      "'{{1,2}}'::int[] || ARRAY[3, 4] AS mixed_dim, ARRAY[1, 2] || NULL::int[] AS with_null",
  },
  {
    id: "ARR-op-02",
    kind: "parity",
    sql:
      "SELECT ARRAY[1, 2, 3] @> ARRAY[2] AS has, ARRAY[1, 2] @> ARRAY[3] AS hasnt, " +
      "ARRAY[1, 2] @> ARRAY[2, 2, 2] AS dups, ARRAY[1] @> ARRAY[]::int[] AS empty, ARRAY[2] <@ ARRAY[1, 2, 3] AS inv",
  },
  {
    id: "ARR-op-03",
    kind: "parity",
    sql:
      "SELECT ARRAY[1, 2] && ARRAY[2, 3] AS yes, ARRAY[1, 2] && ARRAY[3, 4] AS no, " +
      "ARRAY[1] && ARRAY[]::int[] AS empty",
  },
  {
    id: "ARR-op-04",
    kind: "parity",
    sql:
      "SELECT ARRAY[1, 2] = ARRAY[1, 2] AS eq, ARRAY[1, 2] = ARRAY[2, 1] AS ne_order, ARRAY[1, 2] <> ARRAY[1, 3] AS ne, " +
      "ARRAY[1, 2] < ARRAY[1, 3] AS lt, ARRAY[1, 2] < ARRAY[1, 2, 3] AS prefix, ARRAY[2, 1] > ARRAY[1, 9] AS gt",
  },
  { id: "ARR-op-05", kind: "parity", sql: "SELECT ARRAY[1, NULL] = ARRAY[1, NULL] AS v" },
  {
    id: "ARR-fn-01",
    kind: "parity",
    sql:
      "SELECT array_append(ARRAY[1, 2], 3) AS app, array_append(ARRAY[1], NULL) AS app_null, " +
      "array_prepend(0, ARRAY[1, 2]) AS pre, array_cat(ARRAY[1, 2], ARRAY[3, 4]) AS cat",
  },
  {
    id: "ARR-fn-02",
    kind: "parity",
    sql:
      "SELECT array_remove(ARRAY[1, 2, 1, 3], 1) AS rm, array_remove(ARRAY[1, NULL, 2, NULL], NULL) AS rm_null, " +
      "array_replace(ARRAY[1, 2, 1], 1, 9) AS repl",
  },
  {
    id: "ARR-fn-03",
    kind: "parity",
    sql:
      "SELECT array_position(ARRAY['a', 'b', 'c'], 'b') AS pos, array_position(ARRAY[1, 2], 9) AS missing, " +
      "array_position(ARRAY[1, 2, 1, 2], 2, 3) AS from_start, array_position(ARRAY[1, NULL, 3], NULL) AS null_pos, " +
      "array_positions(ARRAY['a', 'b', 'a'], 'a') AS all_pos, array_positions(ARRAY[1, 2], 9) AS none",
  },
  {
    id: "ARR-fn-04",
    kind: "parity",
    sql:
      "SELECT array_to_string(ARRAY[1, 2, 3], '-') AS basic, array_to_string(ARRAY['a', NULL, 'b'], ',', '?') AS placeholder, " +
      "array_to_string(ARRAY['a', NULL, 'b'], ',') AS skipped",
  },
  {
    id: "ARR-fn-05",
    kind: "parity",
    sql:
      "SELECT string_to_array('a,b,c', ',') AS basic, string_to_array('a,X,b', ',', 'X') AS with_null, " +
      "array_to_string(string_to_array('x|y|z', '|'), '|') AS round_trip",
  },
  {
    id: "ARR-fn-06",
    kind: "parity",
    sql: "SELECT array_fill(7, ARRAY[3]) AS one_d, array_fill(0, ARRAY[2, 3]) AS two_d, trim_array(ARRAY[1, 2, 3, 4], 2) AS trimmed",
  },
  {
    id: "ARR-any-01",
    kind: "parity",
    sql:
      "SELECT 2 = ANY (ARRAY[1, 2]) AS yes, 9 = ANY (ARRAY[1, 2]) AS no, 'b' = ANY (ARRAY['a', 'b']) AS txt, " +
      "2 = ANY ('{1,2,3}'::int[]) AS from_lit",
  },
  {
    id: "ARR-any-02",
    kind: "parity",
    sql:
      "SELECT 1 < ALL (ARRAY[2, 3]) AS lt_all, 1 < ALL (ARRAY[0, 3]) AS not_all, " +
      "3 > ANY (ARRAY[1, 2]) AS gt_any, 3 > ALL (ARRAY[1, 2]) AS gt_all, 'z' <> ALL (ARRAY['a', 'b']) AS ne_all",
  },
  {
    id: "ARR-where-01",
    kind: "parity",
    setup: [
      "CREATE TABLE t (id int, tags text[])",
      "INSERT INTO t VALUES (1, ARRAY['red', 'blue']), (2, ARRAY['green']), (3, ARRAY['blue', 'green'])",
    ],
    sql: "SELECT id FROM t WHERE tags @> ARRAY['blue'] OR tags && ARRAY['green'] ORDER BY id",
  },
  {
    id: "ARR-store-01",
    kind: "parity",
    setup: ["CREATE TABLE t (a int[], n int)", "INSERT INTO t VALUES (ARRAY[1], 10), (ARRAY[1], 20), (ARRAY[2], 5)"],
    sql: "SELECT a, sum(n) AS s, (SELECT count(*) FROM (SELECT DISTINCT a FROM t) d) AS groups FROM t GROUP BY a ORDER BY a",
  },
  {
    id: "ARR-err-01",
    kind: "error",
    sql: "SELECT '{1,2'::int[]",
    query: true,
    messageTier: "A",
  },
  {
    id: "ARR-err-02",
    kind: "error",
    sql: "SELECT ARRAY[ARRAY[1, 2], ARRAY[3]]",
    query: true,
    messageTier: "A",
  },
]);
