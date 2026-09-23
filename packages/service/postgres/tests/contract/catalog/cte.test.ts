import { CTE_SECTION } from "../../../compat/sections/cte.ts";
import { runCatalog } from "./run.ts";

const T = ["CREATE TABLE t (id int, v int)", "INSERT INTO t VALUES (1, 10), (2, 20), (3, 30)"];

const EMP = [
  "CREATE TABLE emp (id int, mgr int, name text)",
  "INSERT INTO emp VALUES (1, NULL, 'root'), (2, 1, 'ann'), (3, 1, 'bob'), (4, 2, 'cat'), (5, 4, 'dan')",
];

runCatalog(CTE_SECTION, [
  {
    id: "CTE-basic-01",
    kind: "parity",
    setup: T,
    sql: "WITH s AS (SELECT id, v FROM t WHERE v > 10) SELECT id FROM s ORDER BY id",
  },
  {
    id: "CTE-cols-01",
    kind: "parity",
    setup: T,
    sql: "WITH s(a, b) AS (SELECT id, v FROM t) SELECT a FROM s WHERE b >= 20 ORDER BY a",
  },
  {
    id: "CTE-multi-01",
    kind: "parity",
    setup: T,
    sql: "WITH lo AS (SELECT v FROM t WHERE v < 25), hi AS (SELECT v FROM t WHERE v >= 25) SELECT (SELECT sum(v) FROM lo) AS lo_sum, (SELECT sum(v) FROM hi) AS hi_sum",
  },
  {
    id: "CTE-chain-01",
    kind: "parity",
    setup: T,
    sql: "WITH base AS (SELECT id, v FROM t), doubled AS (SELECT id, v * 2 AS v2 FROM base) SELECT id, v2 FROM doubled ORDER BY id",
  },
  {
    id: "CTE-ref-01",
    kind: "parity",
    setup: T,
    sql: "WITH s AS (SELECT id, v FROM t) SELECT a.id, a.v + b.v AS pair FROM s a JOIN s b ON b.id = a.id + 1 ORDER BY a.id",
  },
  {
    id: "CTE-shadow-01",
    kind: "parity",
    setup: T,
    sql: "WITH t AS (SELECT 99 AS id) SELECT id FROM t",
  },
  {
    id: "CTE-mat-01",
    kind: "parity",
    setup: T,
    sql: "WITH s AS MATERIALIZED (SELECT id, v FROM t WHERE v > 10) SELECT id FROM s ORDER BY id",
  },
  {
    id: "CTE-mat-02",
    kind: "parity",
    setup: T,
    sql: "WITH s AS NOT MATERIALIZED (SELECT id, v FROM t) SELECT id FROM s WHERE v = 20",
  },
  {
    id: "CTE-nest-01",
    kind: "parity",
    setup: T,
    sql: "WITH s AS (SELECT v FROM t) SELECT id FROM t WHERE v > (SELECT avg(v) FROM s) ORDER BY id",
  },
  {
    id: "CTE-agg-01",
    kind: "parity",
    setup: T,
    sql: "WITH s AS (SELECT id % 2 AS m, v FROM t) SELECT m, count(*) AS c, sum(v) AS total FROM s GROUP BY m ORDER BY m",
  },
  {
    id: "CTE-set-01",
    kind: "parity",
    setup: T,
    sql: "WITH lo AS (SELECT v FROM t WHERE v < 25), hi AS (SELECT v FROM t WHERE v >= 25) SELECT v FROM lo UNION ALL SELECT v FROM hi ORDER BY v",
  },
  {
    id: "CTE-err-01",
    kind: "error",
    setup: T,
    sql: "WITH a AS (SELECT * FROM b), b AS (SELECT 1 AS x) SELECT * FROM a",
    query: true,
    messageTier: "A",
  },
  {
    id: "CTE-err-02",
    kind: "error",
    setup: T,
    sql: "WITH s AS (SELECT id FROM s) SELECT * FROM s",
    query: true,
    messageTier: "A",
  },
  {
    id: "CTE-err-03",
    kind: "error",
    setup: T,
    sql: "WITH s(a, b, c) AS (SELECT id, v FROM t) SELECT * FROM s",
    query: true,
    messageTier: "A",
  },
  {
    id: "CTE-rec-01",
    kind: "parity",
    sql: "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 5) SELECT n FROM c ORDER BY n",
  },
  {
    id: "CTE-rec-02",
    kind: "parity",
    setup: ["CREATE TABLE edges (src int, dst int)", "INSERT INTO edges VALUES (1, 2), (2, 3), (3, 1), (3, 4)"],
    sql: "WITH RECURSIVE reach(node) AS (SELECT 1 UNION SELECT e.dst FROM edges e JOIN reach r ON e.src = r.node) SELECT node FROM reach ORDER BY node",
  },
  {
    id: "CTE-rec-03",
    kind: "parity",
    setup: EMP,
    sql: "WITH RECURSIVE sub(id, depth) AS (SELECT id, 0 FROM emp WHERE mgr IS NULL UNION ALL SELECT e.id, s.depth + 1 FROM emp e JOIN sub s ON e.mgr = s.id) SELECT id, depth FROM sub ORDER BY depth, id",
  },
  {
    id: "CTE-rec-04",
    kind: "parity",
    setup: EMP,
    sql: "WITH RECURSIVE p(id, path) AS (SELECT id, name FROM emp WHERE mgr IS NULL UNION ALL SELECT e.id, p.path || '>' || e.name FROM emp e JOIN p ON e.mgr = p.id) SELECT path FROM p ORDER BY path",
  },
  {
    id: "CTE-rec-05",
    kind: "parity",
    sql: "WITH RECURSIVE c(n) AS (SELECT 3 UNION ALL SELECT n * 2 FROM c WHERE n < 100) SELECT n FROM c ORDER BY n",
  },
  {
    id: "CTE-rec-06",
    kind: "parity",
    sql: "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 100) SELECT n FROM c LIMIT 5",
  },
  {
    id: "CTE-rec-07",
    kind: "parity",
    sql: "WITH RECURSIVE fib(a, b) AS (SELECT 0, 1 UNION ALL SELECT b, a + b FROM fib WHERE a < 50) SELECT a FROM fib ORDER BY a",
  },
  {
    id: "CTE-dml-01",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int)"],
    steps: [
      { sql: "WITH ins AS (INSERT INTO t VALUES (1), (2) RETURNING id) SELECT id FROM ins ORDER BY id", query: true },
      { sql: "SELECT id FROM t ORDER BY id", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "CTE-dml-02",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int, v int)", "INSERT INTO t VALUES (1, 10), (2, 20)"],
    steps: [
      {
        sql: "WITH upd AS (UPDATE t SET v = v + 1 WHERE id = 1 RETURNING id, v) SELECT id, v FROM upd",
        query: true,
      },
      { sql: "SELECT id, v FROM t ORDER BY id", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "CTE-dml-03",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int, v int)", "INSERT INTO t VALUES (1, 10), (2, 20), (3, 30)"],
    steps: [
      { sql: "WITH del AS (DELETE FROM t WHERE v > 15 RETURNING id) SELECT id FROM del ORDER BY id", query: true },
      { sql: "SELECT id FROM t ORDER BY id", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "CTE-dml-04",
    kind: "sequence",
    setup: ["CREATE TABLE src (id int)", "CREATE TABLE dst (id int)", "INSERT INTO src VALUES (1), (2), (3)"],
    steps: [
      { sql: "WITH moved AS (DELETE FROM src RETURNING id) INSERT INTO dst SELECT id FROM moved" },
      { sql: "SELECT id FROM dst ORDER BY id", query: true },
      { sql: "SELECT count(*) AS remaining FROM src", query: true },
    ],
    compareFinalState: true,
  },
]);
