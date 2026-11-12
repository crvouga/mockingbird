// Issue #710: snapshots (autocommit statement rollback, BEGIN, SAVEPOINT, ROLLBACK, EXCEPTION blocks)
// must cost O(1) in the catalog's size, and DDL must still roll back exactly.
import { expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { CatalogMap, catalogCopyStats, DatabaseState } from "../../../src/storage/database-state.ts";
import { sequenceParity } from "../helpers.ts";

type IterKey = "entries" | "keys" | "values" | typeof Symbol.iterator;
type Method = (this: unknown, ...args: unknown[]) => unknown;

/** The snapshot machinery: what BEGIN, SAVEPOINT, ROLLBACK and a statement's implicit savepoint run. */
const SNAPSHOT_METHODS = ["holdForRollback", "releaseHold", "cloneShallow", "restoreFrom", "freezeShared"] as const;

interface CatalogWork {
  /** catalog-map entries iterated anywhere */
  visited: number;
  /** catalog-map entries iterated by the snapshot machinery */
  visitedBySnapshots: number;
  /** maps copied entry by entry */
  copied: number;
}

/** Count the catalog work `fn` does (an internal seam: no wall-clock assertions). */
function catalogWork(fn: () => void): CatalogWork {
  const work: CatalogWork = { visited: 0, visitedBySnapshots: 0, copied: 0 };
  let inSnapshot = 0;
  const restores: Array<() => void> = [];
  const patch = (target: object, key: PropertyKey, wrap: (original: Method) => Method): void => {
    const record = target as Record<PropertyKey, Method>;
    const original = record[key]!;
    record[key] = wrap(original);
    restores.push(() => {
      record[key] = original;
    });
  };
  const iterators: IterKey[] = ["entries", "keys", "values", Symbol.iterator];
  for (const key of iterators) {
    patch(
      CatalogMap.prototype,
      key,
      (original) =>
        function* (this: unknown) {
          const it = original.call(this) as Iterator<unknown>;
          for (let next = it.next(); !next.done; next = it.next()) {
            work.visited++;
            if (inSnapshot > 0) work.visitedBySnapshots++;
            yield next.value;
          }
        } as Method,
    );
  }
  for (const key of SNAPSHOT_METHODS) {
    patch(
      DatabaseState.prototype,
      key,
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          inSnapshot++;
          try {
            return original.apply(this, args);
          } finally {
            inSnapshot--;
          }
        },
    );
  }
  const copiedBefore = catalogCopyStats.mapsCopied;
  try {
    fn();
  } finally {
    for (const restore of restores) restore();
  }
  work.copied = catalogCopyStats.mapsCopied - copiedBefore;
  return work;
}

function catalogOfSize(objects: number): Database {
  const db = new Database();
  db.exec("CREATE SCHEMA app");
  db.exec("CREATE TYPE app.mood AS ENUM ('ok', 'sad')");
  db.exec("CREATE DOMAIN app.pos AS int CHECK (VALUE > 0)");
  for (let i = 0; i < objects; i++) {
    db.exec(
      `CREATE TABLE app.t${i} (id serial PRIMARY KEY, name text UNIQUE, a int, m app.mood DEFAULT 'ok'); ` +
        `CREATE INDEX t${i}_n ON app.t${i} (a); CREATE VIEW app.v${i} AS SELECT id FROM app.t${i}; ` +
        `CREATE SEQUENCE app.s${i}; CREATE FUNCTION app.f${i}() RETURNS int LANGUAGE sql AS 'select ${i}'`,
    );
  }
  // warm up: the per-table index lookup is built once per change to a schema's indexes
  db.exec("INSERT INTO app.t0 (name, a) VALUES ('warm', 0)");
  return db;
}

