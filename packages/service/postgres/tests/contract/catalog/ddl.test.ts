import { expect } from "bun:test";
import { DDL_SECTION } from "../../../compat/sections/ddl.ts";
import { runCatalog } from "./run.ts";

runCatalog(DDL_SECTION, [
  {
    id: "DDL-ct-01",
    kind: "parity",
    setup: [
      "CREATE TABLE all_types (i int, b bigint, t text, f float8, n numeric(10,2), d date, ts timestamp, bo boolean)",
      "INSERT INTO all_types VALUES (1, 2, 'x', 1.5, 12.34, '2024-06-01', '2024-06-01 12:30:00', true)",
    ],
    sql: "SELECT * FROM all_types",
  },
  {
    id: "DDL-ct-02",
    kind: "parity",
    setup: [
      "CREATE TABLE t (id int, v int DEFAULT 7, s text DEFAULT 'x' || 'y', c int DEFAULT 1 + 2)",
      "INSERT INTO t (id) VALUES (1)",
    ],
    sql: "SELECT id, v, s, c FROM t",
  },
  {
    id: "DDL-ct-03",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
    steps: [{ sql: "CREATE TABLE IF NOT EXISTS t (other text)" }, { sql: "SELECT id FROM t", query: true }],
    compareFinalState: true,
  },
  {
    id: "DDL-ct-04",
    kind: "error",
    setup: ["CREATE TABLE t (id int)"],
    sql: "CREATE TABLE t (id int)",
    messageTier: "A",
  },
  {
    id: "DDL-ct-05",
    kind: "parity",
    setup: ['CREATE TABLE "MixedCase" ("Id" int, "someValue" text)', "INSERT INTO \"MixedCase\" VALUES (1, 'v')"],
    sql: 'SELECT "Id", "someValue" FROM "MixedCase"',
  },
  {
    id: "DDL-ctas-01",
    kind: "parity",
    setup: [
      "CREATE TABLE src (id int, v text)",
      "INSERT INTO src VALUES (1, 'a'), (2, 'b'), (3, 'c')",
      "CREATE TABLE copy AS SELECT id, v FROM src WHERE id > 1",
    ],
    sql: "SELECT id, v FROM copy ORDER BY id",
  },
  {
    id: "DDL-ctas-02",
    kind: "sequence",
    setup: ["CREATE TABLE src (id int, v text)", "INSERT INTO src VALUES (1, 'a')"],
    steps: [
      { sql: "CREATE TABLE shape AS SELECT * FROM src WITH NO DATA" },
      { sql: "SELECT count(*) AS n FROM shape", query: true },
      { sql: "INSERT INTO shape SELECT * FROM src" },
      { sql: "SELECT id, v FROM shape", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "DDL-ctas-03",
    kind: "parity",
    setup: [
      "CREATE TABLE src (a int, b text)",
      "INSERT INTO src VALUES (1, 'x')",
      "CREATE TABLE renamed (col1, col2) AS SELECT a, b FROM src",
    ],
    sql: "SELECT col1, col2 FROM renamed",
  },
  {
    id: "DDL-drop-01",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int)"],
    steps: [
      { sql: "DROP TABLE t" },
      { sql: "DROP TABLE IF EXISTS t" },
      { sql: "SELECT count(*) AS n FROM pg_class WHERE relname = 't'", query: true },
    ],
    compareFinalState: true,
  },
  { id: "DDL-drop-02", kind: "error", sql: "DROP TABLE ghost", messageTier: "A" },
  {
    id: "DDL-drop-03",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (id int)");
      db.exec("CREATE VIEW v AS SELECT id FROM t");
      db.exec("DROP TABLE t CASCADE");
      // Oracle drops the dependent view too; memory keeps a broken view entry.
      expect(db.query("SELECT count(*)::int AS n FROM pg_class WHERE relname = 'v'")[0]).toEqual({ n: 1 });
      expect(() => db.query("SELECT * FROM v")).toThrow(/relation "t" does not exist/);
    },
  },
  {
    id: "DDL-alter-01",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1), (2)"],
    steps: [
      { sql: "ALTER TABLE t ADD COLUMN note text DEFAULT 'n/a'" },
      { sql: "SELECT id, note FROM t ORDER BY id", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "DDL-alter-02",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int, junk text, v int)", "INSERT INTO t VALUES (1, 'x', 10)"],
    steps: [{ sql: "ALTER TABLE t DROP COLUMN junk" }, { sql: "SELECT * FROM t", query: true }],
    compareFinalState: true,
  },
  {
    id: "DDL-alter-03",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
    steps: [{ sql: "ALTER TABLE t RENAME COLUMN id TO ident" }, { sql: "SELECT ident FROM t", query: true }],
    compareFinalState: true,
  },
  {
    id: "DDL-alter-04",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"],
    steps: [{ sql: "ALTER TABLE t RENAME TO t2" }, { sql: "SELECT id FROM t2", query: true }],
    compareFinalState: true,
  },
  {
    id: "DDL-view-01",
    kind: "parity",
    setup: [
      "CREATE TABLE t (id int, v text)",
      "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')",
      "CREATE VIEW big AS SELECT id, v FROM t WHERE id > 1",
    ],
    sql: "SELECT id, v FROM big ORDER BY id",
  },
  {
    id: "DDL-view-02",
    kind: "parity",
    setup: [
      "CREATE TABLE t (a int, b text)",
      "INSERT INTO t VALUES (1, 'x')",
      "CREATE VIEW v (num, label) AS SELECT a, b FROM t",
    ],
    sql: "SELECT num, label FROM v",
  },
  {
    id: "DDL-view-03",
    kind: "parity",
    setup: [
      "CREATE TABLE t (n int)",
      "INSERT INTO t VALUES (1), (2), (3), (4)",
      "CREATE VIEW evens AS SELECT n FROM t WHERE n % 2 = 0",
      "CREATE VIEW big_evens AS SELECT n FROM evens WHERE n > 2",
    ],
    sql: "SELECT n FROM big_evens ORDER BY n",
  },
  {
    id: "DDL-view-04",
    kind: "sequence",
    setup: [
      "CREATE TABLE t (id int)",
      "INSERT INTO t VALUES (1), (2), (3)",
      "CREATE VIEW v AS SELECT id FROM t WHERE id < 2",
    ],
    steps: [
      { sql: "SELECT id FROM v ORDER BY id", query: true },
      { sql: "CREATE OR REPLACE VIEW v AS SELECT id FROM t WHERE id >= 2" },
      { sql: "SELECT id FROM v ORDER BY id", query: true },
    ],
  },
  {
    id: "DDL-view-05",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int)", "CREATE VIEW v AS SELECT id FROM t"],
    steps: [
      { sql: "DROP VIEW v" },
      { sql: "DROP VIEW IF EXISTS v" },
      { sql: "SELECT count(*) AS n FROM pg_class WHERE relname = 'v'", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "DDL-idx-01",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int, v text)", "INSERT INTO t VALUES (2, 'b'), (1, 'a'), (3, 'c')"],
    steps: [
      { sql: "SELECT id, v FROM t WHERE id >= 2 ORDER BY id", query: true },
      { sql: "CREATE INDEX t_id_idx ON t (id)" },
      { sql: "SELECT id, v FROM t WHERE id >= 2 ORDER BY id", query: true },
    ],
  },
  {
    id: "DDL-idx-02",
    kind: "error",
    setup: ["CREATE TABLE t (id int)", "CREATE UNIQUE INDEX t_id_uq ON t (id)", "INSERT INTO t VALUES (1)"],
    sql: "INSERT INTO t VALUES (1)",
    messageTier: "A",
  },
  {
    id: "DDL-idx-03",
    kind: "error",
    setup: [
      "CREATE TABLE t (id int, active boolean)",
      "CREATE UNIQUE INDEX t_active_uq ON t (id) WHERE active",
      "INSERT INTO t VALUES (1, false), (1, false)",
      "INSERT INTO t VALUES (2, true)",
    ],
    sql: "INSERT INTO t VALUES (2, true)",
    messageTier: "A",
  },
  {
    id: "DDL-idx-04",
    kind: "error",
    setup: [
      "CREATE TABLE t (v text)",
      "CREATE UNIQUE INDEX t_lower_uq ON t (lower(v))",
      "INSERT INTO t VALUES ('Abc')",
    ],
    sql: "INSERT INTO t VALUES ('ABC')",
    messageTier: "A",
  },
  {
    id: "DDL-idx-05",
    kind: "sequence",
    setup: ["CREATE TABLE t (id int)", "CREATE UNIQUE INDEX t_id_uq ON t (id)", "INSERT INTO t VALUES (1)"],
    steps: [
      { sql: "DROP INDEX t_id_uq" },
      { sql: "INSERT INTO t VALUES (1)" },
      { sql: "SELECT count(*) AS n FROM t", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "DDL-schema-01",
    kind: "parity",
    setup: ["CREATE SCHEMA app", "CREATE TABLE app.t (id int, v text)", "INSERT INTO app.t VALUES (1, 'x')"],
    sql: "SELECT id, v FROM app.t",
  },
  {
    id: "DDL-schema-02",
    kind: "sequence",
    setup: ["CREATE SCHEMA app", "CREATE TABLE app.t (id int)", "INSERT INTO app.t VALUES (1)"],
    steps: [
      { sql: "DROP SCHEMA app CASCADE" },
      { sql: "SELECT count(*) AS n FROM pg_namespace WHERE nspname = 'app'", query: true },
    ],
    compareFinalState: true,
  },
  {
    id: "DDL-temp-01",
    kind: "sequence",
    setup: ["CREATE TEMP TABLE tmp_cat_ddl1 (id int, v text)"],
    steps: [
      { sql: "INSERT INTO tmp_cat_ddl1 VALUES (1, 'a'), (2, 'b')" },
      { sql: "SELECT id, v FROM tmp_cat_ddl1 ORDER BY id", query: true },
      { sql: "DROP TABLE tmp_cat_ddl1" },
    ],
    compareFinalState: true,
  },
  {
    id: "DDL-enum-01",
    kind: "parity",
    setup: [
      "CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy')",
      "CREATE TABLE t (id int, m mood)",
      "INSERT INTO t VALUES (1, 'happy'), (2, 'sad'), (3, 'ok')",
    ],
    sql: "SELECT id, m FROM t ORDER BY m, id",
  },
  {
    id: "DDL-enum-02",
    kind: "error",
    setup: ["CREATE TYPE mood AS ENUM ('sad', 'happy')", "CREATE TABLE t (m mood)"],
    sql: "INSERT INTO t VALUES ('angry')",
    messageTier: "B",
    notes: "memory qualifies the type name (enum public.mood) where the oracle says enum mood; same SQLSTATE 22P02",
  },
  {
    id: "DDL-domain-01",
    kind: "parity",
    setup: [
      "CREATE DOMAIN posint AS int CHECK (VALUE > 0)",
      "CREATE TABLE t (v posint)",
      "INSERT INTO t VALUES (5), (7)",
    ],
    sql: "SELECT v FROM t ORDER BY v",
  },
  {
    id: "DDL-domain-02",
    kind: "error",
    setup: ["CREATE DOMAIN posint AS int CHECK (VALUE > 0)", "CREATE TABLE t (v posint)"],
    sql: "INSERT INTO t VALUES (-5)",
    messageTier: "A",
  },
  {
    id: "DDL-gen-01",
    kind: "parity",
    setup: ["CREATE TABLE t (a int, b int GENERATED ALWAYS AS (a * 2) STORED)", "INSERT INTO t (a) VALUES (3), (5)"],
    sql: "SELECT a, b FROM t ORDER BY a",
  },
  {
    id: "DDL-gen-02",
    kind: "sequence",
    setup: ["CREATE TABLE t (a int, b int GENERATED ALWAYS AS (a * 2) STORED)", "INSERT INTO t (a) VALUES (3)"],
    steps: [{ sql: "UPDATE t SET a = 10" }, { sql: "SELECT a, b FROM t", query: true }],
    compareFinalState: true,
  },
  {
    id: "DDL-comment-01",
    kind: "divergence",
    fn: (db) => {
      db.exec("CREATE TABLE t (id int)");
      db.exec("COMMENT ON TABLE t IS 'catalog table'");
      // Oracle returns the stored comment; memory accepts the statement but stores nothing.
      const row = db.query<{ d: string | null }>("SELECT obj_description(oid) AS d FROM pg_class WHERE relname = 't'");
      expect(row[0]).toEqual({ d: null });
    },
  },
]);
