import { DML_SECTION } from "../../../compat/sections/dml.ts";
import { runCatalog } from "./run.ts";

const KV = ["CREATE TABLE t (id int, v text)"];
const KV_ROWS = [...KV, "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')"];
const PK = ["CREATE TABLE t (id int PRIMARY KEY, v text)", "INSERT INTO t VALUES (1, 'old')"];

runCatalog(DML_SECTION, [
  {
    id: "DML-ins-01",
    kind: "sequence",
    setup: KV,
    steps: [{ sql: "INSERT INTO t VALUES (1, 'a')" }, { sql: "SELECT id, v FROM t", query: true }],
    compareFinalState: true,
  },
  {
    id: "DML-ins-02",
    kind: "sequence",
    setup: KV,
    steps: [
      { sql: "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')" },
      { sql: "SELECT id, v FROM t ORDER BY id", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "DML-ins-03",
    kind: "sequence",
    setup: [...KV_ROWS, "CREATE TABLE dst (id int, v text)"],
    steps: [
      { sql: "INSERT INTO dst SELECT id, v FROM t WHERE id > 1" },
      { sql: "SELECT id, v FROM dst ORDER BY id", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "DML-ins-04",
    kind: "sequence",
    setup: KV_ROWS,
    steps: [{ sql: "INSERT INTO t SELECT id + 10, v FROM t" }, { sql: "SELECT id, v FROM t ORDER BY id", query: true }],
    compareFinalState: true,
  },
  {
    id: "DML-ins-05",
    kind: "sequence",
    setup: ["CREATE TABLE t (id serial, v text DEFAULT 'dv')"],
    steps: [{ sql: "INSERT INTO t DEFAULT VALUES" }, { sql: "SELECT id, v FROM t", query: true }],
    compareFinalState: true,
  },
  {
    id: "DML-ins-06",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int, v int DEFAULT 7)"],
    steps: [
      { sql: "INSERT INTO t VALUES (1, DEFAULT), (2, 9)" },
      { sql: "SELECT id, v FROM t ORDER BY id", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "DML-ins-07",
    kind: "sequence",
    setup: KV,
    steps: [{ sql: "INSERT INTO t (v, id) VALUES ('z', 42)" }, { sql: "SELECT id, v FROM t", query: true }],
    compareFinalState: true,
  },
  {
    id: "DML-ins-08",
    kind: "exec",
    setup: KV_ROWS,
    sql: "INSERT INTO t SELECT id, v FROM t WHERE false",
  },
  {
    id: "DML-ret-01",
    kind: "sequence",
    setup: KV,
    steps: [{ sql: "INSERT INTO t VALUES (1, 'a'), (2, 'b') RETURNING *", query: true }],
    compareFinalState: true,
  },
  {
    id: "DML-ret-02",
    kind: "sequence",
    setup: KV,
    steps: [{ sql: "INSERT INTO t VALUES (1, 'a') RETURNING id * 10 AS scaled, v || '!' AS loud", query: true }],
    compareFinalState: true,
  },
  {
    id: "DML-ret-03",
    kind: "sequence",
    setup: KV_ROWS,
    steps: [{ sql: "UPDATE t SET v = v || '+' WHERE id >= 2 RETURNING id, v", query: true }],
    compareFinalState: true,
  },
  {
    id: "DML-ret-04",
    kind: "sequence",
    setup: KV_ROWS,
    steps: [{ sql: "DELETE FROM t WHERE id <> 2 RETURNING id, v", query: true }],
    compareFinalState: true,
  },
  {
    id: "DML-upd-01",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int, n int)", "INSERT INTO t VALUES (1, 10), (2, 20)"],
    steps: [{ sql: "UPDATE t SET n = n * 2 + id" }, { sql: "SELECT id, n FROM t ORDER BY id", query: true }],
    compareFinalState: true,
  },
  {
    id: "DML-upd-02",
    kind: "exec",
    setup: KV_ROWS,
    sql: "UPDATE t SET v = 'x' WHERE id >= 2",
  },
  {
    id: "DML-upd-03",
    kind: "exec",
    setup: KV_ROWS,
    sql: "UPDATE t SET v = upper(v)",
  },
  {
    id: "DML-upd-04",
    kind: "sequence",
    setup: [
      "CREATE TABLE t (id int, v text)",
      "INSERT INTO t VALUES (1, 'a'), (2, 'b')",
      "CREATE TABLE s (id int, nv text)",
      "INSERT INTO s VALUES (2, 'patched')",
    ],
    steps: [
      { sql: "UPDATE t SET v = s.nv FROM s WHERE t.id = s.id" },
      { sql: "SELECT id, v FROM t ORDER BY id", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "DML-upd-05",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int, a int, b text)", "INSERT INTO t VALUES (1, 0, ''), (2, 5, 'keep')"],
    steps: [
      { sql: "UPDATE t SET (a, b) = (42, 'row') WHERE id = 1" },
      { sql: "SELECT id, a, b FROM t ORDER BY id", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "DML-upd-06",
    kind: "sequence",
    setup: [
      "CREATE TABLE t (id int, a int, b text)",
      "INSERT INTO t VALUES (1, 0, '')",
      "CREATE TABLE s (x int, y text)",
      "INSERT INTO s VALUES (7, 'sub')",
    ],
    steps: [
      { sql: "UPDATE t SET (a, b) = (SELECT x, y FROM s) WHERE id = 1" },
      { sql: "SELECT id, a, b FROM t", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "DML-upd-07",
    kind: "exec",
    setup: KV_ROWS,
    sql: "UPDATE t SET v = 'never' WHERE id > 100",
  },
  {
    id: "DML-del-01",
    kind: "sequence",
    setup: KV_ROWS,
    steps: [{ sql: "DELETE FROM t WHERE id = 2" }, { sql: "SELECT id, v FROM t ORDER BY id", query: true }],
    compareFinalState: true,
  },
  {
    id: "DML-del-02",
    kind: "exec",
    setup: KV_ROWS,
    sql: "DELETE FROM t",
  },
  {
    id: "DML-del-03",
    kind: "sequence",
    setup: [
      "CREATE TABLE t (id int, v text)",
      "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')",
      "CREATE TABLE kill (id int)",
      "INSERT INTO kill VALUES (1), (3)",
    ],
    steps: [
      { sql: "DELETE FROM t USING kill WHERE t.id = kill.id" },
      { sql: "SELECT id, v FROM t ORDER BY id", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "DML-del-04",
    kind: "exec",
    setup: KV_ROWS,
    sql: "DELETE FROM t WHERE id > 100",
  },
  {
    id: "DML-conf-01",
    kind: "sequence",
    setup: PK,
    steps: [
      { sql: "INSERT INTO t VALUES (1, 'dup') ON CONFLICT DO NOTHING" },
      { sql: "SELECT id, v FROM t ORDER BY id", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "DML-conf-02",
    kind: "sequence",
    setup: PK,
    steps: [
      { sql: "INSERT INTO t VALUES (1, 'dup'), (2, 'new') ON CONFLICT (id) DO NOTHING" },
      { sql: "SELECT id, v FROM t ORDER BY id", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "DML-conf-03",
    kind: "sequence",
    setup: PK,
    steps: [
      { sql: "INSERT INTO t VALUES (1, 'new') ON CONFLICT (id) DO UPDATE SET v = EXCLUDED.v" },
      { sql: "SELECT id, v FROM t ORDER BY id", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "DML-conf-04",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int PRIMARY KEY, n int)", "INSERT INTO t VALUES (1, 100)"],
    steps: [
      { sql: "INSERT INTO t VALUES (1, 5) ON CONFLICT (id) DO UPDATE SET n = t.n + EXCLUDED.n" },
      { sql: "SELECT id, n FROM t", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "DML-conf-05",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int PRIMARY KEY, n int)", "INSERT INTO t VALUES (1, 100), (2, 5)"],
    steps: [
      {
        sql: "INSERT INTO t VALUES (1, 50), (2, 50) ON CONFLICT (id) DO UPDATE SET n = EXCLUDED.n WHERE t.n < EXCLUDED.n",
      },
      { sql: "SELECT id, n FROM t ORDER BY id", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "DML-conf-06",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int, v text, CONSTRAINT t_id_key UNIQUE (id))", "INSERT INTO t VALUES (1, 'old')"],
    steps: [
      { sql: "INSERT INTO t VALUES (1, 'new') ON CONFLICT ON CONSTRAINT t_id_key DO UPDATE SET v = EXCLUDED.v" },
      { sql: "SELECT id, v FROM t", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "DML-conf-07",
    kind: "sequence",
    setup: ["CREATE TABLE t (a int, b int, v text, UNIQUE (a, b))", "INSERT INTO t VALUES (1, 1, 'old')"],
    steps: [
      { sql: "INSERT INTO t VALUES (1, 1, 'new'), (1, 2, 'fresh') ON CONFLICT (a, b) DO UPDATE SET v = EXCLUDED.v" },
      { sql: "SELECT a, b, v FROM t ORDER BY a, b", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "DML-conf-08",
    kind: "sequence",
    setup: PK,
    steps: [
      {
        sql: "INSERT INTO t VALUES (1, 'new'), (2, 'ins') ON CONFLICT (id) DO UPDATE SET v = EXCLUDED.v RETURNING id, v",
        query: true,
      },
    ],
    compareFinalState: true,
  },
  {
    id: "DML-trunc-01",
    kind: "sequence",
    setup: KV_ROWS,
    steps: [{ sql: "TRUNCATE t" }, { sql: "SELECT count(*) AS n FROM t", query: true }],
    compareFinalState: true,
  },
  {
    id: "DML-trunc-02",
    kind: "sequence",
    setup: ["CREATE TABLE t (id serial, v text)", "INSERT INTO t (v) VALUES ('a'), ('b')"],
    steps: [
      { sql: "TRUNCATE t RESTART IDENTITY" },
      { sql: "INSERT INTO t (v) VALUES ('c')" },
      { sql: "SELECT id, v FROM t", query: true },
    ],
    compareFinalState: true,
  },
]);