/** Inserts under every kind of snapshot: autocommit, BEGIN, SAVEPOINT, a failed statement, an EXCEPTION block. */
function insertWorkload(db: Database): void {
  const insert = db.prepare("INSERT INTO app.t0 (name, a) VALUES ($1, $2)");
  for (let i = 0; i < 20; i++) insert.run(`n${i}`, i);
  for (let i = 0; i < 5; i++) {
    db.exec("BEGIN");
    db.exec(`INSERT INTO app.t0 (name, a) VALUES ('b${i}', ${i})`);
    db.exec("COMMIT");
  }
  db.exec("BEGIN");
  db.exec("SAVEPOINT a");
  db.exec("INSERT INTO app.t0 (name, a) VALUES ('rolled back', 0)");
  db.exec("ROLLBACK TO a");
  db.exec("SAVEPOINT b");
  db.exec("ROLLBACK TO b");
  db.exec("RELEASE a");
  db.exec("ROLLBACK");
  // a failed autocommit statement restores its implicit savepoint
  expect(() => db.exec("INSERT INTO app.t0 (name, a) VALUES ('n2', 0), ('n1', 0)")).toThrow();
  db.exec(
    "DO $$ BEGIN BEGIN INSERT INTO app.t0 (name, a) VALUES ('x', 1); RAISE EXCEPTION 'boom'; " +
      "EXCEPTION WHEN others THEN NULL; END; END $$",
  );
}

function updateWorkload(db: Database): void {
  for (let i = 0; i < 5; i++) {
    db.exec("BEGIN");
    db.exec(`UPDATE app.t0 SET a = a + 1 WHERE id = ${i + 1}`);
    db.exec("COMMIT");
  }
  db.exec("UPDATE app.t0 SET a = 0 WHERE id = 1");
  db.exec("DELETE FROM app.t0 WHERE id = 2");
}

test("#710: snapshots copy no catalog map and visit no catalog entry, whatever the catalog's size", () => {
  const small = catalogOfSize(1);
  const large = catalogOfSize(120);
  const smallInserts = catalogWork(() => insertWorkload(small));
  const largeInserts = catalogWork(() => insertWorkload(large));
  const smallUpdates = catalogWork(() => updateWorkload(small));
  const largeUpdates = catalogWork(() => updateWorkload(large));
  for (const work of [smallInserts, largeInserts, smallUpdates, largeUpdates]) {
    expect(work.copied).toBe(0);
    expect(work.visitedBySnapshots).toBe(0);
  }
  // single-row inserts look nothing up by scanning the catalog either
  expect(largeInserts.visited).toBe(smallInserts.visited);
  // every hold is released once its transaction / statement / block ends
  expect(large.engineState.heldSnapshots()).toBe(0);
  expect(small.engineState.heldSnapshots()).toBe(0);
  expect(large.query("SELECT count(*)::int AS n FROM app.t0")).toEqual([{ n: 25 }]);
  small.close();
  large.close();
});

