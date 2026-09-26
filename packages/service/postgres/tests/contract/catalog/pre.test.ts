import { PRE_SECTION } from "../../../compat/sections/pre.ts";
import { runCatalog } from "./run.ts";

runCatalog(PRE_SECTION, [
  {
    id: "PRE-prep-01",
    kind: "sequence",
    steps: [{ sql: "PREPARE p1 (int) AS SELECT $1 + 1 AS v" }, { sql: "EXECUTE p1(41)", query: true }],
  },
  {
    id: "PRE-prep-02",
    kind: "sequence",
    steps: [{ sql: "PREPARE p1 AS SELECT $1::int + $2::int AS v" }, { sql: "EXECUTE p1(1, 2)", query: true }],
  },
  {
    id: "PRE-prep-03",
    kind: "sequence",
    steps: [
      { sql: "PREPARE p1 (int, text) AS SELECT $1 AS n, $2 AS s" },
      { sql: "EXECUTE p1(7, 'hello')", query: true },
    ],
  },
  {
    id: "PRE-prep-04",
    kind: "sequence",
    steps: [{ sql: "PREPARE p1 (text) AS SELECT $1 || '!' AS v" }, { sql: "EXECUTE p1('hi')", query: true }],
  },
  {
    id: "PRE-exec-01",
    kind: "sequence",
    steps: [
      { sql: "PREPARE p1 (int) AS SELECT $1 * 2 AS v" },
      { sql: "EXECUTE p1(1)", query: true },
      { sql: "EXECUTE p1(2)", query: true },
      { sql: "EXECUTE p1(3)", query: true },
    ],
  },
  {
    id: "PRE-exec-02",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')"],
    steps: [
      { sql: "PREPARE p1 (int) AS SELECT id, v FROM t WHERE id > $1 ORDER BY id" },
      { sql: "EXECUTE p1(0)", query: true },
      { sql: "EXECUTE p1(1)", query: true },
      { sql: "EXECUTE p1(99)", query: true },
    ],
  },
  {
    id: "PRE-exec-03",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int)"],
    steps: [
      { sql: "PREPARE cnt AS SELECT count(*) AS n FROM t" },
      { sql: "EXECUTE cnt", query: true },
      { sql: "INSERT INTO t VALUES (1), (2)" },
      { sql: "EXECUTE cnt", query: true },
    ],
  },
  {
    id: "PRE-dml-01",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int, v text)"],
    steps: [
      { sql: "PREPARE ins (int, text) AS INSERT INTO t VALUES ($1, $2)" },
      { sql: "EXECUTE ins(1, 'a')" },
      { sql: "EXECUTE ins(2, 'b')" },
      { sql: "SELECT * FROM t ORDER BY id", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "PRE-dml-02",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (1, 'a'), (2, 'b')"],
    steps: [
      { sql: "PREPARE upd (text, int) AS UPDATE t SET v = $1 WHERE id = $2" },
      { sql: "EXECUTE upd('z', 1)" },
      { sql: "PREPARE del (int) AS DELETE FROM t WHERE id = $1" },
      { sql: "EXECUTE del(2)" },
      { sql: "SELECT * FROM t ORDER BY id", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "PRE-txn-01",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int)"],
    steps: [
      { sql: "PREPARE ins (int) AS INSERT INTO t VALUES ($1)" },
      { sql: "BEGIN" },
      { sql: "EXECUTE ins(1)" },
      { sql: "COMMIT" },
      { sql: "SELECT * FROM t", query: true },
    ],
  },
  {
    id: "PRE-txn-02",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int)"],
    steps: [
      { sql: "PREPARE ins (int) AS INSERT INTO t VALUES ($1)" },
      { sql: "BEGIN" },
      { sql: "EXECUTE ins(1)" },
      { sql: "ROLLBACK" },
      { sql: "SELECT count(*) AS n FROM t", query: true },
    ],
  },
  {
    id: "PRE-dealloc-01",
    kind: "sequence",
    steps: [
      { sql: "PREPARE p1 AS SELECT 1 AS v" },
      { sql: "EXECUTE p1", query: true },
      { sql: "DEALLOCATE p1" },
      { sql: "EXECUTE p1", query: true },
    ],
  },
  {
    id: "PRE-dealloc-02",
    kind: "sequence",
    steps: [
      { sql: "PREPARE p1 AS SELECT 1 AS v" },
      { sql: "EXECUTE p1", query: true },
      { sql: "DEALLOCATE p1" },
      { sql: "PREPARE p1 AS SELECT 2 AS v" },
      { sql: "EXECUTE p1", query: true },
    ],
  },
  {
    id: "PRE-dealloc-03",
    kind: "sequence",
    steps: [
      { sql: "PREPARE p1 AS SELECT 1 AS v" },
      { sql: "DEALLOCATE PREPARE p1" },
      { sql: "EXECUTE p1", query: true },
    ],
  },
  {
    id: "PRE-dealloc-04",
    kind: "sequence",
    steps: [
      { sql: "PREPARE p1 AS SELECT 1 AS v" },
      { sql: "PREPARE p2 AS SELECT 2 AS v" },
      { sql: "DEALLOCATE ALL" },
      { sql: "EXECUTE p1", query: true },
      { sql: "EXECUTE p2", query: true },
    ],
  },
  {
    id: "PRE-err-01",
    kind: "sequence",
    steps: [{ sql: "PREPARE p (int, int) AS SELECT $1 + $2" }, { sql: "EXECUTE p(1)", query: true }],
  },
  {
    id: "PRE-err-02",
    kind: "sequence",
    steps: [{ sql: "PREPARE p (int) AS SELECT $1" }, { sql: "EXECUTE p(1, 2)", query: true }],
  },
  {
    id: "PRE-err-03",
    kind: "sequence",
    steps: [{ sql: "PREPARE p AS SELECT 1" }, { sql: "PREPARE p AS SELECT 2" }],
  },
  { id: "PRE-err-04", kind: "sequence", steps: [{ sql: "EXECUTE no_such_prepared", query: true }] },
  { id: "PRE-err-05", kind: "sequence", steps: [{ sql: "DEALLOCATE no_such_prepared" }] },
  {
    id: "PRE-err-06",
    kind: "sequence",
    steps: [{ sql: "PREPARE p (int) AS SELECT $1 + 1" }, { sql: "EXECUTE p('abc')", query: true }],
  },
  {
    id: "PRE-drop-01",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
    steps: [
      { sql: "PREPARE p AS SELECT * FROM t" },
      { sql: "EXECUTE p", query: true },
      { sql: "DROP TABLE t" },
      { sql: "EXECUTE p", query: true },
    ],
  },
]);
