import { SEL_SECTION } from "../../../compat/sections/sel.ts";
import { runCatalog } from "./run.ts";

const T = [
  "CREATE TABLE t (id int, grp text, v int)",
  "INSERT INTO t VALUES (1, 'a', 10), (2, 'a', 20), (3, 'b', 30), (4, 'b', NULL), (5, NULL, 50), (6, NULL, 60)",
];

const O = [
  "CREATE TABLE o (cust text, cat text, amt int)",
  "INSERT INTO o VALUES ('ann', 'food', 5), ('ann', 'food', 9), ('ann', 'toys', 3), ('bob', 'food', 7), ('bob', 'toys', 2), ('bob', 'toys', 8)",
];

runCatalog(SEL_SECTION, [
  { id: "SEL-proj-01", kind: "parity", setup: T, sql: "SELECT * FROM t ORDER BY id" },
  { id: "SEL-proj-02", kind: "parity", setup: T, sql: "SELECT t.* FROM t ORDER BY t.id" },
  { id: "SEL-alias-01", kind: "parity", setup: T, sql: "SELECT id, v AS score FROM t ORDER BY score NULLS LAST, id" },
  {
    id: "SEL-alias-02",
    kind: "parity",
    setup: T,
    sql: "SELECT grp AS g, count(*) AS c FROM t GROUP BY g ORDER BY g NULLS LAST",
  },
  {
    id: "SEL-alias-03",
    kind: "error",
    setup: T,
    sql: "SELECT v AS score FROM t WHERE score > 10",
    query: true,
    messageTier: "A",
  },
  { id: "SEL-dist-01", kind: "parity", setup: T, sql: "SELECT DISTINCT grp FROM t ORDER BY grp NULLS LAST" },
  {
    id: "SEL-diston-01",
    kind: "parity",
    setup: O,
    sql: "SELECT DISTINCT ON (cust) cust, cat, amt FROM o ORDER BY cust, amt DESC",
  },
  {
    id: "SEL-diston-02",
    kind: "parity",
    setup: O,
    sql: "SELECT DISTINCT ON (cust, cat) cust, cat, amt FROM o ORDER BY cust, cat, amt DESC",
  },
  {
    id: "SEL-order-01",
    kind: "parity",
    setup: T,
    sql: "SELECT id, grp, v FROM t ORDER BY grp DESC NULLS LAST, id ASC",
  },
  { id: "SEL-order-02", kind: "parity", setup: T, sql: "SELECT id, v FROM t ORDER BY v NULLS FIRST, id" },
  { id: "SEL-order-03", kind: "parity", setup: T, sql: "SELECT id FROM t ORDER BY id % 3, id" },
  { id: "SEL-order-04", kind: "parity", setup: T, sql: "SELECT grp, id FROM t ORDER BY 1 NULLS LAST, 2" },
  {
    id: "SEL-order-05",
    kind: "error",
    setup: T,
    sql: "SELECT id FROM t ORDER BY 5",
    query: true,
    messageTier: "A",
  },
  { id: "SEL-limit-01", kind: "parity", setup: T, sql: "SELECT id FROM t ORDER BY id LIMIT 3 OFFSET 2" },
  {
    id: "SEL-fetch-01",
    kind: "parity",
    setup: T,
    sql: "SELECT id FROM t ORDER BY id OFFSET 2 ROWS FETCH NEXT 2 ROWS ONLY",
  },
  {
    id: "SEL-fetch-02",
    kind: "parity",
    sql: "SELECT v FROM (VALUES (10), (20), (20), (30)) s(v) ORDER BY v FETCH FIRST 2 ROWS WITH TIES",
  },
  {
    id: "SEL-set-01",
    kind: "parity",
    sql: "SELECT v FROM (VALUES (1), (2), (2)) a(v) UNION SELECT v FROM (VALUES (2), (3)) b(v) ORDER BY v",
  },
  {
    id: "SEL-set-02",
    kind: "parity",
    sql: "SELECT v FROM (VALUES (1), (2), (2)) a(v) UNION ALL SELECT v FROM (VALUES (2), (3)) b(v) ORDER BY v",
  },
  {
    id: "SEL-set-03",
    kind: "parity",
    sql: "SELECT v FROM (VALUES (1), (2), (3)) a(v) INTERSECT SELECT v FROM (VALUES (2), (3), (4)) b(v) ORDER BY v",
  },
  {
    id: "SEL-set-04",
    kind: "parity",
    sql: "SELECT v FROM (VALUES (1), (2), (3)) a(v) EXCEPT SELECT v FROM (VALUES (2), (4)) b(v) ORDER BY v",
  },
  { id: "SEL-set-05", kind: "parity", typed: true, sql: "SELECT 1 AS v UNION ALL SELECT 2.5 ORDER BY v" },
  {
    id: "SEL-set-06",
    kind: "parity",
    sql: "SELECT v FROM (VALUES (5), (1)) a(v) UNION ALL SELECT v FROM (VALUES (4), (2)) b(v) ORDER BY v LIMIT 3",
  },
  {
    id: "SEL-set-07",
    kind: "error",
    sql: "SELECT 1, 2 UNION SELECT 3",
    query: true,
    messageTier: "A",
  },
  {
    id: "SEL-values-01",
    kind: "parity",
    sql: "SELECT n, s FROM (VALUES (2, 'two'), (1, 'one')) AS v(n, s) ORDER BY n",
  },
  {
    id: "SEL-group-01",
    kind: "parity",
    setup: T,
    sql: "SELECT id % 2 AS m, count(*) AS c FROM t GROUP BY id % 2 ORDER BY m",
  },
  {
    id: "SEL-group-02",
    kind: "parity",
    setup: T,
    sql: "SELECT grp, count(*) AS c, sum(v) AS s FROM t GROUP BY grp HAVING sum(v) > 50 ORDER BY grp NULLS LAST",
  },
  {
    id: "SEL-group-03",
    kind: "parity",
    setup: T,
    sql: "SELECT grp, count(*) AS c, sum(v) AS s FROM t GROUP BY GROUPING SETS ((grp), ()) ORDER BY grp NULLS LAST, c",
  },
  {
    id: "SEL-group-04",
    kind: "parity",
    setup: O,
    sql: "SELECT cust, cat, sum(amt) AS s FROM o GROUP BY ROLLUP (cust, cat) ORDER BY cust NULLS LAST, cat NULLS LAST",
  },
  {
    id: "SEL-group-05",
    kind: "parity",
    setup: O,
    sql: "SELECT cust, cat, grouping(cust, cat) AS g, sum(amt) AS s FROM o GROUP BY CUBE (cust, cat) ORDER BY g, cust NULLS LAST, cat NULLS LAST",
  },
  { id: "SEL-having-01", kind: "parity", setup: T, sql: "SELECT sum(v) AS total FROM t HAVING sum(v) > 100" },
  { id: "SEL-sub-01", kind: "parity", setup: T, sql: "SELECT id, (SELECT max(v) FROM t) AS mx FROM t ORDER BY id" },
  {
    id: "SEL-sub-02",
    kind: "parity",
    setup: T,
    sql: "SELECT id FROM t WHERE grp IN (SELECT grp FROM t WHERE v >= 30) ORDER BY id",
  },
  {
    id: "SEL-sub-03",
    kind: "parity",
    setup: T,
    sql: "SELECT id FROM t WHERE EXISTS (SELECT 1 FROM t t2 WHERE t2.v > t.v) ORDER BY id",
  },
  {
    id: "SEL-sub-04",
    kind: "parity",
    setup: T,
    sql: "SELECT (50 = ANY (SELECT v FROM t WHERE v IS NOT NULL)) AS any_hit, (5 < ALL (SELECT v FROM t WHERE v IS NOT NULL)) AS all_hit",
  },
  {
    id: "SEL-row-01",
    kind: "parity",
    sql: "SELECT (1, 2) < (1, 3) AS lt, (2, 0) < (1, 9) AS ltf, (1, 2) = (1, 2) AS eq, (1, NULL) = (1, 2) AS eqnull",
  },
  { id: "SEL-row-02", kind: "parity", setup: T, sql: "SELECT id FROM t WHERE (grp, v) = ('a', 20) ORDER BY id" },
  {
    id: "SEL-case-01",
    kind: "parity",
    setup: T,
    sql: "SELECT id, CASE WHEN v >= 30 THEN 'high' WHEN v >= 20 THEN 'mid' ELSE 'low' END AS band FROM t ORDER BY id",
  },
  {
    id: "SEL-talias-01",
    kind: "parity",
    setup: T,
    sql: "SELECT a, c FROM t AS r (a, b, c) WHERE b = 'a' ORDER BY a",
  },
  {
    id: "SEL-corr-01",
    kind: "parity",
    setup: T,
    sql: "SELECT id, (SELECT count(*) FROM t t2 WHERE t2.v < t.v) AS below FROM t ORDER BY id",
  },
]);