test("#710: exported snapshots and the forks opened from them stay isolated from catalog changes", () => {
  const db = catalogOfSize(3);
  db.exec("DELETE FROM app.t0; INSERT INTO app.t1 (name, a) VALUES ('kept', 1)");
  const snapshot = db.snapshot();
  db.exec("ALTER TABLE app.t1 ADD COLUMN extra int DEFAULT 5");
  db.exec("UPDATE app.t1 SET a = 2");
  db.exec("CREATE OR REPLACE FUNCTION app.f1() RETURNS int LANGUAGE sql AS 'select 100'");
  db.exec("ALTER SEQUENCE app.s1 RESTART WITH 50");
  db.exec("ALTER TYPE app.mood ADD VALUE 'glad'");
  db.exec("DROP VIEW app.v2; DROP TABLE app.t2");

  const left = snapshot.open();
  const right = snapshot.open();
  left.exec("ALTER TABLE app.t1 RENAME COLUMN a TO b; DROP FUNCTION app.f1()");
  right.exec("INSERT INTO app.t1 (name, a) VALUES ('right', 9)");
  for (const fork of [left, right]) {
    expect(fork.query("SELECT app.f0() AS v")).toEqual([{ v: 0 }]);
    expect(fork.query("SELECT nextval('app.s1')::int AS v")).toEqual([{ v: 1 }]);
    expect(fork.query("SELECT count(*)::int AS n FROM app.v2")).toEqual([{ n: 0 }]);
    expect(fork.query("SELECT enum_range(NULL::app.mood)::text AS r")).toEqual([{ r: "{ok,sad}" }]);
  }
  expect(left.query("SELECT name, b FROM app.t1")).toEqual([{ name: "kept", b: 1 }]);
  expect(() => left.query("SELECT app.f1()")).toThrow();
  expect(right.query("SELECT name, a FROM app.t1 ORDER BY id")).toEqual([
    { name: "kept", a: 1 },
    { name: "right", a: 9 },
  ]);
  expect(right.query("SELECT app.f1() AS v")).toEqual([{ v: 1 }]);
  const fresh = snapshot.open();
  expect(fresh.query("SELECT * FROM app.t1")).toEqual([{ id: 1, name: "kept", a: 1, m: "ok" }]);
  expect(db.query("SELECT a, extra FROM app.t1")).toEqual([{ a: 2, extra: 5 }]);
  expect(db.query("SELECT app.f1() AS v, nextval('app.s1')::int AS s")).toEqual([{ v: 100, s: 50 }]);
  for (const d of [db, left, right, fresh]) d.close();
});

const catalogSetup = [
  "CREATE TABLE t (id int PRIMARY KEY, v text)",
  "INSERT INTO t VALUES (1, 'a'), (2, 'b')",
  "CREATE TABLE other (id int)",
  "CREATE INDEX t_v ON t (v)",
  "CREATE SEQUENCE s",
  "CREATE TYPE mood AS ENUM ('ok', 'sad')",
  "CREATE DOMAIN pos AS int CHECK (VALUE > 0)",
  "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'select 1'",
  "CREATE VIEW tv AS SELECT id, v FROM t",
];

/** What the catalog looks like: relations, table columns, functions, types, constraints, indexes. */
const catalogShape = [
  "SELECT relname, relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE nspname = 'public' ORDER BY relname",
  "SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1, a.attnum",
  "SELECT p.proname, pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE nspname = 'public' ORDER BY 1, 2",
  "SELECT typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE nspname = 'public' AND typtype IN ('d', 'e') ORDER BY 1",
  "SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conrelid <> 0 ORDER BY 1",
  "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1",
  "SELECT sequencename, increment_by FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1",
].map((sql) => ({ sql, query: true }));

const withData = [
  ...catalogShape,
  { sql: "SELECT enum_range(NULL::mood)::text AS labels", query: true },
  { sql: "SELECT * FROM t ORDER BY id", query: true },
];

sequenceParity(
  "#710: every kind of DDL rolls back to a savepoint, repeatedly, then to BEGIN",
  catalogSetup,
  [
    { sql: "BEGIN" },
    { sql: "INSERT INTO t VALUES (3, 'c')" },
    { sql: "SAVEPOINT a" },
    { sql: "CREATE TABLE made (id int); INSERT INTO made VALUES (1)" },
    { sql: "ALTER TABLE t ADD COLUMN extra int DEFAULT 7" },
    { sql: "UPDATE t SET v = 'changed' WHERE id = 1" },
    { sql: "DROP INDEX t_v; CREATE INDEX t_id_v ON t (id, v)" },
    { sql: "ALTER SEQUENCE s INCREMENT BY 10" },
    { sql: "ALTER TYPE mood RENAME VALUE 'sad' TO 'blue'" },
    { sql: "CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql AS 'select 2'" },
    { sql: "CREATE FUNCTION g(int) RETURNS int LANGUAGE sql AS 'select $1'" },
    { sql: "DROP VIEW tv; DROP TABLE other" },
    { sql: "ROLLBACK TO a" },
    ...withData,
    { sql: "ALTER TABLE t RENAME TO renamed; DROP FUNCTION f(); DROP TYPE mood; DROP DOMAIN pos" },
    { sql: "SAVEPOINT b" },
    { sql: "CREATE TABLE inner_t (id int)" },
    { sql: "ROLLBACK TO a" },
    ...withData,
    { sql: "RELEASE a" },
    { sql: "ROLLBACK" },
    ...withData,
  ],
  { compareFinalState: true },
);

sequenceParity(
  "#710: DDL committed after earlier transactions and rollbacks persists, and later rollbacks restore it",
  catalogSetup,
  [
    { sql: "BEGIN; UPDATE t SET v = 'x' WHERE id = 1; COMMIT" },
    { sql: "BEGIN; DELETE FROM t; ROLLBACK" },
    { sql: "ALTER TABLE t ADD COLUMN extra int DEFAULT 7" },
    { sql: "INSERT INTO t VALUES (3, 'c', 8)" },
    { sql: "CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql AS 'select 3'" },
    { sql: "ALTER TYPE mood ADD VALUE 'glad'" },
    { sql: "BEGIN" },
    { sql: "ALTER TABLE t DROP COLUMN extra; UPDATE t SET v = 'y'" },
    { sql: "DROP FUNCTION f(); CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'select 4'" },
    { sql: "ROLLBACK" },
    ...withData,
    { sql: "BEGIN; ALTER TABLE t RENAME COLUMN extra TO renamed; INSERT INTO t VALUES (4, 'd'); COMMIT" },
    ...catalogShape,
    { sql: "SELECT * FROM t ORDER BY id", query: true },
  ],
  { compareFinalState: true },
);

sequenceParity(
  "#710: a failed autocommit statement rolls back its trigger's writes and leaves the catalog intact",
  [
    "CREATE TABLE t (id int PRIMARY KEY, v text)",
    "CREATE TABLE audit (id serial, note text)",
    `CREATE FUNCTION log_t() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN INSERT INTO audit (note) VALUES ('saw ' || NEW.id); RETURN NEW; END $$`,
    "CREATE TRIGGER t_log BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION log_t()",
    "INSERT INTO t VALUES (1, 'a')",
  ],
  [
    // the first row (and its trigger's write) are taken back with the statement
    { sql: "INSERT INTO t VALUES (2, 'b'), (1, 'dup')" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
    { sql: "SELECT note FROM audit ORDER BY note", query: true },
    { sql: "ALTER TABLE t ADD COLUMN extra int" },
    { sql: "INSERT INTO t VALUES (3, 'c', 1)" },
    { sql: "UPDATE t SET id = 1 WHERE id = 3" },
    { sql: "INSERT INTO t VALUES (4, 'x', 2), (3, 'y', 3)" },
    { sql: "DELETE FROM t WHERE id IN (1, 3) RETURNING 1/(id - 3) AS boom" },
    { sql: "SELECT * FROM t ORDER BY id", query: true },
    { sql: "SELECT note FROM audit ORDER BY note", query: true },
  ],
  // no final-state comparison: PostgreSQL never rolls back nextval (audit's serial), the engine does
);

sequenceParity(
  "#710: a PL/pgSQL EXCEPTION block rolls back the DDL and writes of its body",
  catalogSetup,
  [
    {
      sql: `DO $$
      BEGIN
        INSERT INTO t VALUES (10, 'kept');
        BEGIN
          CREATE TABLE inner_t (id int);
          ALTER TABLE t ADD COLUMN extra int;
          INSERT INTO t VALUES (11, 'lost', 1);
          DROP VIEW tv;
          CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql AS 'select 9';
          RAISE EXCEPTION 'boom';
        EXCEPTION WHEN others THEN
          INSERT INTO t VALUES (12, 'handler');
        END;
      END $$`,
    },
    ...withData,
    { sql: "SELECT f() AS v", query: true },
    { sql: "SELECT count(*) AS n FROM tv", query: true },
  ],
  { compareFinalState: true },
);
